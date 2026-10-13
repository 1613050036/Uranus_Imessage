/**
 * 离线自测：通话里听语气、听背景声音（callturn.js + stt.js）。
 *
 * 重点测什么：
 *
 *  - **Qwen 的情绪标签读出来了**：它在 `message.annotations` 里，以前一直被扔掉。
 *    平静的不报 —— 每句都标「平静」只是噪音。
 *  - **多模态那条路的「语气：xx」只认最后一行**：前面出现「语气」两个字是对方
 *    真说的话，拆错了会把原话吃掉一截。
 *  - **背景只在变了的时候报**：一开始就安静的不报；吵了报；接着还是吵（「同上」）
 *    不报；安静下来报一次。不然角色会每 30 秒念叨一遍「你那边好吵」。
 *  - **节流**：30 秒一次、正在听的时候不再起一个；结果晚一轮拿、拿了就清。
 *  - **拼进用户消息的样子**：背景在最前、语气贴着那句话。
 *
 * 跑：node scripts/test-callhear.mjs
 */

import { transcribe } from "../server/src/stt.js";
import {
  AMBIENCE_EVERY_MS,
  ambiencePrompt,
  callUserMessage,
  listenAmbience,
  nextAmbience,
  splitToneLine,
  takeAmbience,
  toneWord,
} from "../server/src/callturn.js";
import { normalizeConfig } from "../server/src/config.js";

let pass = 0;
let fail = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${what}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${what}\n      得到：${JSON.stringify(got)}\n      应该：${JSON.stringify(want)}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

/** 换掉全局 fetch，回一个固定的 JSON。 */
function fakeFetch(body) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  });
  return () => {
    globalThis.fetch = orig;
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const QWEN = { qwen: { enabled: true, key: "k" } };

// ───────────────────────────────── Qwen 的情绪

group("Qwen 顺带回的情绪");
{
  let restore = fakeFetch({
    choices: [
      {
        message: {
          content: "哈哈你猜我在哪",
          annotations: [{ type: "audio_info", language: "zh", emotion: "happy" }],
        },
      },
    ],
  });
  let r = await transcribe(QWEN, Buffer.from("x"));
  restore();
  check("文字照旧", r.text, "哈哈你猜我在哪");
  check("情绪读出来了", r.emotion, "happy");

  restore = fakeFetch({ choices: [{ message: { content: "好的" } }] });
  r = await transcribe(QWEN, Buffer.from("x"));
  restore();
  // 中转站多半会把 annotations 剥掉 —— 当没听出来，不是错
  check("没有 annotations：情绪是空串，文字照旧", [r.text, r.emotion], ["好的", ""]);

  restore = fakeFetch({
    choices: [{ message: { content: [{ text: "嗯" }], annotations: [{ emotion: "NEUTRAL" }] } }],
  });
  r = await transcribe(QWEN, Buffer.from("x"));
  restore();
  check("content 是数组也行，大小写统一成小写", [r.text, r.emotion], ["嗯", "neutral"]);
}

group("情绪标签 → 给角色看的词");
{
  check("happy → 开心", toneWord("happy"), "开心");
  check("angry → 生气", toneWord("angry"), "生气");
  check("大写也认", toneWord("SAD"), "难过");
  // 绝大多数话都是平静的，每句标一个只是噪音
  check("neutral 不报", toneWord("neutral"), "");
  check("没有 / 不认识的不报", [toneWord(""), toneWord(undefined), toneWord("bored")], ["", "", ""]);
}

// ───────────────────────────────── 多模态那条路

group("多模态的「语气：xx」那一行");
{
  check(
    "最后一行是语气：拆出来",
    splitToneLine("我今天被老板骂了\n语气：低落"),
    { text: "我今天被老板骂了", tone: "低落" }
  );
  check("带括号也认", splitToneLine("哈哈哈\n（语气：在笑）"), { text: "哈哈哈", tone: "在笑" });
  check("没写那一行：原样", splitToneLine("好的我知道了"), { text: "好的我知道了", tone: "" });
  // 前面出现「语气」是对方真说的话，不能拆
  check(
    "「语气」出现在前面不算",
    splitToneLine("你这什么语气：我又没惹你\n算了"),
    { text: "你这什么语气：我又没惹你\n算了", tone: "" }
  );
  // 只有一行的话那一行就是原话（对方说的就是这几个字），不能吃掉
  check("只有一行不拆", splitToneLine("语气：开心"), { text: "语气：开心", tone: "" });
  check("空的不炸", splitToneLine(undefined), { text: "", tone: "" });
}

// ───────────────────────────────── 背景什么时候报

group("背景只在变了的时候报");
{
  let st = nextAmbience("", "安静");
  check("一开始就安静：不报", st, { note: "", last: "安静" });

  st = nextAmbience(st.last, "街上，有车流声");
  check("到了街上：报", st, { note: "街上，有车流声", last: "街上，有车流声" });

  st = nextAmbience(st.last, "同上");
  check("还在街上（同上）：不报，记着的不变", st, { note: "", last: "街上，有车流声" });

  st = nextAmbience(st.last, "同上。");
  check("「同上。」带句号也认", st.note, "");

  st = nextAmbience(st.last, "安静");
  check("安静下来了：报一次", st, { note: "安静下来了", last: "安静" });

  st = nextAmbience(st.last, "安静。");
  check("接着安静：不报", st.note, "");

  check("空回复：不报", nextAmbience("街上", "").note, "");
  check(
    "去掉引号、只要第一行、截 30 字",
    nextAmbience("", "「车里，在放音乐」\n多余的解释").note,
    "车里，在放音乐"
  );
}

group("听背景的提示词");
{
  check("第一次不提上次", ambiencePrompt("").includes("上次听到"), false);
  check("之后带上上次的，让它和那次比", ambiencePrompt("街上，有车声").includes("「街上，有车声」"), true);
  check("和上次差不多就回「同上」", ambiencePrompt("街上").includes("同上"), true);
}

// ───────────────────────────────── 节流 + 晚一轮拿

group("节流、晚一轮拿");
{
  const call = {};
  const wav = Buffer.from("x");
  let asked = 0;
  let resolveLater;
  const listen = () => {
    asked += 1;
    return new Promise((r) => (resolveLater = r));
  };

  const t0 = 1_000_000;
  const p = listenAmbience({ call, wav, now: t0, listen });
  check("第一段话就听", Boolean(p), true);
  check("正在听的时候不再起一个", listenAmbience({ call, wav, now: t0 + 40_000, listen }), null);

  // 模型那一下是在后台起的（下一个微任务才真的问），等它问出去再回
  await tick();
  resolveLater("饭馆里，很多人说话");
  await p;
  check("听完了：攒着等下一轮", call.ambience.pending, "饭馆里，很多人说话");

  check("30 秒内不再听", listenAmbience({ call, wav, now: t0 + 10_000, listen }), null);
  check("一共只问了一次", asked, 1);

  check("下一轮拿出来", takeAmbience(call), "饭馆里，很多人说话");
  check("拿了就清掉，同一句不说两遍", takeAmbience(call), "");

  const p2 = listenAmbience({ call, wav, now: t0 + AMBIENCE_EVERY_MS + 1, listen });
  check("过了 30 秒再听", Boolean(p2), true);
  await tick();
  resolveLater("同上");
  await p2;
  check("没变就没东西拿", takeAmbience(call), "");

  // 出错不能把 busy 卡住，不然这通电话再也不听了
  const p3 = listenAmbience({
    call,
    wav,
    now: t0 + AMBIENCE_EVERY_MS * 2 + 2,
    listen: () => Promise.reject(new Error("模型挂了")),
  });
  await p3;
  check("出错了：不卡住", call.ambience.busy, false);

  check("没电话不听", listenAmbience({ call: null, wav, listen }), null);
  check("没音频不听", listenAmbience({ call: {}, wav: Buffer.alloc(0), listen }), null);

  // 没配「听音」模型：不听，提示只打一次
  const bare = {};
  check("没配听音模型：不听", listenAmbience({ config: {}, role: {}, call: bare, wav }), null);
  check("记了一次提示", bare.ambience.warned, true);
}

// ───────────────────────────────── 拼进用户消息

group("拼进这一轮的用户消息");
{
  const said = callUserMessage({ kind: "said", text: "你在干嘛", userName: "niki", tone: "开心" });
  check("语气贴着那句话", said.endsWith("[niki的语气：开心]你在干嘛"), true);

  const both = callUserMessage({
    kind: "said",
    text: "喂",
    userName: "niki",
    tone: "生气",
    ambience: "街上，有车流声",
  });
  check("背景在前、语气在后", /\[背景声音：街上，有车流声\]\[niki的语气：生气\]喂$/.test(both), true);

  const plain = callUserMessage({ kind: "said", text: "好", userName: "niki" });
  check("都没有就什么都不加", /\]好$/.test(plain) && !plain.includes("语气") && !plain.includes("背景"), true);

  const quiet = callUserMessage({ kind: "silence", seconds: 50, userName: "niki", ambience: "安静下来了" });
  check("没说话那轮也带背景", quiet.includes("[背景声音：安静下来了]"), true);
}

// ───────────────────────────────── 配置

group("开关默认值");
{
  const cfg = normalizeConfig({ roles: [{ id: "r1", name: "A", call: { enabled: true } }] });
  const c = cfg.roles[0].call;
  check("听语气默认开", c.hearTone, true);
  check("听背景默认开", c.hearAmbience, true);

  const off = normalizeConfig({
    roles: [{ id: "r1", name: "A", call: { hearTone: false, hearAmbience: false } }],
  }).roles[0].call;
  check("关了就是关", [off.hearTone, off.hearAmbience], [false, false]);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
