#!/usr/bin/env node
/**
 * 通话节点的入口。
 *
 * 三种跑法：
 *
 *   node src/index.mjs                     常驻，挂在 Uranus 上等它派活（正常用法）
 *   node src/index.mjs --pair <配对码>     配一下地址和密钥，配完就退出
 *   node src/index.mjs --dump              开个浏览器把 FaceTime 页面的元素打出来
 *
 * `--dump` 是排查用的：苹果改了页面结构、按钮点不到的时候，跑一次把实际的元素
 * 清单打出来，照着改 facetime.mjs 里那几条匹配规则。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UranusBrain } from "./brain.mjs";
import { Call } from "./call.mjs";
import { connectCdp, connectPage, sleep } from "./cdp.mjs";
import { launchBrowser } from "./chrome.mjs";
import { AVATAR_PATH, loadConfig, parsePairCode, saveConfig } from "./config.mjs";
import { buildFakeMediaShim } from "./fakemedia.mjs";
import { dumpControls, installMediaHook, joinCall } from "./facetime.mjs";
import { logError, logInfo, logWarn, setLogLevel } from "./logs.mjs";

const USAGE = `
通话节点 —— 让角色能接你从 iPhone 打来的 FaceTime。

  node src/index.mjs                   常驻，等 Uranus 派活
  node src/index.mjs --pair <配对码>   配地址和密钥（在 Uranus 控制台生成）
  node src/index.mjs --dump            排查用：把 FaceTime 页面的元素打出来

加 --debug 看详细日志。
`;

function parseArgs(argv) {
  const out = { mode: "serve", pair: "", name: "Uranus" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pair") {
      out.mode = "pair";
      out.pair = argv[++i] ?? "";
    } else if (a === "--dump") out.mode = "dump";
    else if (a === "--join") out.join = true;
    else if (a === "--name") out.name = argv[++i] ?? out.name;
    else if (a === "--debug") setLogLevel("debug");
    else if (a === "--help" || a === "-h") out.mode = "help";
  }
  return out;
}

/** 让用户把一行东西粘进来。链接和配对码都有 & # 这些字符，写在命令行上会被 shell 吃掉。 */
function ask(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      buf += chunk;
      const at = buf.indexOf("\n");
      if (at < 0) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(buf.slice(0, at).trim());
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

/* ── 常驻：挂在 Uranus 上等派活 ────────────────────────────── */

async function runServe() {
  const cfg = loadConfig();
  if (!cfg.secret) {
    process.stderr.write(
      "\n还没配对。去 Uranus 控制台的「通话」里生成一串配对码，然后：\n" +
        "  node src/index.mjs --pair <配对码>\n\n"
    );
    process.exit(1);
  }

  const brain = new UranusBrain({ base: cfg.uranus, secret: cfg.secret });
  logInfo("节点", `盯着 ${cfg.uranus}，等它派活`);

  /** 正在进行的那通电话。一次只接一通。 */
  let call = null;

  const listener = brain.listen(async (cmd) => {
    if (cmd.type === "join") {
      if (call) {
        logWarn("节点", "已经在通话中了，这通不接");
        await brain.report("error", { error: "节点已经在通话中" });
        return;
      }
      call = new Call({
        link: cmd.link,
        name: cmd.name ?? "Uranus",
        avatarPath: AVATAR_PATH,
        debugPort: cfg.debugPort,
        allowBargeIn: cmd.bargeIn !== false,
        silenceNoticeMs: Number(cmd.silenceNoticeMs ?? 45_000),
        brain,
      });

      try {
        const r = await call.run();
        logInfo("节点", `这通电话打完了：${r.reason}，${r.turns} 轮`);
      } catch (e) {
        logError("节点", "这通电话没打成", e);
        await brain.onError(e);
      } finally {
        call = null;
      }
      /*
       * 这里**不再**报一次 onEnded —— `Call` 收尾时（call.mjs 的 #cleanup）
       * 已经报过了，而且那条是在 finally 里，出错的路径上也会走到。
       * 报两次的话 Uranus 会对着一通已经结束的电话再收一次尾，往聊天记录里
       * 写两条「通话结束」。
       */
      return;
    }

    if (cmd.type === "hangup") {
      if (!call) return;
      logInfo("节点", `Uranus 让挂断：${cmd.reason ?? ""}`);
      call.hangUp(cmd.reason ?? "Uranus 叫停");
      return;
    }

    logDebugUnknown(cmd);
  });

  const bye = () => {
    logInfo("节点", "收工");
    listener.stop();
    call?.hangUp("节点退出");
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);

  // 挂着不退
  await new Promise(() => {});
}

function logDebugUnknown(cmd) {
  logWarn("节点", `收到一条看不懂的指令：${cmd?.type ?? "(没有 type)"}`);
}

/* ── 配对 ──────────────────────────────────────────────────── */

async function runPair(code) {
  const raw = code || (await ask("\n把配对码粘进来，然后回车：\n> "));
  const { uranus, secret } = parsePairCode(raw);
  const saved = saveConfig({ ...loadConfig(), uranus, secret });
  process.stdout.write(`\n配好了：${saved.uranus}\n现在可以跑：node src/index.mjs\n\n`);
}

/* ── 排查：把页面元素打出来 ────────────────────────────────── */

async function runDump({ join: doJoin, name }) {
  const link = await ask("\n把 FaceTime 链接粘进来，然后回车：\n> ");
  if (!/^https:\/\/facetime\.apple\.com\//i.test(link)) {
    logError("探测", "这不像一条 FaceTime 链接");
    process.exit(1);
  }
  if (!link.includes("#")) {
    logError("探测", "这条链接没有 # 后面那段 —— 入会的密钥在那儿，少了它进不去");
    process.exit(1);
  }

  const cfg = loadConfig();
  logInfo("探测", "起浏览器…");
  const browser = await launchBrowser({ url: "about:blank", port: cfg.debugPort });

  let cdp;
  try {
    await connectCdp(cfg.debugPort);
    cdp = await connectPage(cfg.debugPort);
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: buildFakeMediaShim({ avatarPath: AVATAR_PATH, label: name }),
    });
    await cdp.send("Page.navigate", { url: link });
    await sleep(5000);

    process.stdout.write(`\n${"=".repeat(60)}\n入会前\n${"=".repeat(60)}\n`);
    process.stdout.write(`${await dumpControls(cdp)}\n`);

    if (doJoin) {
      process.stdout.write(`\n${"=".repeat(60)}\n入会\n${"=".repeat(60)}\n`);
      try {
        await joinCall(cdp, name, {});
        process.stdout.write("\n入会成功。\n");
      } catch (e) {
        process.stdout.write(`\n入会没成：${e?.message ?? e}\n`);
      }
      await sleep(3000);
      process.stdout.write(`\n${"=".repeat(60)}\n入会后\n${"=".repeat(60)}\n`);
      process.stdout.write(`${await dumpControls(cdp)}\n`);
    }

    process.stdout.write("\n浏览器还开着，按 Ctrl-C 结束。\n");
    await new Promise((resolve) => process.on("SIGINT", resolve));
  } finally {
    cdp?.close();
    browser.kill();
  }
}

/* ── 入口 ──────────────────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));

const run =
  args.mode === "pair"
    ? () => runPair(args.pair)
    : args.mode === "dump"
      ? () => runDump(args)
      : args.mode === "help"
        ? async () => process.stdout.write(USAGE)
        : runServe;

run().catch((e) => {
  logError("节点", e?.message ?? String(e), e);
  process.exit(1);
});
