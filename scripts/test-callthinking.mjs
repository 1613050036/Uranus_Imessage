/**
 * 通话那两项的测试：**让模型少思考** 和 **通话单独的世界书**。
 *
 * 跑法：`node scripts/test-callthinking.mjs`
 *
 * 为什么单独一个文件、而不是塞进 test-calltags：那份测的是纯函数（认链接、
 * 切句），这份要换掉全局 fetch 去看发出去的请求体长什么样 —— 两种测法混在
 * 一起，一个漏掉的 restore() 会让后面几十条莫名其妙地红。
 *
 * ── 这里钉死的是什么 ──
 *
 * 「关思考」这件事没法在本地验证**效果**（要真的打上游），所以测的是我们
 * 这边能保证的三件事：
 *
 *  1. 开关开着时请求体里真的带了那两个字段，关着时一个都不带；
 *  2. 上游嫌这一档不行时**降档重打**，而不是直接把字段删掉 —— Gemini 3
 *     那一代关不掉但能压到最低档，直接删等于放着最低档不用；
 *  3. 降到底才脱掉，而且脱掉之后这一轮照样能成（不许因为关思考打不通电话）。
 */

import { chatWithFallback } from "../server/src/llm.js";
import { toGeminiBody } from "../server/src/apitype.js";
import { buildPrompt } from "../server/src/prompt.js";
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
    console.log(`  ✗ ${what}\n      得到：${JSON.stringify(got)}\n      期望：${JSON.stringify(want)}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

/**
 * 换掉全局 fetch。`replies` 是一串响应，按顺序发给第 1、2、3… 次调用
 * （用完之后一直用最后那个）。每次的请求体都存下来。
 */
function fakeFetch(replies) {
  const list = Array.isArray(replies) ? replies : [replies];
  const bodies = [];
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const r = list[Math.min(n, list.length - 1)];
    n += 1;
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      headers: { get: () => "application/json" },
      async text() {
        return r.body ?? JSON.stringify({ choices: [{ message: { content: "喂" } }] });
      },
      async json() {
        return JSON.parse(r.body ?? JSON.stringify({ choices: [{ message: { content: "喂" } }] }));
      },
    };
  };
  return {
    bodies,
    get calls() {
      return bodies.length;
    },
    restore() {
      globalThis.fetch = orig;
    },
  };
}

const EP = { url: "https://relay.example/v1", key: "sk-x", model: "gemini-3.8-flash" };
const MSGS = [{ role: "user", content: "喂？" }];

// ───────────────────────────────── 开关本身

group("开关开着：请求体里带了那两个字段");
{
  const f = fakeFetch({});
  await chatWithFallback(EP, null, MSGS, {}, { noThinking: true });
  f.restore();
  check("只打了一次", f.calls, 1);
  check("从梯子最狠的那一档开始要", f.bodies[0].reasoning_effort, "none");
  check("Qwen / DeepSeek 那条也带上", f.bodies[0].enable_thinking, false);
}

group("开关关着：一个都不带");
{
  const f = fakeFetch({});
  await chatWithFallback(EP, null, MSGS, {}, {});
  f.restore();
  check("不发 reasoning_effort", "reasoning_effort" in f.bodies[0], false);
  check("不发 enable_thinking", "enable_thinking" in f.bodies[0], false);
}

group("strict 的模型也要发 —— 真正需要关思考的正是这批");
{
  // gemini-3.8 被 GEMINI_STRICT 认出来，温度那几个一个都不发
  const f = fakeFetch({});
  await chatWithFallback(EP, null, MSGS, { temperature: 0.7, topP: 0.9 }, { noThinking: true });
  f.restore();
  check("温度照旧不发（strict）", "temperature" in f.bodies[0], false);
  check("Top P 照旧不发（strict）", "top_p" in f.bodies[0], false);
  check("但 reasoning_effort 要发", f.bodies[0].reasoning_effort, "none");
}

// ───────────────────────────────── 降档梯子

group("上游嫌这一档不行：降一档重打，不是删掉");
{
  /*
   * 这是 Gemini 3 Flash 的真实报错措辞 —— 文档里列着 minimal，实际打过去
   * 回的是「valid values are high, low, medium, none」。注意它**没有**
   * unsupported 字样，所以 rejectsThinking 认得比 rejectedParamField 松。
   */
  const no = {
    status: 400,
    body: JSON.stringify({
      error: { message: "Invalid value for reasoning_effort. valid values are high, low, medium, none" },
    }),
  };
  const f = fakeFetch([no, {}]);
  await chatWithFallback(EP, null, MSGS, {}, { noThinking: true });
  f.restore();
  check("重打了一次", f.calls, 2);
  check("第一次要的是 none", f.bodies[0].reasoning_effort, "none");
  check("降到了梯子的下一档", f.bodies[1].reasoning_effort, "minimal");
  check("字段还在（没被当成「不收」删掉）", "reasoning_effort" in f.bodies[1], true);
}

group("一路降到底：脱掉字段，但这一轮照样要成");
{
  const no = {
    status: 400,
    body: JSON.stringify({ error: { message: "reasoning_effort is not supported by this model" } }),
  };
  // 前三次都拒（none / minimal / low），第四次（脱掉之后）放过
  const f = fakeFetch([no, no, no, {}]);
  const out = await chatWithFallback(EP, null, MSGS, {}, { noThinking: true });
  f.restore();
  check("三档都试过了", f.bodies.slice(0, 3).map((b) => b.reasoning_effort), ["none", "minimal", "low"]);
  check("最后一次把字段脱了", "reasoning_effort" in f.bodies[3], false);
  check("这一轮最终是成的", out.content, "喂");
}

group("它抱怨的是别的字段：不动思考那一档");
{
  const no = {
    status: 400,
    body: JSON.stringify({ error: { message: "Unsupported value: 'temperature' is not supported" } }),
  };
  const f = fakeFetch([no, {}]);
  await chatWithFallback(
    { ...EP, model: "some-relay-model" },
    null,
    MSGS,
    { temperature: 0.7 },
    { noThinking: true }
  );
  f.restore();
  check("脱掉的是 temperature", "temperature" in f.bodies[1], false);
  check("思考那一档没动", f.bodies[1].reasoning_effort, "none");
}

group("它抱怨 enable_thinking：按通用那条脱掉");
{
  const no = {
    status: 400,
    body: JSON.stringify({ error: { message: "Unrecognized request argument: enable_thinking" } }),
  };
  const f = fakeFetch([no, {}]);
  await chatWithFallback({ ...EP, model: "some-relay-model" }, null, MSGS, {}, { noThinking: true });
  f.restore();
  check("enable_thinking 被脱掉", "enable_thinking" in f.bodies[1], false);
  check("reasoning_effort 留着", f.bodies[1].reasoning_effort, "none");
}

// ───────────────────────────────── 翻译成原生 Gemini

group("原生 Gemini：翻成 thinkingConfig");
{
  const g = toGeminiBody({ model: "x", messages: MSGS, reasoning_effort: "none" });
  check("档位原样传过去", g.generationConfig.thinkingConfig, { thinkingLevel: "none" });
}
{
  const g = toGeminiBody({ model: "x", messages: MSGS });
  check("没要求少思考时整段不出现", g.generationConfig?.thinkingConfig, undefined);
}

// ───────────────────────────────── 通话世界书

/** 一份最小配置：两本非全局的书 + 一本全局的。 */
function configWithBooks(roleOverrides) {
  return normalizeConfig({
    worldBooks: [
      {
        id: "b-online",
        name: "线上那本",
        enabled: true,
        entries: [{ enabled: true, constant: true, content: "线上世界书命中了" }],
      },
      {
        id: "b-call",
        name: "通话那本",
        enabled: true,
        entries: [{ enabled: true, constant: true, content: "通话世界书命中了" }],
      },
      {
        id: "b-global",
        name: "全局那本",
        enabled: true,
        global: true,
        entries: [{ enabled: true, constant: true, content: "全局世界书命中了" }],
      },
    ],
    roles: [
      {
        id: "r1",
        name: "Charlie",
        description: "人设",
        worldBookRefs: ["b-online"],
        ...roleOverrides,
      },
    ],
  });
}

/** 把拼好的提示词压成一段文本，好 includes。 */
async function callPromptText(config) {
  const role = config.roles[0];
  const built = await buildPrompt(config, role, { name: "niki", description: "" }, [], "", {
    mode: "call",
    presetRef: "",
  });
  return built.messages.map((m) => String(m.content ?? "")).join("\n");
}

group("通话世界书：一本都不勾 = 跟着线上走");
{
  const text = await callPromptText(configWithBooks({ call: { enabled: true, worldBookRefs: [] } }));
  check("线上那本进来了", text.includes("线上世界书命中了"), true);
  check("没勾的那本不进来", text.includes("通话世界书命中了"), false);
  check("全局那本照旧进来", text.includes("全局世界书命中了"), true);
}

group("通话世界书：勾了就只用勾的");
{
  const text = await callPromptText(
    configWithBooks({ call: { enabled: true, worldBookRefs: ["b-call"] } })
  );
  check("勾的那本进来了", text.includes("通话世界书命中了"), true);
  check("线上那本不再带过来", text.includes("线上世界书命中了"), false);
  check("全局那本照旧进来", text.includes("全局世界书命中了"), true);
}

group("短信那条路不受通话的勾选影响");
{
  const config = configWithBooks({ call: { enabled: true, worldBookRefs: ["b-call"] } });
  const role = config.roles[0];
  const built = await buildPrompt(config, role, { name: "niki", description: "" }, [], "");
  const text = built.messages.map((m) => String(m.content ?? "")).join("\n");
  check("线上还是用线上那本", text.includes("线上世界书命中了"), true);
  check("通话挑的那本不进线上", text.includes("通话世界书命中了"), false);
}

// ───────────────────────────────── 配置默认值

group("配置默认值");
{
  const c = normalizeConfig({ roles: [{ id: "r", name: "x", description: "" }] });
  check("少思考默认开着", c.roles[0].call.noThinking, true);
  check("通话世界书默认空着（= 跟线上）", c.roles[0].call.worldBookRefs, []);
}
{
  const c = normalizeConfig({
    roles: [{ id: "r", name: "x", description: "", call: { noThinking: false } }],
  });
  check("能关掉", c.roles[0].call.noThinking, false);
}
{
  const c = normalizeConfig({
    roles: [
      { id: "r", name: "x", description: "", call: { worldBookRefs: ["a", "a", " b ", ""] } },
    ],
  });
  check("去重、去空白、去空串", c.roles[0].call.worldBookRefs, ["a", "b"]);
}

console.log(`\n${fail ? "有失败" : "全部通过"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
