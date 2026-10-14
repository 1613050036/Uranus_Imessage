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
 *  - **拼进用户消息的样子**：画面、背景在最前，语气贴着那句话。
 *  - **摄像头**：画面只在变了时报、关掉报一次、从没开过不报；识图慢就留给下一轮；
 *    默认通话预设里那句「没看到画面别瞎编」在、上一版没改过的预设会自动换新。
 *  - **角色自己挂电话**：`[结束通话]` 认得出来，而**普通的话认不出来** ——
 *    v1.21.9 那条判断的反斜杠被吃掉成了字符类，于是带 s 的英文句子句句都判成挂断。
 *  - **语气标签**：TTS 认的时候留给它念，不认的照旧剥掉；指令标记哪一家都要剥。
 *  - **语言和口音**：跟着角色栏「发送语音」那两项，别短信里英音、电话里美音。
 *
 * 跑：node scripts/test-callhear.mjs
 */

import { transcribe } from "../server/src/stt.js";
import {
  AMBIENCE_EVERY_MS,
  ambiencePrompt,
  callUserMessage,
  callVoice as callVoiceOf,
  framePrompt,
  listenAmbience,
  nextAmbience,
  nextFrame,
  seeFrame,
  synthesizeSay,
  splitToneLine,
  takeAmbience,
  takeFrame,
  toneWord,
} from "../server/src/callturn.js";
import { DEFAULT_CALL_HOWTO } from "../server/src/preset.js";
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

/**
 * 掐掉 fetch，一律失败。
 *
 * 给那些「要走到 synthesizeVoice 但不关心合成结果」的用例：填了假密钥的配置
 * 会真的去打 ElevenLabs（回 401），离线自测不该出网。合成失败不影响要验的
 * 东西 —— `part.text` 就是送给 TTS 的那段。
 */
function deadFetch() {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("离线自测不出网");
  };
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
  const said = callUserMessage({ kind: "said", text: "你在干嘛", userName: "ming", tone: "开心" });
  check("语气贴着那句话", said.endsWith("[ming的语气：开心]你在干嘛"), true);

  const both = callUserMessage({
    kind: "said",
    text: "喂",
    userName: "ming",
    tone: "生气",
    ambience: "街上，有车流声",
  });
  check("背景在前、语气在后", /\[背景声音：街上，有车流声\]\[ming的语气：生气\]喂$/.test(both), true);

  const plain = callUserMessage({ kind: "said", text: "好", userName: "ming" });
  check("都没有就什么都不加", /\]好$/.test(plain) && !plain.includes("语气") && !plain.includes("背景"), true);

  const quiet = callUserMessage({ kind: "silence", seconds: 50, userName: "ming", ambience: "安静下来了" });
  check("没说话那轮也带背景", quiet.includes("[背景声音：安静下来了]"), true);
}

// ───────────────────────────────── 摄像头

group("画面什么时候报");
{
  let st = nextFrame("", "对方坐在沙发上，手里拿着一杯奶茶");
  check("第一张：报", st, { note: "对方坐在沙发上，手里拿着一杯奶茶", last: "对方坐在沙发上，手里拿着一杯奶茶" });
  st = nextFrame(st.last, "同上");
  check("差不多（同上）：不报", st.note, "");
  check("记着的还是那张", st.last, "对方坐在沙发上，手里拿着一杯奶茶");
  st = nextFrame(st.last, "看不清。");
  check("看不清：不报，也不把上一张冲掉", st, { note: "", last: "对方坐在沙发上，手里拿着一杯奶茶" });
  check("多行并成一行、去引号", nextFrame("", "「对方在厨房\n在切菜」").note, "对方在厨房在切菜");
  check("第一次不提上一张", framePrompt("").includes("上一张"), false);
  check("之后带上上一张让它比", framePrompt("在厨房").includes("「在厨房」"), true);
  check("叫它别猜是谁", framePrompt("").includes("不要猜画面里的人是谁"), true);
}

group("收画面、这一轮拿");
{
  const call = {};
  const describe = async () => "对方在街上走，背后是商场";
  const p = seeFrame({ call, frame: { jpeg: "QUJD" }, describe });
  check("收到一帧就去看", Boolean(p), true);
  check("正在看的时候不叠一个", seeFrame({ call, frame: { jpeg: "QUJD" }, describe }), null);

  // 识图还没回来，这一轮去拿：要等它（最多 waitMs）
  const got = await takeFrame(call, 1000);
  check("等到了，这一轮带上", got, { text: "对方在街上走，背后是商场" });
  check("拿了就清掉", await takeFrame(call, 10), null);

  // 慢的识图：等满就先不带，留到下一轮
  let release;
  const slow = () => new Promise((r) => (release = r));
  seeFrame({ call, frame: { jpeg: "QUJD" }, describe: slow });
  check("识图太慢：这一轮不带", await takeFrame(call, 30), null);
  await tick();
  release("对方进了地铁站");
  await tick();
  check("下一轮拿到", await takeFrame(call, 10), { text: "对方进了地铁站" });

  // 开过之后关掉：报一次
  seeFrame({ call, frame: { off: true } });
  check("关掉摄像头：报一次", await takeFrame(call, 10), { off: true });
  seeFrame({ call, frame: { off: true } });
  check("接着关着：不再报", await takeFrame(call, 10), null);

  // 从来没开过：什么都不报（预设里写了「没看到画面别瞎编」）
  const never = {};
  seeFrame({ call: never, frame: { off: true } });
  check("一开始就没开：不报", await takeFrame(never, 10), null);

  // 识图出错不能把 job 卡住
  const bad = {};
  await seeFrame({ call: bad, frame: { jpeg: "QUJD" }, describe: () => Promise.reject(new Error("挂了")) });
  check("识图出错：不卡住", bad.camera.job, null);

  // 没配识图模型
  const bare = {};
  check("没配识图模型：不看", seeFrame({ config: {}, role: {}, call: bare, frame: { jpeg: "QUJD" } }), null);
  check("提示只记一次", bare.camera.warned, true);
  check("空帧不看", seeFrame({ call: {}, frame: { jpeg: "" }, describe }), null);
}

group("画面拼进用户消息");
{
  const m = callUserMessage({
    kind: "said",
    text: "你看这个",
    userName: "ming",
    camera: { text: "对方举着一只猫对着镜头" },
  });
  check("画面在前、原话在后", /\[ming的摄像头画面：对方举着一只猫对着镜头\]你看这个$/.test(m), true);
  const off = callUserMessage({ kind: "said", text: "好", userName: "ming", camera: { off: true } });
  check("关掉摄像头那句", off.includes("[ming关掉了摄像头]"), true);
  const all = callUserMessage({
    kind: "said",
    text: "喂",
    userName: "ming",
    tone: "开心",
    ambience: "街上",
    camera: { text: "对方在笑" },
  });
  check("三样都有：画面、背景、语气、原话", /\[ming的摄像头画面：对方在笑\]\[背景声音：街上\]\[ming的语气：开心\]喂$/.test(all), true);
}

group("默认通话预设里那句");
{
  check("写了没看到画面别瞎编", DEFAULT_CALL_HOWTO.includes("不要瞎编"), true);
  check("写了当作语音通话", DEFAULT_CALL_HOWTO.includes("直接当作语音通话即可"), true);
  // 和 callUserMessage 拼出来的标记一致，不然模型对不上号
  check("预设里的标记写法和实际一致", DEFAULT_CALL_HOWTO.includes("[{{user}}的摄像头画面："), true);

  // 语气标签那一节：ElevenLabs v3 起认方括号标签，得告诉模型可以写
  check("写了语气标签怎么用", DEFAULT_CALL_HOWTO.includes("[sighs]"), true);
  check("说明标签不会被念出来", DEFAULT_CALL_HOWTO.includes("不会被念出来"), true);

  // 以前哪一版没改过的正文都要自动换成新的；改过的不动
  const v1202 = DEFAULT_CALL_HOWTO.split("\n\n### 摄像头")[0];
  const v1219 = DEFAULT_CALL_HOWTO.split("\n\n### 语气")[0];
  const howtoOf = (content) =>
    normalizeConfig({
      presets: [{ id: "p", name: "通话", mode: "call", entries: [{ kind: "callHowto", content }] }],
    }).presets.find((p) => p.id === "p")?.entries.find((e) => e.kind === "callHowto")?.content;
  check("v1.20.2 没改过：换成新的", howtoOf(v1202), DEFAULT_CALL_HOWTO);
  check("v1.21.9 没改过：换成带语气的", howtoOf(v1219), DEFAULT_CALL_HOWTO);
  check("用户改过的：原样留着", howtoOf(v1202 + "\n我自己加的"), v1202 + "\n我自己加的");
}

// ───────────────────────────────── 角色自己挂电话

group("[结束通话] 在剥标记之前就认出来");
{
  // 没配 TTS：合成回 null，不影响判挂断
  const cfg = { ttsApi: {}, chat: { separator: "$" } };
  const say = (text) => synthesizeSay({ config: cfg, role: {}, text });

  let parts = await say("好，那我先挂了，晚点聊。[结束通话]");
  check("挂断标记跟在话后面：认出来", parts.some((p) => p.hangUp), true);
  check("念的文字里没有那个标记", parts.map((p) => p.text).join("").includes("结束通话"), false);

  parts = await say("拜拜。\n\n[结束通话]");
  check("单独一句只有标记：也要认出来（以前整句被丢掉）", parts.some((p) => p.hangUp), true);

  parts = await say("再聊会儿嘛");
  check("没写就不挂", parts.some((p) => p.hangUp), false);

  /*
   * v1.21.9 的回归：那条判断在 callturn.js 里被抄成了 `/[s*结束通话s*]/` ——
   * 反斜杠全丢了，于是它是个**字符类**，匹配 s、星号、以及「结束通话」里任意
   * 一个字。英文回复几乎句句带 s，表现是角色说完第一句就莫名挂断。
   */
  parts = await say("Signal in here is terrible tonight.");
  check("英文里的 s 不该被当成挂断", parts.some((p) => p.hangUp), false);

  parts = await say("这事说来话长，改天再说");
  check("「说」「话」这些字不该被当成挂断", parts.some((p) => p.hangUp), false);

  parts = await say("要不我们通个话?");
  check("「通话」两个字也不算", parts.some((p) => p.hangUp), false);
}

group("语气标签：TTS 认的时候留给它念");
{
  // 这一组会走到 synthesizeVoice —— 掐掉 fetch，别真打 ElevenLabs
  const restore = deadFetch();
  const chat = { separator: "$" };
  // ElevenLabs 的 v3 及以后认方括号标签（media.js:elevenTagsOk）
  const v3 = { ttsApi: { elevenlabs: { enabled: true, key: "k", model: "eleven_v3" } }, chat };
  const v2 = {
    ttsApi: { elevenlabs: { enabled: true, key: "k", model: "eleven_multilingual_v2" } },
    chat,
  };
  const textOf = (parts) => parts.map((p) => p.text).join("");

  // 没有网络，合成一定失败 —— 但 part.text 就是送给 TTS 的那段，够判了
  let parts = await synthesizeSay({ config: v3, role: {}, text: "[sighs] 算了，不说这个了。" });
  check("v3：标签留着", textOf(parts).includes("[sighs]"), true);

  parts = await synthesizeSay({ config: v2, role: {}, text: "[sighs] 算了，不说这个了。" });
  check("v2 不认：照旧剥掉", textOf(parts).includes("sighs"), false);
  check("v2：正文还在", textOf(parts).includes("算了"), true);

  // 指令标记在哪一家都不能留
  parts = await synthesizeSay({ config: v3, role: {}, text: "我看看[查岗实时电脑屏幕]等下" });
  check("中文指令标记照旧剥掉", textOf(parts).includes("查岗"), false);

  parts = await synthesizeSay({ config: v3, role: {}, text: "好啊[leave_on_read]" });
  check("带下划线的不算语气标签", textOf(parts).includes("leave_on_read"), false);

  /*
   * 整句只剩一个标签：留着送进 ElevenLabs 会直接 400
   * （「Input at position 0 has empty text」），所以当没字可念。
   */
  parts = await synthesizeSay({ config: v3, role: {}, text: "[chuckles]" });
  check("整句只有标签：不去合成", parts.length, 0);
  restore();
}

group("通话跟着「发送语音」那套语言和口音");
{
  /*
   * 角色栏里填了 en-GB + strong British accent，短信里的语音条是英音、
   * 电话里却是美音 —— 通话这条路压根没把这两项传给 synthesizeVoice。
   * 没有网络没法验到上游，这里验的是「配置真的取到了」。
   */
  const role = {
    voiceSend: { voiceId: "v1", language: "en-GB", accent: "strong British accent" },
  };
  const got = callVoiceOf({ ttsApi: { elevenlabs: { enabled: true, key: "k", model: "eleven_v3" } } }, role);
  check("音色、语言、口音都取到了", [got.voiceId, got.language, got.accent], [
    "v1",
    "en-GB",
    "strong British accent",
  ]);
  check("v3 认标签：keepTone 开", got.keepTone, true);

  const v2 = callVoiceOf(
    { ttsApi: { elevenlabs: { enabled: true, key: "k", model: "eleven_turbo_v2_5" } } },
    role
  );
  check("v2 不认：keepTone 关", v2.keepTone, false);

  // 一家都没配：keepTone 关，不该抛
  check("没配 TTS 也不炸", callVoiceOf({ ttsApi: {} }, role).keepTone, false);
}

// ───────────────────────────────── 配置

group("开关默认值");
{
  const cfg = normalizeConfig({ roles: [{ id: "r1", name: "A", call: { enabled: true } }] });
  const c = cfg.roles[0].call;
  check("听语气默认开", c.hearTone, true);
  check("听背景默认开", c.hearAmbience, true);
  check("看摄像头默认开", c.seeCamera, true);

  const off = normalizeConfig({
    roles: [{ id: "r1", name: "A", call: { hearTone: false, hearAmbience: false } }],
  }).roles[0].call;
  check("关了就是关", [off.hearTone, off.hearAmbience], [false, false]);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
