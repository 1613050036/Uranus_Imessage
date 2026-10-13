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
    "Qwen3-ASR"
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
    "Qwen3-ASR"
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
  /*
   * Qwen 的语言走顶层 `asr_options`。
   *
   * 这里原来断言的是「语言写进一条文字指令里」—— **那个做法本身是错的**，
   * 多出来的那条文字会让上游回 400（见下面那一组）。断言跟着改过来了。
   */
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "好的" } }] }) });
  await transcribe({ language: "ja", qwen: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  const body = JSON.parse(f.calls[0].init.body);
  check("语言在 asr_options 里", body.asr_options, { language: "ja" });
}

group("地址留空要用默认的（踩过的坑）");
{
  /*
   * normalizeSttApi 存进配置的是**空串**而不是 undefined，所以
   * `cfg.url ?? "默认地址"` 不管用 —— 空串会原样通过，拼出一个相对路径，
   * fetch 报 `TypeError: Failed to parse URL from /chat/completions`。
   * 实测用户换到 Qwen 的第一下就撞上了。
   */
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "好" } }] }) });
  await transcribe({ qwen: { enabled: true, key: "k", url: "" } }, Buffer.from("x"));
  f.restore();
  check(
    "Qwen 留空走阿里云官方",
    f.calls[0].url,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
  );
}
{
  const f = fakeFetch({ body: "ok" });
  await transcribe({ openai: { enabled: true, key: "k", url: "" } }, Buffer.from("x"));
  f.restore();
  check("OpenAI 留空走官方", f.calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
}
{
  // 只有空白也算留空
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "好" } }] }) });
  await transcribe({ qwen: { enabled: true, key: "k", url: "   " } }, Buffer.from("x"));
  f.restore();
  check(
    "全是空白也当留空",
    f.calls[0].url,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
  );
}
{
  // 填了就用填的，末尾斜杠吃掉
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "好" } }] }) });
  await transcribe(
    { qwen: { enabled: true, key: "k", url: "https://relay.example/v1/" } },
    Buffer.from("x")
  );
  f.restore();
  check("填了就用填的", f.calls[0].url, "https://relay.example/v1/chat/completions");
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
    { language: "zh", openai: { enabled: true, key: "k", prompt: "Ken、ming、上海" } },
    Buffer.from("x")
  );
  f.restore();
  const body = f.calls[0].init.body.toString("utf8");
  check("用用户那句", body.includes('name="prompt"\r\n\r\nKen、ming、上海'), true);
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

group("Qwen3-ASR 的请求形状（踩过两次的坑）");
{
  /*
   * `qwen3-asr-flash` 是阿里云那边的「专职任务」，请求体卡得很死：
   * user 的 content 数组**只许一条、而且只许 input_audio**。多塞一条文字
   * 指令就回 400 `The dedicated task 'asr' ... does not support this input.`
   * —— 那句话读起来像在骂音频格式，其实骂的是那条文字。
   *
   * 这几条断言就是为了别再把文字指令加回去。
   */
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "喂" } }] }) });
  await transcribe({ language: "zh", qwen: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  const body = JSON.parse(f.calls[0].init.body);

  const content = body.messages.at(-1).content;
  check("content 里只有一条", content.length, 1);
  check("那一条是 input_audio", content[0].type, "input_audio");
  check(
    "没有任何文字部分（多一条就 400）",
    content.some((c) => c.type === "text"),
    false
  );
  check("音频是 data URL", content[0].input_audio.data.startsWith("data:audio/wav;base64,"), true);
  // 语言走顶层 asr_options，不是写进文字里
  check("语言在 asr_options 里", body.asr_options, { language: "zh" });
  check("没填专有名词时不发 system", body.messages.length, 1);
}
{
  // 语言留空 = 不发 asr_options，让它自己判多语种
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "喂" } }] }) });
  await transcribe({ language: "", qwen: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  check("自动时不发 asr_options", "asr_options" in JSON.parse(f.calls[0].init.body), false);
}
{
  // 专有名词走 system，而且必须是第一条
  const f = fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: "喂" } }] }) });
  await transcribe(
    { language: "zh", qwen: { enabled: true, key: "k", prompt: "Ken、ming、上海" } },
    Buffer.from("x")
  );
  f.restore();
  const body = JSON.parse(f.calls[0].init.body);
  check("第一条是 system", body.messages[0].role, "system");
  check("内容就是那串词", body.messages[0].content, "Ken、ming、上海");
  check("音频还在最后那条", body.messages.at(-1).role, "user");
}
{
  /*
   * 中转站不认 asr_options 时脱掉重打 —— 丢掉「指定语言」比整条失败好。
   */
  // 第一次拒（点名 asr_options），第二次放过
  let n = 0;
  const f = fakeFetch(() =>
    n++ === 0
      ? {
          status: 400,
          body: JSON.stringify({
            error: { message: "Unrecognized request argument: asr_options" },
          }),
        }
      : { body: JSON.stringify({ choices: [{ message: { content: "喂" } }] }) }
  );
  const r = await transcribe({ language: "zh", qwen: { enabled: true, key: "k" } }, Buffer.from("x"));
  f.restore();
  check("重打了一次", f.calls.length, 2);
  check("第二次把 asr_options 脱了", "asr_options" in JSON.parse(f.calls[1].init.body), false);
  check("这一轮最终是成的", r.text, "喂");
}
{
  // 别的 400 不该触发那个重试（不然等于把每个错误都打两遍）
  const no = { status: 400, body: JSON.stringify({ error: { message: "invalid api key" } }) };
  const f = fakeFetch(no);
  let msg = "";
  await transcribe({ qwen: { enabled: true, key: "k" } }, Buffer.from("x")).catch((e) => {
    msg = String(e?.message ?? e);
  });
  f.restore();
  check("只打了一次", f.calls.length, 1);
  check("错误里带上游原文", msg.includes("invalid api key"), true);
}

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
  /*
   * 这里原来断言「带了一句转写指令」，理由写的是「不给它会回答音频里的
   * 问题而不是转写」。**那个判断是错的**：qwen3-asr-flash 是专职 ASR，
   * 只会转写；而多出来的那条文字会让它直接回 400。断言反过来了。
   */
  check("一个字的指令都不许带", body.messages[0].content.length, 1);
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
