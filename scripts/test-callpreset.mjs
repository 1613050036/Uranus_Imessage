/**
 * 老用户补发「通话默认预设」（datadir.js:topUpCallPreset）。
 *
 * 跑法：node scripts/test-callpreset.mjs（或者 npm test 一起跑）
 *
 * 种子只在 data/presets/ 第一次被建出来时拷，而通话是后来才加的 —— 所以在那
 * 之前装好的机器，预设列表里永远没有通话预设（用户实测：「我还是没有看到默认
 * 的通话预设」）。这里钉住几件事：老用户补得进来、存一次盘不会被清扫删掉、
 * 用户删掉之后不再补回来、新装的不会补出第二份。
 *
 * 用一个临时 data 目录，不碰真的 data/。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "uranus-topup-"));
const presets = join(root, "presets");

// 模拟一台「通话功能加进来之前」就装好的机器：只有线上 + 一份用户自己的线下
mkdirSync(presets, { recursive: true });
writeFileSync(
  join(presets, "01-线上默认预设.json"),
  JSON.stringify({ id: "ps-1", name: "线上默认预设", mode: "online" })
);
writeFileSync(
  join(presets, "02-我自己的.json"),
  JSON.stringify({ id: "ps-2", name: "我自己的", mode: "offline" })
);
// datadir.js 在 import 时就读这个环境变量，所以必须在 import 之前设
process.env.URANUS_DATA_DIR = root;

const { loadConfig, saveConfig, clearConfigCache } = await import("../server/src/config.js");

let pass = 0;
let fail = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${what}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${what}\n      得到：${JSON.stringify(got)}\n      期望：${JSON.stringify(want)}`);
  }
}

const callNames = (c) => c.presets.filter((p) => p.mode === "call").map((p) => p.name);

console.log("\n老用户：补一份进来");
{
  const c = loadConfig();
  check("补进了一份通话预设", callNames(c), ["通话默认预设"]);
  check("排在最后（不打乱用户排好的顺序）", c.presets.at(-1).name, "通话默认预设");
  check(
    "原来那两份没动",
    c.presets.slice(0, 2).map((p) => p.name),
    ["线上默认预设", "我自己的"]
  );
  const howto = c.presets.at(-1).entries.find((e) => e.kind === "callHowto");
  check("「怎么打电话」开着", howto?.enabled, true);
  // 用户要能改的就是这段 —— 里面包括让角色自己挂电话的那条
  check("正文里有挂电话那段", /\[结束通话\]/.test(howto?.content ?? ""), true);
}

console.log("\n存一次盘：不能被清扫删掉");
{
  /*
   * writeCollection 会删掉「这次没写过的 .json」。补发要是挂在写盘那条路上，
   * 补进来的文件会被当场删掉、而标记已经写了 —— 就再也补不回来了。
   */
  saveConfig(loadConfig());
  clearConfigCache();
  check("存完再读还在", callNames(loadConfig()), ["通话默认预设"]);
}

console.log("\n用户删掉了：不再补回来");
{
  const c = loadConfig();
  saveConfig({ ...c, presets: c.presets.filter((p) => p.mode !== "call") });
  clearConfigCache();
  check("删掉之后重新读，没有补回来", callNames(loadConfig()), []);
}

console.log("\n新装的机器：种子已经有了，不补第二份");
{
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  clearConfigCache();
  const c = loadConfig();
  check("只有一份通话预设", callNames(c), ["通话默认预设"]);
  check("线上 / 线下 / 通话三份都在", c.presets.map((p) => p.mode), ["online", "offline", "call"]);
}

rmSync(root, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
