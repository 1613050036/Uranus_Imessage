import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Eye, Loader2, Pencil, Plus, RotateCcw, Sparkles, Star, Trash2, X } from "lucide-react";
import { roleLabel } from "../labels.js";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, Modal, NumberField, ResultNote, Switch, inputCls } from "../ui.jsx";
import { ModelSelect } from "./role.jsx";

/**
 * 小剧场：主线之外的番外，让模型写成一份完整的 HTML 页面（后端见 server/src/theater.js）。
 *
 * 搬自用户自己的 AstrBot 插件 astrbot_plugin_html_theater。四节：
 *  生成 —— 选角色、勾这个角色关联的世界书、选模板或写临时提示词
 *  成品 —— 预览 / 新标签页打开 / 收藏 / 重试 / 续写下一章 / 删除
 *  模板 —— 模板目录的增删改
 *  设置 —— 模型、超时（默认 180 秒）、提示词、保留数量……这一节走全局保存
 *
 * 模板和成品不在 config 里（data/theater/），改了立刻落盘，不用点保存。
 *
 * 成品 HTML 只放进 `sandbox="allow-scripts"` 的 iframe（srcdoc）里看：
 * 不给 allow-same-origin，页面里的脚本碰不到控制台的登录态。
 */

const fmtTime = (ts) =>
  ts
    ? new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";

/** 成品原文 → 新标签页（blob 地址，和控制台不同源，脚本照样隔开）。 */
async function openInTab(id) {
  const win = window.open("", "_blank");
  try {
    const r = await api(`/api/theater/plays/${id}/html`);
    const url = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
    if (win) win.location.href = url;
    else window.open(url, "_blank");
  } catch (e) {
    win?.close();
    alert(String(e?.message ?? e));
  }
}

function PreviewModal({ play, onClose }) {
  const [html, setHtml] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api(`/api/theater/plays/${play.id}/html`)
      .then((r) => alive && setHtml(r.html))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [play.id]);
  return (
    <Modal title={play.title} onClose={onClose} maxWidth="max-w-5xl">
      {error && <ResultNote state="fail" message={error} />}
      {html === null && !error && <p className="text-meta text-ink-faint">读取中…</p>}
      {html !== null && (
        <iframe
          title={play.title}
          sandbox="allow-scripts allow-popups allow-forms"
          srcDoc={html}
          className="h-[70vh] w-full border border-line bg-white"
        />
      )}
    </Modal>
  );
}

function GenerateCard({ data, refresh, roles }) {
  const [roleId, setRoleId] = useState("");
  const [mode, setMode] = useState("template"); // template | temp
  const [templateId, setTemplateId] = useState("");
  const [temp, setTemp] = useState("");
  const [books, setBooks] = useState([]);
  const [note, setNote] = useState({ state: "idle", message: "" });

  const role = roles.find((r) => r.id === roleId) ?? null;
  const options = data.roleBookOptions?.[roleId] ?? [];

  // 默认选第一个角色、第一个模板
  useEffect(() => {
    if (!roleId && roles[0]) setRoleId(roles[0].id);
  }, [roles, roleId]);
  useEffect(() => {
    if (!templateId && data.templates[0]) setTemplateId(data.templates[0].id);
  }, [data.templates, templateId]);
  // 换角色时恢复它上次勾的那几本（只留现在还关联着的）
  useEffect(() => {
    const last = data.roleBooks?.[roleId] ?? [];
    setBooks(last.filter((id) => options.some((b) => b.id === id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId]);

  async function go() {
    setNote({ state: "loading", message: "已提交，后台生成中…" });
    try {
      await api("/api/theater/generate", {
        method: "POST",
        body: {
          roleId,
          templateId: mode === "template" ? templateId : "",
          prompt: mode === "temp" ? temp : "",
          bookIds: books,
        },
      });
      setNote({ state: "idle", message: "" });
      refresh();
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    }
  }

  const running = data.jobs.filter((j) => j.status === "running");
  const recent = data.jobs.filter((j) => j.status !== "running").slice(0, 3);

  return (
    <Card title="生成" desc="选一个角色，挑模板或者临时写一段提示词。人设用这个角色的人设和它对应的用户人设。">
      <div className="grid grid-cols-1 gap-6">
        {!roles.length && <p className="text-meta text-warn">还没有角色，先去「角色」里建一个。</p>}

        <Field label="角色">
          <select className={inputCls} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-1 gap-3">
          <p className="text-eyebrow uppercase text-ink-faint">
            世界书
            <span className="ml-2 normal-case tracking-normal text-ink-meta">
              这个角色关联的那几本（挂在角色上的 + 全局的），勾哪几本带哪几本
            </span>
          </p>
          {!options.length && (
            <p className="text-meta text-ink-faint">
              {role ? "这个角色没有关联任何世界书。" : "先选角色。"}
            </p>
          )}
          {options.map((b) => (
            <label key={b.id} className="flex items-center justify-between gap-4">
              <span className="text-ui text-ink">
                {b.name || "未命名世界书"}
                {b.global && <span className="ml-2 text-meta text-ink-faint">全局</span>}
              </span>
              <Switch
                checked={books.includes(b.id)}
                onChange={(v) => setBooks((s) => (v ? [...s, b.id] : s.filter((x) => x !== b.id)))}
                label={`带上世界书 ${b.name}`}
              />
            </label>
          ))}
        </div>

        <Field label="写什么">
          <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="template">用模板</option>
            <option value="temp">临时小剧场（这次写的提示词，不进模板目录）</option>
          </select>
        </Field>

        {mode === "template" ? (
          <Field label="模板">
            <select className={inputCls} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {data.templates.map((t, i) => (
                <option key={t.id} value={t.id}>
                  {i + 1}. {t.title}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="提示词" hint="{{char}} / {{user}} 会换成名字">
            <textarea
              className={`${inputCls} min-h-[6rem] leading-relaxed`}
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              placeholder="{{char}} 和 {{user}} 被困在只营业一晚的午夜书店"
            />
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={go} disabled={!roleId || note.state === "loading"}>
            <Sparkles size={14} /> 生成
          </Button>
          <span className="text-meta text-ink-faint">一次要一两分钟，可以离开这一页，生成好了会出现在下面「成品」里。</span>
        </div>
        <ResultNote state={note.state} message={note.message} />

        {running.map((j) => (
          <ResultNote
            key={j.id}
            state="loading"
            icon={Loader2}
            message={`「${j.title}」生成中…已经 ${Math.round((Date.now() - j.startedAt) / 1000)} 秒`}
          />
        ))}
        {recent
          .filter((j) => j.status === "error")
          .map((j) => (
            <ResultNote key={j.id} state="fail" message={`「${j.title}」没能生成：${j.error}`} />
          ))}
      </div>
    </Card>
  );
}

function PlayRow({ play, refresh, onPreview }) {
  const [busy, setBusy] = useState(false);
  const [cont, setCont] = useState(null); // null = 没在写续写要求
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError] = useState("");

  const act = async (path, opts) => {
    setBusy(true);
    setError("");
    try {
      await api(path, opts);
      refresh();
      return true;
    } catch (e) {
      setError(String(e?.message ?? e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-2 border-b border-line py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ui text-ink">
            {play.favorite && <Star size={13} className="mr-1 inline fill-current" />}
            {play.title}
          </p>
          <p className="mt-0.5 text-meta text-ink-faint">
            {play.roleName} · {fmtTime(play.createdAt)}
            {play.chapter ? ` · 第 ${play.chapter} 章` : ""}
            {play.bookNames?.length ? ` · 世界书：${play.bookNames.join("、")}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="outline" onClick={() => onPreview(play)}>
            <Eye size={13} /> 预览
          </Button>
          <Button variant="ghost" onClick={() => openInTab(play.id)}>
            <ExternalLink size={13} /> 新标签页
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => act(`/api/theater/plays/${play.id}/favorite`, { method: "POST", body: { favorite: !play.favorite } })}
          >
            <Star size={13} /> {play.favorite ? "取消收藏" : "收藏"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => act(`/api/theater/plays/${play.id}/retry`, { method: "POST" })}>
            <RotateCcw size={13} /> 重试
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setCont(cont === null ? "" : null)}>
            <Pencil size={13} /> 续写
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            className={confirmDel ? "text-warn hover:text-warn" : ""}
            onClick={() =>
              confirmDel ? act(`/api/theater/plays/${play.id}`, { method: "DELETE" }) : setConfirmDel(true)
            }
          >
            <Trash2 size={13} /> {confirmDel ? "再点一次删掉" : "删除"}
          </Button>
        </div>
      </div>
      {play.text && <p className="line-clamp-2 text-meta leading-relaxed text-ink-soft">{play.text}</p>}
      {cont !== null && (
        <div className="grid grid-cols-1 gap-2">
          <textarea
            className={`${inputCls} min-h-[4rem] leading-relaxed`}
            value={cont}
            onChange={(e) => setCont(e.target.value)}
            placeholder="续写要求：比如「第二天早上，两个人在书店门口醒来」"
          />
          <div className="flex gap-2">
            <Button
              disabled={busy || !cont.trim()}
              onClick={async () => {
                if (await act(`/api/theater/plays/${play.id}/continue`, { method: "POST", body: { prompt: cont } })) {
                  setCont(null);
                }
              }}
            >
              生成下一章
            </Button>
            <Button variant="ghost" onClick={() => setCont(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {error && <ResultNote state="fail" message={error} />}
    </div>
  );
}

function PlaysCard({ data, refresh }) {
  const [filter, setFilter] = useState("all"); // all | fav
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(null);
  const list = data.plays.filter(
    (p) =>
      (filter === "all" || p.favorite) &&
      (!query.trim() || `${p.title}\n${p.text}`.toLowerCase().includes(query.trim().toLowerCase()))
  );
  return (
    <Card title="成品" desc="每次生成都是一份新的 HTML，不覆盖。收藏的不会被「保留数量」清理掉。">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <select className={`${inputCls} !w-36`} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部（{data.plays.length}）</option>
          <option value="fav">收藏夹（{data.plays.filter((p) => p.favorite).length}）</option>
        </select>
        <input
          className={`${inputCls} !w-56`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜标题或正文"
        />
      </div>
      {!list.length && <p className="py-4 text-meta text-ink-faint">还没有成品。</p>}
      {list.map((p) => (
        <PlayRow key={p.id} play={p} refresh={refresh} onPreview={setPreview} />
      ))}
      {preview && <PreviewModal play={preview} onClose={() => setPreview(null)} />}
    </Card>
  );
}

function TemplatesCard({ data, refresh }) {
  const [editing, setEditing] = useState(null); // null | {id?, title, prompt}
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState("");

  async function save() {
    setError("");
    try {
      await api("/api/theater/templates", { method: "POST", body: editing });
      setEditing(null);
      refresh();
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }

  return (
    <Card
      title="模板"
      desc="小剧场的题目。{{char}} / {{user}} 生成时换成名字；同名的会自动加编号，不会覆盖。"
      actions={
        <Button variant="outline" onClick={() => setEditing({ title: "", prompt: "" })}>
          <Plus size={13} /> 新模板
        </Button>
      }
    >
      {editing && (
        <div className="mb-6 grid grid-cols-1 gap-4 border-b border-line pb-6">
          <Field label="标题">
            <input className={inputCls} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          </Field>
          <Field label="提示词">
            <textarea
              className={`${inputCls} min-h-[8rem] leading-relaxed`}
              value={editing.prompt}
              onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <Button onClick={save}>保存模板</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              <X size={13} /> 取消
            </Button>
          </div>
          {error && <ResultNote state="fail" message={error} />}
        </div>
      )}
      {data.templates.map((t, i) => (
        <div key={t.id} className="flex items-start justify-between gap-4 border-b border-line py-3">
          <div className="min-w-0">
            <p className="text-ui text-ink">
              {i + 1}. {t.title}
            </p>
            <p className="mt-0.5 line-clamp-2 text-meta leading-relaxed text-ink-faint">{t.prompt}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" onClick={() => setEditing({ ...t })}>
              <Pencil size={13} /> 编辑
            </Button>
            <Button
              variant="ghost"
              className={confirmId === t.id ? "text-warn hover:text-warn" : ""}
              onClick={async () => {
                if (confirmId !== t.id) return setConfirmId(t.id);
                await api(`/api/theater/templates/${t.id}`, { method: "DELETE" });
                setConfirmId("");
                refresh();
              }}
            >
              <Trash2 size={13} /> {confirmId === t.id ? "再点一次" : "删除"}
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

function SettingsCard({ defaultSystemPrompt }) {
  const { config, updateConfig } = useConfig();
  const t = config.theater ?? {};
  const patch = (p) => updateConfig((c) => ({ ...c, theater: { ...(c.theater ?? {}), ...p } }));
  return (
    <Card title="设置" desc="这一节改完要点底下的「保存」。">
      <div className="grid grid-cols-1 gap-6">
        <Field label="生成用的模型" hint="标了「聊天」分类的模型里挑一个">
          <ModelSelect category="chat" value={t.model} onChange={(v) => patch({ model: v })} />
        </Field>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <NumberField
            label="超时"
            value={t.timeout ?? 180}
            min={30}
            max={1800}
            step={10}
            suffix="秒"
            hint="一次请求最多等多久。长篇 HTML 慢，别设太短"
            onChange={(v) => patch({ timeout: v })}
          />
          <NumberField
            label="保留数量"
            value={t.retention ?? 30}
            min={1}
            max={1000}
            step={1}
            suffix="个"
            hint="超了删最旧的未收藏成品"
            onChange={(v) => patch({ retention: v })}
          />
        </div>
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">空回 / 截断补救</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              模型回了空的、或者 HTML 没写到 &lt;/html&gt; 就断了，最多再补三次；还是不完整就不存残缺文件。
            </span>
          </span>
          <Switch checked={t.continueOnEmpty !== false} onChange={(v) => patch({ continueOnEmpty: v })} label="空回截断补救" />
        </label>
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">带上最近的聊天记录</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              把这个角色最近一个会话的最后几条消息也发给小剧场模型，写出来的番外能接上你们最近聊的事。
            </span>
          </span>
          <Switch checked={Boolean(t.injectContext)} onChange={(v) => patch({ injectContext: v })} label="带上聊天记录" />
        </label>
        {t.injectContext && (
          <div className="border-l-2 border-line pl-4">
            <NumberField
              label="带几条"
              value={t.contextCount ?? 20}
              min={1}
              max={100}
              step={1}
              suffix="条"
              onChange={(v) => patch({ contextCount: v })}
            />
          </div>
        )}
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">生成后注入当前会话</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              在 iMessage 里用 /小剧场 这类指令生成时，生成完等 5 秒，把小剧场的正文（纯文字，不带 CSS 和代码）当成一轮交给角色，
              角色会照着人设回你一条；这一轮和回复都会存进会话历史，之后聊天都记得。网页面板里生成的不注入（和插件一样）。
            </span>
          </span>
          <Switch checked={Boolean(t.injectAfterGeneration)} onChange={(v) => patch({ injectAfterGeneration: v })} label="生成后注入当前会话" />
        </label>
        {t.injectAfterGeneration && (
          <div className="grid grid-cols-1 gap-5 border-l-2 border-line pl-4">
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">注入时带上小剧场提示词</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  关掉就只带正文，免得角色把这次的提示词和之前的搞混。
                </span>
              </span>
              <Switch
                checked={t.injectTheaterPrompt !== false}
                onChange={(v) => patch({ injectTheaterPrompt: v })}
                label="注入时带上小剧场提示词"
              />
            </label>
            <Field label="注入提示词" hint="放在最前面的那句话；清空就不加">
              <textarea
                className={`${inputCls} min-h-[4rem] leading-relaxed`}
                value={t.injectionPrompt ?? ""}
                onChange={(e) => patch({ injectionPrompt: e.target.value })}
              />
            </Field>
            <p className="-mt-2 text-meta leading-relaxed text-ink-faint">
              这一轮会多花一次聊天请求，正文最多带 6000 字。
            </p>
          </div>
        )}
        <Field label="系统提示词" hint="留空用默认的（插件原版那段）">
          <textarea
            className={`${inputCls} min-h-[8rem] font-mono text-xs leading-relaxed`}
            value={t.systemPrompt ?? ""}
            onChange={(e) => patch({ systemPrompt: e.target.value })}
            placeholder={defaultSystemPrompt}
          />
        </Field>
        <Field label="文风提示词" hint="可以不填">
          <textarea
            className={`${inputCls} min-h-[4rem] leading-relaxed`}
            value={t.stylePrompt ?? ""}
            onChange={(e) => patch({ stylePrompt: e.target.value })}
          />
        </Field>
      </div>
    </Card>
  );
}

export function TheaterPanel() {
  const { config } = useConfig();
  const roles = useMemo(() => config.roles ?? [], [config.roles]);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setData(await api("/api/theater"));
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 有任务在跑就每 3 秒拉一次，跑完了停
  const running = data?.jobs?.some((j) => j.status === "running");
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [running, refresh]);

  if (error) return <ResultNote state="fail" message={error} />;
  if (!data) return <p className="text-eyebrow uppercase text-ink-meta">读取中</p>;

  return (
    <>
      <GenerateCard data={data} refresh={refresh} roles={roles} />
      <PlaysCard data={data} refresh={refresh} />
      <TemplatesCard data={data} refresh={refresh} />
      <SettingsCard defaultSystemPrompt={data.defaultSystemPrompt} />
    </>
  );
}
