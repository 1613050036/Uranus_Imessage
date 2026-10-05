import { useState } from "react";
import { Loader2, Plug, Plus, Trash2, X } from "lucide-react";
import { WORKER } from "../edition.js";
import { api, useConfig } from "../store.jsx";
import { Button, Field, NumberField, ResultNote, Switch, inputCls } from "../ui.jsx";

/**
 * 「MCP 工具」那一段（角色面板里的一栏）。
 *
 * 和联网搜索一样两层东西挤在一块：
 *
 *  - **角色上的**（role.mcp）：开关、调用方式（文本标记 / 原生 function calling）、
 *    标记长什么样、提示词、三个额度，以及这个角色用哪几台服务器。
 *  - **全局的**（config.mcpServers）：服务器本身。地址和请求头里的 token 是密钥，
 *    只写 data.config.json、不进不含密钥的备份 —— 和搜索密钥一个待遇。
 *    所以在这里改服务器是在改所有角色共用的那一份，界面上写明了。
 *
 * 后端在 server/src/mcp.js。下面几个常量要和那边对上。
 */

/** 和 server/src/mcp.js 的 DEFAULT_MARKER 对上。 */
const DEFAULT_MARKER = "[工具:{name} {args}]";

/** 和 server/src/mcp.js 的 DEFAULT_TEXT_PROMPT / DEFAULT_NATIVE_PROMPT 对上（只当 placeholder 用）。 */
const DEFAULT_TEXT_PROMPT = [
  "你可以调用下面这些工具去查东西或者办事。需要用的时候，在回复里写：",
  "{{format}}",
  "参数写成 JSON，没有参数就写 {}。一轮最多调用 {{maxCalls}} 次。",
  "写了工具标记就先别回答对方，等拿到结果再正式回话。对方看不到这一趟，也不用跟对方交代你用了工具。",
  "用不上就别用，正常聊天。",
  "",
  "可用的工具：",
  "{{tools}}",
].join("\n");
const DEFAULT_NATIVE_PROMPT = [
  "你可以通过函数调用使用工具去查东西或者办事，一轮最多调用 {{maxCalls}} 次。",
  "对方看不到这一趟，也不用跟对方交代你用了工具。用不上就别调，正常聊天。",
].join("\n");

/** 和 server/src/mcp.js:markerValid 同一个判断。 */
function markerValid(template) {
  const t = String(template ?? "").trim();
  if (!t) return true;
  const ni = t.indexOf("{name}");
  const ai = t.indexOf("{args}");
  return ni > 0 && Boolean(t.slice(0, ni).trim()) && !(ai !== -1 && ai < ni);
}

/** 模板填一个示范，给用户看模型实际会写成什么样。 */
function markerExample(template) {
  const t = markerValid(template) && String(template ?? "").trim() ? template.trim() : DEFAULT_MARKER;
  return t.replace("{name}", "get_weather").replace("{args}", '{"city": "上海"}');
}

const TRANSPORTS = [
  { id: "http", name: "Streamable HTTP", hint: "现在的标准写法：填一个地址，一般以 /mcp 结尾" },
  { id: "sse", name: "SSE（老式）", hint: "2024 年那版协议，地址一般以 /sse 结尾。还有不少托管服务只给这个" },
  {
    id: "stdio",
    name: "本地命令（stdio）",
    hint: "在这台电脑上起一个进程，比如 npx -y @modelcontextprotocol/server-filesystem",
  },
];

function blankServer() {
  return {
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    enabled: true,
    transport: "http",
    url: "",
    headers: [],
    command: "",
    args: [],
    env: [],
    cwd: "",
    timeout: 30,
    disabledTools: [],
  };
}

/** `[{name, value}]` 的编辑器。请求头和环境变量共用。 */
function PairsEditor({ label, hint, pairs, onChange, namePh, valuePh, addLabel }) {
  const list = pairs ?? [];
  const patchAt = (i, p) => onChange(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="grid grid-cols-1 gap-2">
      <p className="text-eyebrow uppercase text-ink-faint">
        {label}
        {hint && <span className="ml-2 normal-case tracking-normal text-ink-meta">{hint}</span>}
      </p>
      {list.map((p, i) => (
        <div key={i} className="flex items-center gap-3">
          <input
            className={`${inputCls} !w-2/5 font-mono text-xs`}
            value={p.name ?? ""}
            onChange={(e) => patchAt(i, { name: e.target.value })}
            placeholder={namePh}
          />
          <input
            type="password"
            className={`${inputCls} font-mono text-xs`}
            value={p.value ?? ""}
            onChange={(e) => patchAt(i, { value: e.target.value })}
            placeholder={valuePh}
          />
          <button
            type="button"
            aria-label="删掉这一行"
            className="shrink-0 text-ink-faint hover:text-ink"
            onClick={() => onChange(list.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div>
        <Button variant="outline" onClick={() => onChange([...list, { name: "", value: "" }])}>
          <Plus size={13} />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** 一台服务器。全局的那份，所有角色共用。 */
function ServerCard({ server, used, onUse, onChange, onRemove }) {
  const [test, setTest] = useState({ state: "idle", message: "", tools: null });
  const [confirmDel, setConfirmDel] = useState(false);
  const stdio = server.transport === "stdio";
  const disabled = new Set(server.disabledTools ?? []);
  // 小手机上 stdio 用不了，选项藏掉；已经选了的（从桌面版备份恢复过来的）照样显示，好让人看见那句提示
  const transports = TRANSPORTS.filter((t) => !WORKER || t.id !== "stdio" || stdio);

  async function runTest() {
    setTest({ state: "loading", message: "正在连…", tools: null });
    try {
      const r = await api("/api/mcp/test", { method: "POST", body: { server } });
      const who = [r.server?.name, r.server?.version].filter(Boolean).join(" ");
      setTest({
        state: "ok",
        message: `连上了${who ? `（${who}）` : ""}，有 ${r.tools.length} 个工具，${r.ms}ms`,
        tools: r.tools,
      });
    } catch (e) {
      setTest({ state: "fail", message: String(e?.message ?? e), tools: null });
    }
  }

  const toggleTool = (name, on) => {
    const next = new Set(disabled);
    if (on) next.delete(name);
    else next.add(name);
    onChange({ disabledTools: [...next] });
  };

  return (
    <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
      <div className="flex items-end gap-4">
        <Field label="名字" hint="只是给你自己认的">
          <input
            className={inputCls}
            value={server.name ?? ""}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="比如：高德地图、我的笔记"
          />
        </Field>
        <Button
          variant="ghost"
          onClick={() => (confirmDel ? onRemove() : setConfirmDel(true))}
          className={confirmDel ? "text-warn hover:text-warn" : ""}
        >
          <Trash2 size={13} />
          {confirmDel ? "再点一次删掉" : "删除"}
        </Button>
      </div>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">这个角色用它</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            服务器是所有角色共用的，每个角色自己勾用哪几台。
          </span>
        </span>
        <Switch checked={used} onChange={onUse} label="这个角色用这台服务器" />
      </label>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">启用</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            关掉 = 所有角色都暂时不用它，配置留着。
          </span>
        </span>
        <Switch
          checked={server.enabled !== false}
          onChange={(v) => onChange({ enabled: v })}
          label="启用这台服务器"
        />
      </label>

      <Field label="连接方式" hint={TRANSPORTS.find((t) => t.id === server.transport)?.hint}>
        <select
          className={inputCls}
          value={server.transport ?? "http"}
          onChange={(e) => onChange({ transport: e.target.value })}
        >
          {transports.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>

      {stdio && WORKER && (
        <p className="text-meta leading-relaxed text-warn">
          小手机跑在 Cloudflare 上，起不了本地命令，这台服务器在这里用不了。换成远程地址（HTTP / SSE）才行。
        </p>
      )}

      {stdio ? (
        <>
          <Field label="命令" hint="可执行文件，比如 npx、uvx、node">
            <input
              className={`${inputCls} font-mono text-xs`}
              value={server.command ?? ""}
              onChange={(e) => onChange({ command: e.target.value })}
              placeholder="npx"
            />
          </Field>
          <Field label="参数" hint="一行一个，带空格的参数也不用加引号">
            <textarea
              className={`${inputCls} min-h-[5rem] font-mono text-xs leading-relaxed`}
              value={(server.args ?? []).join("\n")}
              onChange={(e) => onChange({ args: e.target.value.split("\n") })}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\nD:\\笔记"}
            />
          </Field>
          <PairsEditor
            label="环境变量"
            hint="API Key 一般放这儿"
            pairs={server.env}
            onChange={(env) => onChange({ env })}
            namePh="变量名，比如 API_KEY"
            valuePh="值"
            addLabel="加一个环境变量"
          />
          <Field label="工作目录" hint="可以不填">
            <input
              className={`${inputCls} font-mono text-xs`}
              value={server.cwd ?? ""}
              onChange={(e) => onChange({ cwd: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="地址">
            <input
              className={`${inputCls} font-mono text-xs ${
                server.url && !/^https?:\/\//i.test(server.url) ? "border-warn text-warn" : ""
              }`}
              value={server.url ?? ""}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder={server.transport === "sse" ? "https://example.com/sse" : "https://example.com/mcp"}
            />
          </Field>
          <PairsEditor
            label="请求头"
            hint="鉴权一般是 Authorization: Bearer 你的token"
            pairs={server.headers}
            onChange={(headers) => onChange({ headers })}
            namePh="Authorization"
            valuePh="Bearer …"
            addLabel="加一个请求头"
          />
        </>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <NumberField
          label="单次调用超时"
          value={server.timeout ?? 30}
          min={5}
          max={120}
          step={5}
          suffix="秒"
          hint="对方在那头干等着，别太长"
          onChange={(v) => onChange({ timeout: v })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={runTest} disabled={test.state === "loading"}>
          {test.state === "loading" ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
          测试连接
        </Button>
        {disabled.size > 0 && !test.tools && (
          <span className="text-meta text-ink-faint">关掉了 {disabled.size} 个工具，测试一下能看到全部</span>
        )}
      </div>
      <ResultNote state={test.state} message={test.message} />

      {test.tools?.length > 0 && (
        <div className="grid grid-cols-1 gap-4">
          <p className="text-meta leading-relaxed text-ink-faint">
            关掉的工具不会告诉模型（所有角色都一样）。工具越少，提示词越短、模型也越不容易用错。
          </p>
          {test.tools.map((t) => (
            <label key={t.name} className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block font-mono text-xs text-ink">{t.name}</span>
                {t.description && (
                  <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                    {t.description}
                  </span>
                )}
              </span>
              <Switch
                checked={!disabled.has(t.name)}
                onChange={(v) => toggleTool(t.name, v)}
                label={`让模型用 ${t.name}`}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoleMcpFields({ role, onGoto }) {
  const { config, savedConfig, updateRole, updateMcpServers } = useConfig();
  const m = role.mcp ?? {};
  const servers = config.mcpServers ?? [];
  const picked = new Set(m.servers ?? []);
  const native = m.mode === "native";
  const set = (patch) => updateRole(role.id, { mcp: { ...m, ...patch } });

  const usable = servers.filter((s) => picked.has(s.id) && s.enabled !== false);
  const unsaved = JSON.stringify(servers) !== JSON.stringify(savedConfig?.mcpServers ?? []);

  const patchServer = (id, p) =>
    updateMcpServers((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const pickServer = (id, on) =>
    set({ servers: on ? [...new Set([...picked, id])] : [...picked].filter((x) => x !== id) });
  const addServer = () => {
    const s = blankServer();
    updateMcpServers((list) => [...list, s]);
    // 在这个角色的面板里新建的，顺手给它勾上
    pickServer(s.id, true);
  };
  const removeServer = (id) => {
    updateMcpServers((list) => list.filter((s) => s.id !== id));
    if (picked.has(id)) pickServer(id, false);
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-ui text-ink">MCP 工具</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
            接上你自己的 MCP 服务器（地图、日历、笔记、数据库……），这个角色需要的时候先调工具查一下或者办件事，
            拿到结果再正式回话。那一趟对方看不见，只会收到最终那条回复。
          </span>
        </span>
        <Switch checked={Boolean(m.enabled)} onChange={(v) => set({ enabled: v })} label="启用 MCP 工具" />
      </label>

      {m.enabled && (
        <div className="grid grid-cols-1 gap-6">
          {!usable.length && (
            <p className="text-meta leading-relaxed text-warn">
              这个角色还没勾上能用的服务器，开着也不会带工具。在下面加一台，或者把已有的勾上。
            </p>
          )}

          {/* 一、调用方式 */}
          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            <Field label="调用方式">
              <select className={inputCls} value={native ? "native" : "text"} onChange={(e) => set({ mode: e.target.value })}>
                <option value="text">文本标记（哪家 API 都能用）</option>
                <option value="native">原生 function calling（要上游支持）</option>
              </select>
            </Field>
            <p className="text-meta leading-relaxed text-ink-faint">
              {native ? (
                <>
                  工具清单放在请求体的 <code className="mx-1 bg-sunken px-1">tools</code>{" "}
                  里，模型回 <code className="mx-1 bg-sunken px-1">tool_calls</code>
                  。更稳，也不占提示词，但要模型和中转站都支持。OpenAI 兼容、Gemini、Claude 官方接口都会自动翻译。
                  上游不收的话这一轮会去掉工具重打（照常聊天，只是没有工具），控制台里会提示，那时换成文本标记就行。
                </>
              ) : (
                <>
                  工具清单写进提示词，模型在回复里写一个标记，我们拦下来去调。不需要上游支持 tools，
                  中转站、Gemini、Claude 都能用。标记发给对方之前会收掉，存档里留原文。
                </>
              )}
            </p>

            {!native && (
              <>
                <Field label="标记格式" hint="{name} 是工具名，{args} 是 JSON 参数；留空用默认的">
                  <input
                    className={`${inputCls} font-mono text-xs ${markerValid(m.marker) ? "" : "border-warn text-warn"}`}
                    value={m.marker ?? ""}
                    onChange={(e) => set({ marker: e.target.value })}
                    placeholder={DEFAULT_MARKER}
                  />
                </Field>
                {markerValid(m.marker) ? (
                  <p className="text-meta leading-relaxed text-ink-faint">
                    模型会写成这样：<code className="mx-1 bg-sunken px-1">{markerExample(m.marker)}</code>
                    <br />
                    {"{name}"} 前面得有点东西（用来在回复里认出标记），{"{args}"} 要放在 {"{name}"}{" "}
                    后面，可以不要（那就是不收参数）。参数里出现结尾那个符号也没关系，会按 JSON 认。
                  </p>
                ) : (
                  <p className="text-meta leading-relaxed text-warn">
                    这个格式用不了：要有 {"{name}"}，前面得有点东西，{"{args}"} 只能放在它后面。现在实际用的是默认那个
                    <code className="mx-1 bg-sunken px-1">{DEFAULT_MARKER}</code>。
                  </p>
                )}
              </>
            )}

            <Field
              label="提示词"
              hint={
                native
                  ? "留空用默认的。{{maxCalls}} 换成次数上限"
                  : "留空用默认的。{{tools}} 换成工具清单，{{format}} 换成标记示范，{{maxCalls}} 换成次数上限"
              }
            >
              <textarea
                className={`${inputCls} min-h-[8rem] font-mono text-xs leading-relaxed`}
                value={m.prompt ?? ""}
                onChange={(e) => set({ prompt: e.target.value })}
                placeholder={native ? DEFAULT_NATIVE_PROMPT : DEFAULT_TEXT_PROMPT}
              />
            </Field>
            <p className="text-meta leading-relaxed text-ink-faint">
              这段话放在预设开头那几条 system 之后，只进这一轮请求，不进存档。
              {!native && "自己写的提示词里漏了 {{tools}} 的话，工具清单会自动接在末尾 —— 不给清单模型就不知道有什么能用。"}
            </p>
          </div>

          {/* 二、额度 */}
          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            <div>
              <p className="text-ui text-ink">额度</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                每多一趟就多一次生成、多等几秒。工具结果和搜索结果一样
                <strong className="text-ink-soft">只注入这一次</strong>
                、不进存档；想回看调了什么、拿回来什么，去
                <button
                  type="button"
                  className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                  onClick={() => onGoto?.("console")}
                >
                  控制台
                </button>
                看「MCP 调用」那几条，点开就是参数和结果原文。
              </p>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <NumberField
                label="最多往返几趟"
                value={m.maxRounds ?? 2}
                min={1}
                max={5}
                step={1}
                suffix="趟"
                hint="拿到结果还能接着调"
                onChange={(v) => set({ maxRounds: v })}
              />
              <NumberField
                label="一轮最多调几次"
                value={m.maxCalls ?? 3}
                min={1}
                max={10}
                step={1}
                suffix="次"
                hint="几趟加起来的总数"
                onChange={(v) => set({ maxCalls: v })}
              />
              <NumberField
                label="单个结果字数上限"
                value={m.maxChars ?? 2000}
                min={200}
                max={8000}
                step={100}
                suffix="字"
                hint="超了截断"
                onChange={(v) => set({ maxChars: v })}
              />
            </div>
          </div>

          {/* 三、服务器（全局） */}
          <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
            <div>
              <p className="text-ui text-ink">MCP 服务器</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                服务器
                <strong className="text-ink-soft">是全局的，所有角色共用</strong>
                ，每个角色自己勾用哪几台。地址、请求头、环境变量都当密钥处理，不会进不含密钥的备份。
                {WORKER
                  ? "小手机只能连远程地址（HTTP / SSE），本地命令只有桌面版能用。"
                  : "远程地址（HTTP / SSE）和本地命令（stdio）都行。"}
              </p>
            </div>

            {servers.map((s) => (
              <ServerCard
                key={s.id}
                server={s}
                used={picked.has(s.id)}
                onUse={(v) => pickServer(s.id, v)}
                onChange={(p) => patchServer(s.id, p)}
                onRemove={() => removeServer(s.id)}
              />
            ))}

            <div>
              <Button variant="outline" onClick={addServer}>
                <Plus size={13} />
                新增 MCP 服务器
              </Button>
            </div>

            {unsaved && (
              <p className="text-meta leading-relaxed text-warn">
                服务器的改动还没保存，这会儿发消息还在用旧的。测试连接用的是界面上这份，不用先保存。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
