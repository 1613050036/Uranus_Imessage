#!/usr/bin/env node
/**
 * 「听音能回话，但模型说『请提供音频』」的一次性诊断。
 *
 * **只读**，不改任何配置，不打印密钥。
 *
 * 症状：`POST {中转站}/v1beta/models/{模型}:generateContent` 返回 200、模型
 * 正常回话，但回的是「请提供音频」。账单里 `audio_tokens: 0`、
 * `semantic: "openai"` —— 中转站把 Gemini 原生请求翻成了 OpenAI 格式转发，
 * 转换时把 `inline_data` 丢了。
 *
 * 这个脚本把同一段音频用**三种格式**各打一次，看哪种能让音频真的到模型：
 *
 *  1. `gemini-inline`  —— Uranus 现在用的（llm.js:inlineMedia）。
 *     Gemini 原生 `contents[].parts[].inline_data`。
 *  2. `openai-audio`   —— OpenAI 的 `messages[].content[].input_audio`，
 *     打 `/v1/chat/completions`。llm.js:1571 的注释说当初实测三家中转站都
 *     不透传，但没测过每一家，值得各自再试一次。
 *  3. `gemini-querykey` —— 还是 Gemini 原生，但密钥放查询串 `?key=`
 *     而不是 `Authorization: Bearer`。有的中转站按这个判断「要走原生管线」。
 *
 * 怎么看结果：**只看模型有没有真的听见**。三种格式都会返回 200，区别在
 * 回复内容和 token 账单：
 *
 *  - 回「请提供音频」/「我没有收到音频」+ 账单里 audio_tokens 为 0 → 音频被吞了
 *  - 回了音频里的实际内容 → 这条路通，照它改 llm.js
 *
 * 跑法（在项目根目录）：
 *
 *   node scripts/diag-audio-inline.mjs <一个音频文件> [模型名...]

 * 想试一个还没配进 Uranus 的中转站，加这两个参数（放在音频后面，顺序随意）：
 *
 *   --url=https://xxx/v1  --key=sk-xxx

 * 不给模型名就用角色当前配的那个。给了就挨个试 —— 中转站常把同一个模型
 * 分成好几个通道（逆向的、官转的），逆向通道天生传不了音频，换个名字就通了。
 * 例：node scripts/diag-audio-inline.mjs /tmp/test.mp3 gemini-2.5-flash 官转-gemini-3.8-flash
 *
 * 音频随便找一段有人声的 mp3 / m4a / wav，几秒钟就够。不给文件的话会自己
 * 用 ffmpeg 合成一段「嘀」声 —— 那个只能证明音频有没有被算进 token，
 * 证明不了转写对不对，所以尽量自己给一段带人声的。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DATA = process.env.URANUS_DATA_DIR || path.join(process.cwd(), "data");
const TIMEOUT = 120_000;

/** 问模型的那句话。要短，免得它自由发挥。 */
const PROMPT = "这段音频里的人说了什么？只回原话，不要任何解释。听不到声音就回「没有收到音频」。";

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/** 读配置，挑出听音那一路的 endpoint。只读盘，不走 config.js（它会拉起一堆东西）。 */
function readAudioEndpoint() {
  const mainPath = path.join(DATA, "config.json");
  const secretPath = path.join(DATA, "data.config.json");
  if (!fs.existsSync(mainPath)) die(`找不到 ${mainPath}，在项目根目录跑，或设 URANUS_DATA_DIR`);

  const main = JSON.parse(fs.readFileSync(mainPath, "utf8"));
  const secret = fs.existsSync(secretPath)
    ? JSON.parse(fs.readFileSync(secretPath, "utf8"))
    : { providerKeys: {} };

  // 挑第一个开了听音的角色，拿它的 audioModel。
  // 字段是 {provider, modelId, enabled}，其中 modelId 是**模型注册表的条目 id**，
  // 真正的模型名要再去 provider.models 里查一层（见 config.js:findModel）
  const roles = readRoles(main);
  const role = roles.find((r) => r?.audioModel?.enabled && r.audioModel.provider);
  if (!role) {
    const seen = roles
      .map((r) => `  ${r?.name ?? "?"}: enabled=${Boolean(r?.audioModel?.enabled)} provider=${r?.audioModel?.provider || "(空)"}`)
      .join("\n");
    die(`没找到开着「听音」且指定了服务商的角色。各角色现状：\n${seen}`);
  }

  const ref = role.audioModel;
  const provider = (main.providers ?? []).find((p) => p.id === ref.provider);
  if (!provider) {
    die(`角色「${role.name}」的听音指向服务商 ${ref.provider}，但配置里没有这个源`);
  }
  const entry = (provider.models ?? []).find((m) => m.id === ref.modelId);
  if (!entry?.model) {
    die(`服务商「${provider.name ?? provider.id}」里找不到模型条目 ${ref.modelId}`);
  }

  const keys = secret.providerKeys?.[provider.id] ?? provider.keys ?? [];
  const key = keys.find((k) => String(k ?? "").trim());
  if (!key) die(`服务商「${provider.name ?? provider.id}」没有可用的密钥`);

  return {
    roleName: role.name,
    providerName: provider.name ?? provider.id,
    url: String(provider.url ?? "").trim().replace(/\/+$/, ""),
    nativeBase: stripApiSuffix(provider.url),
    key: String(key),
    model: String(entry.model),
  };
}

/** 角色可能在 config.json 里，也可能一个一个躺在 data/characters/。 */
function readRoles(main) {
  if (Array.isArray(main.roles) && main.roles.length) return main.roles;
  const dir = path.join(DATA, "characters");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * 剥掉地址末尾的接口前缀，和 llm.js:geminiNativeUrl 一模一样。
 *
 * 配置里存的通常是 `https://xxx/v1`（OpenAI 那套的习惯），而 Gemini 原生路径
 * 是 `/v1beta/models/...` —— 不剥就会拼成 `/v1/v1beta/...`，直接 404。
 */
function stripApiSuffix(url) {
  let base = String(url ?? "").trim().replace(/\/+$/, "");
  for (const suffix of ["/v1/chat/completions", "/v1beta/openai", "/v1beta", "/v1"]) {
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".mp3") return ["audio/mpeg", "mp3"];
  if (ext === ".wav") return ["audio/wav", "wav"];
  if (ext === ".m4a" || ext === ".mp4") return ["audio/mp4", "m4a"];
  if (ext === ".ogg" || ext === ".opus") return ["audio/ogg", "ogg"];
  if (ext === ".flac") return ["audio/flac", "flac"];
  return ["audio/mpeg", "mp3"];
}

async function post(url, headers, body) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 不是 JSON 就留着原文 */
    }
    return { ok: res.ok, status: res.status, text, json, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, text: String(e?.message ?? e), json: null, ms: Date.now() - started };
  }
}

/** 从各家形状里把回复正文抠出来。 */
function pickText(json) {
  const gem = json?.candidates?.[0]?.content?.parts;
  if (Array.isArray(gem)) return gem.map((p) => p?.text ?? "").join("").trim();
  const oai = json?.choices?.[0]?.message?.content;
  if (typeof oai === "string") return oai.trim();
  if (Array.isArray(oai)) return oai.map((p) => p?.text ?? "").join("").trim();
  return "";
}

/** 把账单里和音频有关的数字抠出来 —— 这是判断「到底听没听见」最硬的证据。 */
function pickAudioTokens(json) {
  const u = json?.usageMetadata ?? json?.usage ?? {};
  const prompt = u.promptTokenCount ?? u.prompt_tokens ?? null;
  const detail =
    u.promptTokensDetails ??
    u.prompt_tokens_details ??
    u.billing_usage?.openai_usage?.prompt_tokens_details ??
    null;
  const audio = Array.isArray(detail)
    ? (detail.find((d) => /audio/i.test(d?.modality ?? ""))?.tokenCount ?? null)
    : (detail?.audio_tokens ?? null);
  const semantic = u.billing_usage?.semantic ?? json?.usage?.billing_usage?.semantic ?? null;
  return { prompt, audio, semantic };
}

function verdict(text, audioTokens) {
  const deaf = /没有收到音频|请提供音频|未收到|没有音频|no audio|provide the audio/i.test(text);
  if (audioTokens && audioTokens > 0 && !deaf) return "✅ 听见了";
  if (deaf) return "❌ 没听见（模型明说了）";
  if (audioTokens === 0) return "❌ 没听见（账单里音频 0 token）";
  return "⚠️ 说不准，自己看回复";
}

async function main() {
  const file = process.argv[2];
  const rest = process.argv.slice(3).filter(Boolean);
  const urlArg = rest.find((a) => a.startsWith("--url="))?.slice(6);
  const keyArg = rest.find((a) => a.startsWith("--key="))?.slice(6);
  const overrides = rest.filter((a) => !a.startsWith("--"));
  if (!file) die("用法：node scripts/diag-audio-inline.mjs <一个有人声的音频文件> [模型名...]");
  if (!fs.existsSync(file)) die(`找不到文件：${file}`);

  // 给了 --url / --key 就不读配置，直接试这一家
  const ep =
    urlArg && keyArg
      ? {
          roleName: "(命令行指定)",
          providerName: "(命令行指定)",
          url: urlArg.replace(/\/+$/, ""),
          nativeBase: stripApiSuffix(urlArg),
          key: keyArg,
          model: overrides[0] ?? "gemini-3.1-pro",
        }
      : readAudioEndpoint();
  const buf = fs.readFileSync(file);
  const base64 = buf.toString("base64");
  const [mimeType, fmt] = mimeFor(file);

  console.log(`
听音诊断
────────────────────────────────────────
角色     ${ep.roleName}
服务商   ${ep.providerName}
地址     ${ep.url}
原生前缀 ${ep.nativeBase}
模型     ${ep.model}
音频     ${path.basename(file)}（${(buf.length / 1024).toFixed(0)}KB, ${mimeType}）
────────────────────────────────────────`);

  const models = overrides.length ? overrides : [ep.model];
  for (const model of models) {
  if (models.length > 1 || overrides.length) console.log(`
########## 模型：${model} ##########`);
  const cases = [
    {
      name: "1. gemini-inline（Uranus 现在用的）",
      url: `${ep.nativeBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { Authorization: `Bearer ${ep.key}` },
      body: {
        contents: [
          {
            role: "user",
            parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }],
          },
        ],
      },
    },
    {
      name: "2. openai-audio（input_audio）",
      url: `${ep.nativeBase}/v1/chat/completions`,
      headers: { Authorization: `Bearer ${ep.key}` },
      body: {
        model: model,
        messages: [
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: base64, format: fmt } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      },
    },
    {
      name: "3. gemini-querykey（密钥放查询串）",
      url: `${ep.nativeBase}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ep.key)}`,
      headers: {},
      body: {
        contents: [
          {
            role: "user",
            parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }],
          },
        ],
      },
    },
  ];

  for (const c of cases) {
    console.log(`\n【${c.name}】`);
    console.log(`  POST ${c.url.replace(/key=[^&]+/, "key=***")}`);
    const r = await post(c.url, c.headers, c.body);
    if (!r.ok) {
      console.log(`  HTTP ${r.status || "连不上"}（${r.ms}ms）`);
      console.log(`  ${r.text.slice(0, 300).replace(/\s+/g, " ")}`);
      continue;
    }
    const text = pickText(r.json);
    const { prompt, audio, semantic } = pickAudioTokens(r.json);
    console.log(`  HTTP 200（${r.ms}ms）`);
    console.log(`  账单：提示词 ${prompt ?? "?"} token，音频 ${audio ?? "?"} token${semantic ? `，semantic=${semantic}` : ""}`);
    console.log(`  回复：${text.slice(0, 200) || "（空）"}`);
    console.log(`  → ${verdict(text, audio)}`);
  }
  }

  console.log(`
────────────────────────────────────────
有一条「✅ 听见了」就照那条改 llm.js:inlineMedia。
三条全是 ❌ → 这家中转站不透传音频，听音得单独换一个源
（官方 Gemini 的 key，或者别家中转站）。
`);
}

main().catch((e) => die(String(e?.stack ?? e)));
