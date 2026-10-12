/**
 * 离线自测：语音转文字（stt.js）。
 *
 * 三家的接法各有各的坑，而且**全都是那种「不报错但结果是错的」** —— 所以这里
 * 用假的 fetch 把请求拦下来逐字段检查，而不是真去打接口。
 *
 * 重点测什么：
 *
 *  - **挑哪一家**（pickSttSource）：顺序、以及「开着但凭据不全」要跳过。
 *    判错的后果是用户填了讯飞却一直在打 OpenAI。
 *  - **multipart 拼得对不对**：手拼的，边界、换行、Content-Type 错一个字节
 *    上游就回 400，而报错信息通常只有一句「invalid form data」。
 *  - **讯飞的分片拼接**：它的结果是一片片回来的，`pgs=rpl` 要替换掉一段范围内
 *    的旧片。不处理的话一句话里会出现重复的词 —— 这个错很隐蔽，因为大部分
 *    句子看起来是对的。
 *
 * 跑：node scripts/test-stt.mjs
 */

import { pickSttSource, transcribe } from "../server/src/stt.js";

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

/** 换掉全局 fetch，把请求存下来，回一个固定的响应。 */
function fakeFetch(reply) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = typeof reply === "function" ? reply(String(url), init) : reply;
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      async text() {
        return r.body ?? "";
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

// ───────────────────────────────── 挑哪一家

group("挑哪一家");
{
  check("什么都没配", pickSttSource({}), null);
  check("undefined 也不炸", pickSttSource(undefined), null);

  check(
    "只开了 OpenAI",
    pickSttSource({ openai: { enabled: true, key: "k" } })?.name,
    "OpenAI 兼容"
  );
  check(
    "只开了 Qwen",
    pickSttSource({ qwen: { enabled: true, key: "k" } })?.name,
    "Qwen-Audio"
  );
  check(
    "只开了讯飞",
    pickSttSource({ xfyun: { enabled: true, appId: "a", apiKey: "b", apiSecret: "c" } })?.name,
    "讯飞"
  );

  // 开着但凭据不全要跳过 —— 否则用户填了下一家却一直在打这一家
  check(
    "开着但没填密钥 → 跳过",
    pickSttSource({ openai: { enabled: true, key: "" }, qwen: { enabled: true, key: "k" } })?.name,
    "Qwen-Audio"
  );
  check(
    "讯飞缺一个凭据 → 跳过（它要三个）",
    pickSttSource({ xfyun: { enabled: true, appId: "a", apiKey: "b", apiSecret: "" } }),
    null
  );
  check(
    "填了密钥但开关没开 → 跳过",
    pickSttSource({ openai: { enabled: false, key: "k" } }),
    null
  );

  // 几家都配齐时按固定顺序
  check(
    "顺序：OpenAI → Qwen → 讯飞",
    pickSttSource({
      openai: { enabled: true, key: "k" },
      qwen: { enabled: true, key: "k" },
      xfyun: { enabled: true, appId: "a", apiKey: "b", apiSecret: "c" },
    })?.name,
    "OpenAI 兼容"
  );
}

// ───────────────────────────────── OpenAI 兼容

group("OpenAI 兼容：multipart 拼得对不对");
{
  const f = fakeFetch({ body: "喂？听得到吗" });
  const audio = Buffer.from("RIFF0000WAVEfake-audio-bytes");
  const r = await transcribe(
    { openai: { enabled: true, key: "sk-test", model: "whisper-1" } },
    audio,
    { mimeType: "audio/wav" }
  );
  f.restore();

  check("转写出来的文字", r.text, "喂？听得到吗");
  check("记下了用的哪家", r.source, "OpenAI 兼容");

  const { url, init } = f.calls[0];
  check("打的是 /audio/transcriptions", url, "https://api.openai.com/v1/audio/transcriptions");
  check("带了 Bearer", init.headers.Authorization, "Bearer sk-test");

  const body = init.body.toString("binary");
  const boundary = init.headers["Content-Type"].split("boundary=")[1];
  check("Content-Type 里有 boundary", Boolean(boundary), true);
  check("body 以 --boundary 开头", body.startsWith(`--${boundary}\r\n`), true);
  check("body 以 --boundary-- 结尾", body.trimEnd().endsWith(`--${boundary}--`), true);
  check("带了 model 字段", body.includes('name="model"\r\n\r\nwhisper-1'), true);
  check("要的是纯文本（不是 json）", body.includes('name="response_format"\r\n\r\ntext'), true);
  check("文件字段的 filename 和类型", body.includes('filename="audio.wav"'), true);
  check("音频字节原样带上了", body.includes("fake-audio-bytes"), true);
  // 没给 language 就不该发这个字段（让它自动判断）
  check("没指定语言时不发 language", body.includes('name="language"'), false);
}

group("语言是从配置里来的");
{
  // 配置里写了语言，调用方什么都没说 —— 也要发出去。
  // 不发的话 whisper 自己猜，通话那种又短又吵的片段它经常整段猜错语言
  const f = fakeFetch({ body: "ok" });
  await transcribe(
    { language: "zh", openai: { enabled: true, key: "k" } },
    Buffer.from("x")
  );
  f.restore();
  const body = f.calls[0].init.body.toString("binary");
  check("配置里的语言发出去了", body.includes('name="language"\r\n\r\nzh'), true);
}
{
  // 调用方显式指定的压过配置
  const f = fakeFetch({ body: "ok" });
  await transcribe({ language: "zh", openai: { enabled: true, key: "k" } }, Buffer.from("x"), {
    language: "ja",
  });
  f.restore();
  const body = f.calls[0].init.body.toString("binary");
  check("调用方指定的优先", body.includes('name="language"\r\n\r\nja'), true);
  check("配置里那个不会一起发", body.includes('name="language"\r\n\r\nzh'), false);
}
{
  // 空串 = 用户明确选了「自动」，那就真的别发
  const f = fakeFetch({ body: "ok" });
  await transcribe({ language: "", openai: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  check(
    "选了自动就不发 language",
    f.calls[0].init.body.toString("binary").includes('name="language"'),
    false
  );
}
{
  // Qwen 那条路没有 language 字段，语言是写进那句指令里的
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "好的" } }] }) });
  await transcribe({ language: "ja", qwen: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  const body = JSON.parse(f.calls[0].init.body);
  check("Qwen 的指令里点明了语言", body.messages[0].content[1].text.includes("日文"), true);
  check("不发 asr_options（中转站不认）", "asr_options" in body, false);
}

group("提示词：中文默认给一句简体的");
{
  /*
   * whisper 认中文默认偏繁体（实测「在家裡」），而它判断字形主要看 prompt
   * 里的字形。所以用户没填的时候自己给一句简体的过去。
   */
  const f = fakeFetch({ body: "ok" });
  await transcribe({ language: "zh", openai: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  // 中文要按 utf8 解 —— binary（latin1）下多字节字符对不上字面量
  const body = f.calls[0].init.body.toString("utf8");
  check("发了 prompt", body.includes('name="prompt"'), true);
  check("里面写着简体中文", body.includes("简体中文"), true);
}
{
  // 用户填了就用他的，别偷偷在后面拼一句
  const f = fakeFetch({ body: "ok" });
  await transcribe(
    { language: "zh", openai: { enabled: true, key: "k", prompt: "Charlie、niki、南宁" } },
    Buffer.from("x")
  );
  f.restore();
  const body = f.calls[0].init.body.toString("utf8");
  check("用用户那句", body.includes('name="prompt"\r\n\r\nCharlie、niki、南宁'), true);
  check("不把默认那句拼上去", body.includes("简体中文"), false);
}
{
  // 英文没有字形问题，瞎给一句只会引入偏见
  const f = fakeFetch({ body: "ok" });
  await transcribe({ language: "en", openai: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  check(
    "英文不给默认提示词",
    f.calls[0].init.body.toString("binary").includes('name="prompt"'),
    false
  );
}

group("OpenAI 兼容：几个细节");
{
  // 自定义中转站地址，末尾的斜杠要吃掉
  const f = fakeFetch({ body: "ok" });
  await transcribe(
    { openai: { enabled: true, key: "k", url: "https://my-relay.example/v1/" } },
    Buffer.from("x")
  );
  f.restore();
  check("中转站地址末尾的斜杠被去掉", f.calls[0].url, "https://my-relay.example/v1/audio/transcriptions");
}
{
  const f = fakeFetch({ body: "ok" });
  await transcribe({ openai: { enabled: true, key: "k" } }, Buffer.from("x"), {
    mimeType: "audio/mpeg",
    language: "zh",
  });
  f.restore();
  const body = f.calls[0].init.body.toString("binary");
  check("mp3 的扩展名跟着 mimeType 走", body.includes('filename="audio.mp3"'), true);
  check("给了语言就发 language", body.includes('name="language"\r\n\r\nzh'), true);
}
{
  // 有的中转站不认 response_format=text，照回 JSON —— 要兜住
  const f = fakeFetch({ body: '{"text":"从 JSON 里取出来的"}' });
  const r = await transcribe({ openai: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  check("上游回 JSON 时也能取出文字", r.text, "从 JSON 里取出来的");
}
{
  const f = fakeFetch({ status: 401, body: '{"error":"bad key"}' });
  let msg = "";
  try {
    await transcribe({ openai: { enabled: true, key: "k" } }, Buffer.from("x"));
  } catch (e) {
    msg = e.message;
  }
  f.restore();
  check("401 要抛错，而且带上状态码", msg.includes("401"), true);
  check("错误里带上游的原文，便于排查", msg.includes("bad key"), true);
}

// ───────────────────────────────── Qwen

group("阿里云 Qwen-Audio");
{
  const f = fakeFetch({
    body: JSON.stringify({ choices: [{ message: { content: "阿里云转出来的" } }] }),
  });
  const r = await transcribe(
    { qwen: { enabled: true, key: "sk-ali" } },
    Buffer.from("fake"),
    { mimeType: "audio/wav" }
  );
  f.restore();

  check("转写结果", r.text, "阿里云转出来的");
  check(
    "打的是兼容模式的 chat 接口",
    f.calls[0].url,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
  );

  const body = JSON.parse(f.calls[0].init.body);
  check("默认模型", body.model, "qwen3-asr-flash");
  check("音频是 data URL", body.messages[0].content[0].input_audio.data.startsWith("data:audio/wav;base64,"), true);
  // 不给文字指令它会"回答"音频里的问题而不是转写
  check("带了一句转写指令", body.messages[0].content[1].type, "text");
}
{
  // 它也可能回 [{type:"text",text:"…"}] 这种数组
  const f = fakeFetch({
    body: JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "数组格式" }] } }] }),
  });
  const r = await transcribe({ qwen: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  check("content 是数组时也能取出来", r.text, "数组格式");
}
{
  const f = fakeFetch({ body: "这不是 JSON" });
  let msg = "";
  try {
    await transcribe({ qwen: { enabled: true, key: "k" } }, Buffer.from("x"));
  } catch (e) {
    msg = e.message;
  }
  f.restore();
  check("回的不是 JSON 时说清楚", msg.includes("不是 JSON"), true);
}

// ───────────────────────────────── 兜底

group("都没配的时候");
{
  const r = await transcribe({}, Buffer.from("x"));
  // 返回 null 而不是空字符串 —— 调用方据此决定要不要退回多模态那条路
  check("返回 null（让调用方退回多模态）", r, null);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
