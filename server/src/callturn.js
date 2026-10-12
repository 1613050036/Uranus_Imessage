/**
 * 通话里的一轮：对方说了一句 → 转写 → 打模型 → 一句一句合成送回去。
 *
 * ── 为什么另开一条路，不走 handleTurn ──
 *
 * `imessage.js:handleTurn` 有 700 多行，一多半是**只在发短信时才成立**的事：
 * 拆气泡、已读不回、撤回、表情包、Instagram、投递检测、打字指示器。通话里这些
 * 要么没有意义（说出口的话收不回来），要么会把整轮吞掉（已读不回 —— 实测它
 * 真的把入会指令吃掉过一次）。
 *
 * 所以这里是一条**轻链路**，和线下模式（`offline.js:runOfflineTurn`）一个待遇：
 * 自己拼提示词、自己打模型，但**存档和记忆走的是和发短信完全一样的那两个函数**
 * （`appendTurn` / `recordTurn`）。上下文也是同一条历史 —— 这是用户钉死的：
 * 一接通就知道之前聊了什么，挂断之后在 iMessage 里能接着聊刚才通话的内容。
 *
 * ── 怎么把延迟压下来 ──
 *
 * 一轮下来的账：FaceTime 自身 1～2 秒（实测，走代理更久）+ 转写 + 模型 + 合成
 * + 传回去 1～2 秒。老实等的话五到八秒，没法聊天。
 *
 * 两刀下去：
 *
 *  1. **模型流式输出**。`llm.js` 本来就支持（传 `onDelta`），只是发短信那条路
 *     用不上 —— 半截文本没法按 `$` 切气泡（`config.js:441` 的注释）。通话正好
 *     相反：**第一个句子一凑齐就能开始合成播放**，不用等整段写完。
 *  2. **一句一句合成**。`media.js` 那四家 TTS 全是整段合成（`media.js:1496`
 *     写死 `stream: false`），但我们可以自己按句切。第一句刻意切短，它决定
 *     对方多久能听到声音；后面的句子在它播的时候已经在合成了。
 *
 * 压完预期 3～5 秒，当成「信号不太好的电话」能接受。
 */

import {
  callPrefix,
  interruptedNotice,
  silenceNotice,
  speakableFrom,
  splitSentences,
  stripCallTags,
  typedPrefix,
} from "./calltags.js";
import { elapsedMs, recordCallTurn, sayDuration } from "./callsession.js";
import { resolveEndpoint, resolveRoleEndpoints } from "./config.js";
import { chatWithFallback, transcribeAudio } from "./llm.js";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { splitMedia, synthesizeVoice } from "./media.js";
import { transcribe as sttTranscribe } from "./stt.js";

const SCOPE = "通话";

/**
 * 这个模型引用填全了吗。
 *
 * 和 `offline.js:150` 同一个判据（那边是私有函数）。两行代码，不值得为了
 * 复用去改线下模式那个文件 —— 但改判据的时候两处要一起改。
 */
function refUsable(ref) {
  return Boolean(ref?.provider && ref?.modelId);
}

/**
 * 通话这一轮用哪个模型。
 *
 * 和线下模式同一个路子（`offline.js:offlineEndpoint`）：角色上单独选一个，
 * 没选就用主聊天模型。**选了但引用失效时退回主模型并记一条 warn** —— 静默
 * 换模型不好，但让一通电话打不通更糟。
 *
 * 为什么值得单独配：通话对延迟敏感得多，带 thinking 的模型在电话里是灾难
 * （实测那条日志里主模型想了 7.3 秒）。
 */
export function callEndpoint(config, role) {
  const eps = resolveRoleEndpoints(config, role);
  const ref = role?.call?.model;
  if (refUsable(ref)) {
    const own = resolveEndpoint(config, ref);
    if (own) return { endpoint: own, fallback: eps.fallback };
    logWarn(SCOPE, "通话单独选的模型引用失效了（服务商或模型被删/被关），这轮用角色的聊天模型");
  }
  return { endpoint: eps.chat, fallback: eps.fallback };
}

/**
 * 把对方说的那段话转成文字。
 *
 * 复用角色的「听音」配置（`role.audioModel`）—— 和 iMessage 里的语音条走的是
 * 同一个模型、同一个提示词，没必要为通话另配一套。
 *
 * @param {object} config
 * @param {object} role
 * @param {Buffer} wav 16kHz 单声道 WAV（节点那边包好的）
 * @returns {Promise<string>} 转写出来的文字；听不出来返回空串
 */
export async function transcribe(config, role, wav) {
  /*
   * ── 优先走专门的 STT ──
   *
   * 配了的话用它：1 秒内返回、只给原话、便宜一个数量级。多模态那条路
   * （下面那段）慢好几秒，而且会"理解"而不是"转写" —— 实测把一句「Hi」
   * 扩写成了六段式报告。通话最受不了这两样。
   */
  const stt = await sttTranscribe(config.sttApi, wav, {
    mimeType: "audio/wav",
    scope: SCOPE,
  }).catch((e) => {
    // 转写服务挂了就退回多模态，别让一通电话哑掉
    logWarn(SCOPE, "专门的转写服务没转出来，退回多模态模型", e);
    return null;
  });
  if (stt) return stt.text;

  const eps = resolveRoleEndpoints(config, role);
  if (!eps.audio) {
    logWarn(
      SCOPE,
      "没配转写服务，这个角色也没开「听音」—— 通话里对方说的话没法转成文字。" +
        "去「连接」面板配一个转写服务（OpenAI 兼容 / Qwen / 讯飞都行）"
    );
    return "";
  }

  const audio = {
    base64: wav.toString("base64"),
    mimeType: "audio/wav",
    name: "call.wav",
  };

  try {
    /*
     * ── 通话里**不用**角色那份「听音」提示词 ──
     *
     * 角色开了「结构化」模式（`role.audioModel.emotion`）的话，那份提示词会
     * 要求模型输出六段式的分析报告：
     *
     *   1) 原话转写：Hi
     *   2) 语言：英语
     *   3) 语气/情绪：轻松友好，伴随着轻笑
     *   …
     *
     * 那是给语音条用的 —— 对方发一条语音过来，角色「听」出情绪和环境是加分项。
     * 但**通话里这整段会原样进上下文**，模型看到的不是「对方说了 Hi」而是一份
     * 报告，于是它开始对着报告说话（实测第一通电话就是这样）。而且多生成
     * 这六段还要多花好几秒 —— 通话最不能忍的就是这个。
     *
     * 所以这里写死用简洁版：只要原话。
     */
    const text = await transcribeAudio(eps.audio, CALL_AUDIO_PROMPT, audio);
    const clean = String(text ?? "").trim();
    logDebug(SCOPE, `听清了：${clean.slice(0, 60)}`);
    return clean;
  } catch (e) {
    logWarn(SCOPE, "这段没听清", e);
    return "";
  }
}

/**
 * 通话里转写用的提示词。
 *
 * 和 `config.js:DEFAULT_AUDIO_PROMPT` 几乎一样，只多两条通话特有的要求：
 *
 *  - **没人说话就回空**。语音条那边要描述环境音（「轻微键盘声、室内安静」），
 *    通话里不需要 —— VAD 已经切过一道了，走到这儿还没人声的多半是误触，
 *    回一句环境描述只会让角色对着噪音搭话。
 *  - **别加标点之外的任何东西**。
 */
const CALL_AUDIO_PROMPT =
  "你是一个语音转写器，正在转写一通电话里对方说的话。\n" +
  "直接输出原话纯文本，不要任何格式、编号、引号或说明。\n" +
  "如果这段音频里没有人说话（只有环境音、噪音、呼吸声），只输出两个字：无声。\n" +
  "只写你确实听到的内容，听不清就写听不清，禁止凭空推测或补全。";

/**
 * 跑一轮通话：打模型，一句一句往外吐合成好的音频。
 *
 * 这是个**异步生成器** —— 调用方 `for await` 拿到一句就立刻播一句，不等整段
 * 写完。这是延迟能压下来的关键，别改成返回数组。
 *
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.role
 * @param {object[]} args.messages 已经拼好的提示词（含通话预设）
 * @param {object} args.params 温度那些
 * @param {AbortSignal} [args.signal] 被打断时用它掐掉模型请求
 * @yields {{text: string, audio: Buffer}}
 */
export async function* runCallTurn({ config, role, messages, params, signal }) {
  const { endpoint, fallback } = callEndpoint(config, role);
  const sep = config?.chat?.separator ?? "$";
  const voiceId = role?.voiceSend?.voiceId ?? "";

  /*
   * 流式接收，攒够一句就吐出去。
   *
   * `pending` 是还没成句的尾巴。`onDelta` 只管往里攒 —— 真正的切句和合成在
   * 下面那个循环里做，因为 `onDelta` 是同步回调，不能在里面 await。
   */
  let buffer = "";
  let cursor = 0; // 已经处理到 buffer 的哪里了
  const ready = []; // 攒好的、等着合成的句子
  let done = false;
  let failed = null;
  let wake = null;

  const poke = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };

  const pull = () => {
    // 从没处理过的那截里切出完整的句子
    const rest = buffer.slice(cursor);
    const parts = splitSentences(rest, { minChars: ready.length ? 24 : 2 });
    if (parts.length <= 1) return; // 只有一截还没成句的尾巴，等更多字
    // 最后一段可能还没写完，留着
    const take = parts.slice(0, -1);
    for (const t of take) ready.push(t);
    cursor += take.join("").length;
    poke();
  };

  const task = chatWithFallback(endpoint, fallback, messages, params, {
    signal,
    /*
     * 少思考。默认开着，角色那栏能关。
     *
     * 这是通话延迟的**大头**：实测 gemini-3.8-flash 一轮生成 611–2212 个
     * token，而实际说出口的只有 23–67 字 —— 剩下全是思考，一轮等 8 到 25 秒。
     * 具体发什么字段、关不掉的型号怎么降档，见 llm.js:THINKING_LADDER。
     */
    noThinking: role?.call?.noThinking !== false,
    onDelta: (chunk) => {
      buffer += chunk;
      pull();
    },
  })
    .then((r) => {
      // 收尾：把剩下的尾巴也算成一句
      const rest = buffer.slice(cursor).trim();
      if (rest) ready.push(rest);
      done = true;
      poke();
      return r;
    })
    .catch((e) => {
      failed = e;
      done = true;
      poke();
    });

  let seq = 0;
  while (true) {
    if (ready.length === 0) {
      if (done) break;
      // 等下一句攒齐，或者等整段结束
      await new Promise((resolve) => {
        wake = resolve;
        // 兜底：万一 onDelta 一直不来（非流式的上游），别死等
        setTimeout(resolve, 500);
      });
      continue;
    }

    const raw = ready.shift();
    if (signal?.aborted) break;

    yield* sayOne(raw, { config, voiceId, sep, seq: seq++ });
  }

  await task;
  if (failed) throw failed;
}

/**
 * 把一句话合成出来。`runCallTurn` 和 `synthesizeSay` 共用这一段。
 *
 * 是生成器而不是普通函数，只为了「整句都是标记、没字可念」那种情况能
 * **一个都不 yield**（而不是 yield 一个空的让调用方再判一次）。
 *
 * @yields {{text: string, audio: Buffer|null, media: object[], seq?: number}}
 */
async function* sayOne(raw, { config, voiceId, sep, seq }) {
  /*
   * 功能保留，但不念出来。
   *
   * `splitMedia` 把这一句切成一条条带类型的 part（`media.js:250`）。只有
   * `text` 那些拿去念；转账、链接卡片、图片那些**照常交给各自的执行器**发出去
   * —— 打电话时角色突然想转个钱，这很真实，只是不该念出「transfer 冒号 4000」。
   */
  const parts = splitMedia(raw);
  const speakable = speakableFrom(parts, sep);
  const media = parts.filter((p) => p.kind !== "text");

  if (!speakable) {
    // 整句只有标记（比如单独一个 [transfer:…]），不用合成，但媒体要带出去
    if (media.length) yield { text: stripCallTags(raw), audio: null, media };
    return;
  }

  let audio = null;
  try {
    const out = await synthesizeVoice(config.ttsApi, voiceId, speakable, SCOPE);
    audio = out?.buffer ?? null;
  } catch (e) {
    /*
     * 合成失败不中断这一轮。
     *
     * 对方听不到这一句，但剩下的句子还能说 —— 比整通电话哑掉好。
     * TTS 四家全没配的时候也走这儿（`synthesizeVoice` 返回 null）。
     */
    logWarn(SCOPE, `这一句没合成出来：${speakable.slice(0, 30)}`, e);
  }

  yield { text: speakable, audio, media, seq };
}

/**
 * 把一段**已经写好**的话合成好 —— 不打模型。
 *
 * 现在只有一个用处：接通后的开场白。角色在答应接电话的那一轮里就把它写好了
 * （`[接受通话]` 后面那段），所以这里只剩合成，省掉一整轮模型（实测 8 到
 * 25 秒，对方接起来先听一片沉默）。
 *
 * ── 为什么是「全部做完再返回」，不是边做边吐 ──
 *
 * 模型那条路必须边做边吐（第一句一凑齐就播，见 runCallTurn 的文件头）。
 * 开场白正相反：它在**接通之前**就开始合成了 —— 角色答应接之后，浏览器要开、
 * 对方还要在 iPhone 上点「允许」，实测这段死时间十几秒。合成塞进这段时间里
 * 做完，接通那一刻只剩「把字节发给节点」。
 *
 * 所以这里要赶的不是「现在出第一句」，而是「接通那一刻一句都不等」。
 * 返回的形状和 `runCallTurn` 产出的一致，调用方不用分叉。
 *
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.role
 * @param {string} args.text 要说的话
 * @returns {Promise<object[]>} 几句 `{text, audio, media, seq}`
 */
export async function synthesizeSay({ config, role, text }) {
  const sep = config?.chat?.separator ?? "$";
  const voiceId = role?.voiceSend?.voiceId ?? "";
  const out = [];
  let seq = 0;
  for (const piece of splitSentences(String(text ?? ""), { minChars: 24 })) {
    for await (const part of sayOne(piece, { config, voiceId, sep, seq: seq++ })) {
      out.push(part);
    }
  }
  return out;
}

/**
 * 这一轮给模型的那条用户消息。
 *
 * 三种来源各有自己的前缀，都带上**已接通多久** —— 模型据此知道这段是打电话
 * 说的、聊了多久了。
 *
 * @param {object} opts
 * @param {string} opts.kind "said"（说的）/ "typed"（iMessage 打字）/ "silence"（没说话）
 * @param {string} [opts.text] said 和 typed 要
 * @param {number} [opts.seconds] silence 要
 * @param {string} [opts.userName]
 * @param {boolean} [opts.micOff] 对方是不是正处在「可能关麦了」的状态
 */
export function callUserMessage({ kind, text = "", seconds = 0, userName = "{{user}}", micOff = false }) {
  const head = callPrefix(sayDuration(elapsedMs()));

  if (kind === "silence") {
    return `${head}${silenceNotice(seconds, userName)}`;
  }
  if (kind === "typed") {
    // 关麦期间打字发来的，两个标记都带上
    const mic = micOff ? `[${userName}已关闭麦克风]` : "";
    return `${head}${mic}${typedPrefix(userName)}${text}`;
  }
  return `${head}${text}`;
}

/** 被打断时补进历史的那一条。让模型知道它实际说出口了什么。 */
export function interruptedMessage(said, dropped, userName = "{{user}}") {
  return `${callPrefix(sayDuration(elapsedMs()))}${interruptedNotice(said, dropped, userName)}`;
}

/**
 * 这一轮聊完了，记下来。
 *
 * **走的是和发短信完全一样的两个函数** —— `appendTurn` 进存档、`recordTurn`
 * 进记忆/备忘录/日记的待总结。通话不另开一套记忆，这是用户钉死的。
 *
 * 由 imessage.js 那边调，因为 `afterTurn` 和 `appendTurn` 都在那个文件里，
 * 搬过来会互相 import。这里只管把内存里那份通话记录记上。
 */
export function noteTurn(user, assistant) {
  return recordCallTurn(user, assistant);
}

/** 挂断时写进聊天记录的那条。翻记录时看得到什么时候通过话。 */
export function callRecordLine(call) {
  const dur = sayDuration(call?.durationMs ?? 0);
  const turns = call?.turns ?? 0;
  return `通话结束 · ${dur}${turns ? ` · ${turns} 轮对话` : ""}`;
}
