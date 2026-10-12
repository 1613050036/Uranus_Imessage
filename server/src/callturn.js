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
  const eps = resolveRoleEndpoints(config, role);
  if (!eps.audio) {
    logWarn(SCOPE, "这个角色没开「听音」，通话里对方说的话没法转成文字");
    return "";
  }

  const audio = {
    base64: wav.toString("base64"),
    mimeType: "audio/wav",
    name: "call.wav",
  };

  try {
    const text = await transcribeAudio(eps.audio, eps.audioPrompt, audio);
    const clean = String(text ?? "").trim();
    logDebug(SCOPE, `听清了：${clean.slice(0, 60)}`);
    return clean;
  } catch (e) {
    logWarn(SCOPE, "这段没听清", e);
    return "";
  }
}

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
      continue;
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

    yield { text: speakable, audio, media, seq: seq++ };
  }

  await task;
  if (failed) throw failed;
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
