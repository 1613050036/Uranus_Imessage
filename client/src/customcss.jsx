import { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { api } from "./store.jsx";
import { Button, Card, ResultNote } from "./ui.jsx";

/**
 * 自定义 CSS（后端 server/src/customcss.js，存在 data/custom-css.json）。
 *
 * 两份：
 *  - console：整个控制台，原样注入；
 *  - phone：查手机的那台手机，自动包进 `.uranus-phone { … }`（CSS 嵌套）里，
 *    只管得到手机里面 —— 写错了也弄不坏控制台，「重置」按钮永远点得到。
 *
 * 控制台那份写坏到连「重置」都点不到时：网址后面加 `?nocss` 打开，这一次不注入任何自定义 CSS。
 */

const STYLE_ID = { console: "uranus-custom-css-console", phone: "uranus-custom-css-phone" };
const CHANGED = "uranus-custom-css";

/** 网址带 ?nocss：安全模式，什么都不注入。 */
export const CSS_SAFE_MODE =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("nocss");

/**
 * 嵌套里放不进去的几种（@import / @font-face / @keyframes / @property / @charset）提到外面，
 * 其余整段包进 `.uranus-phone { }`。按顶层的大括号切，不认注释和字符串里的括号 —— 够用了。
 */
function scopePhoneCss(css) {
  const keep = [];
  const scoped = [];
  let i = 0;
  const src = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  while (i < src.length) {
    const start = i;
    let depth = 0;
    let end = src.length;
    for (let j = i; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === ";" && depth === 0 && /^\s*@(import|charset)/i.test(src.slice(start, j))) {
        end = j + 1;
        break;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth <= 0) {
          end = j + 1;
          break;
        }
      }
    }
    const chunk = src.slice(start, end).trim();
    if (chunk) (/^@(import|charset|font-face|keyframes|-webkit-keyframes|property)\b/i.test(chunk) ? keep : scoped).push(chunk);
    i = end;
  }
  return [...keep, scoped.length ? `.uranus-phone {\n${scoped.join("\n")}\n}` : ""].join("\n");
}

function inject(kind, css) {
  let el = document.getElementById(STYLE_ID[kind]);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID[kind];
    // 放在 head 最后：排在 Tailwind 那份后面，同样的选择器写一遍就能盖过去
    document.head.appendChild(el);
  }
  el.textContent = CSS_SAFE_MODE || !css ? "" : kind === "phone" ? scopePhoneCss(css) : css;
}

/** 外壳挂一次：登录后拉一份注入，面板保存时通过事件直接换掉。 */
export function useCustomCss() {
  useEffect(() => {
    let alive = true;
    api("/api/custom-css")
      .then((r) => {
        if (!alive) return;
        inject("console", r.console);
        inject("phone", r.phone);
      })
      .catch(() => {
        /* 拉不到就是没有，不打扰 */
      });
    const onChange = (e) => inject(e.detail.kind, e.detail.css);
    window.addEventListener(CHANGED, onChange);
    return () => {
      alive = false;
      window.removeEventListener(CHANGED, onChange);
    };
  }, []);
}

const TABS = [
  {
    id: "console",
    label: "控制台",
    hint: "整个控制台都生效，原样注入，排在自带样式后面。改字体、颜色、背景都行；控制台自带样式多是 Tailwind 的类名，盖不过时加 !important。",
    placeholder: "/* 例：换个字体、把背景换成纯色 */\nbody { font-family: \"霞鹜文楷\", serif; }\nbody, main { background: #f6f1ea !important; }",
  },
  {
    id: "phone",
    label: "查手机的手机",
    hint: "只在「查手机」那台手机里生效（自动套在 .uranus-phone 里面）。手机里很多样式是写在元素上的，要加 !important 才盖得住。整台手机本身用 & 选：& { … }。当前打开的 App 在 [data-app=\"chat\"] 这种属性上，锁屏时有 [data-locked]。",
    placeholder: "/* 例：整台手机换字体，信息 App 里换个底色 */\n* { font-family: \"霞鹜文楷\", serif !important; }\n&[data-app=\"chat\"] .bg-white { background: #fdf6f0 !important; }",
  },
];

/** 「控制台 → 自定义 CSS」那一节。 */
export function CustomCssPanel() {
  const [saved, setSaved] = useState(null); // { console, phone }
  const [draft, setDraft] = useState({ console: "", phone: "" });
  const [tab, setTab] = useState("console");
  const [note, setNote] = useState({ state: "idle", message: "" });
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/api/custom-css")
      .then((r) => {
        setSaved(r);
        setDraft(r);
      })
      .catch((e) => setNote({ state: "fail", message: String(e?.message ?? e) }));
  }, []);

  async function save(kind, css) {
    setBusy(true);
    try {
      const r = await api("/api/custom-css", { method: "PUT", body: { [kind]: css } });
      setSaved(r);
      setDraft((d) => ({ ...d, [kind]: r[kind] }));
      window.dispatchEvent(new CustomEvent(CHANGED, { detail: { kind, css: r[kind] } }));
      setNote({ state: "ok", message: css ? "已保存，已经生效了" : "已重置，回到自带的样式" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
      setConfirmReset(false);
    }
  }

  const t = TABS.find((x) => x.id === tab);
  const dirty = saved && draft[tab] !== saved[tab];

  return (
    <Card
      title="自定义 CSS"
      desc="把自己的 CSS 整段贴进来，点保存马上生效。写坏了点「重置」就回到自带的样式；控制台写到连这个按钮都点不着的话，在网址后面加 ?nocss 打开，这一次不加载任何自定义 CSS。"
    >
      <div className="grid grid-cols-1 gap-4">
        {CSS_SAFE_MODE && (
          <ResultNote state="fail" message="现在是安全模式（网址带 ?nocss）：自定义 CSS 都没加载。在这里改好或者重置，再去掉 ?nocss 刷新。" />
        )}
        <div className="flex flex-wrap gap-1">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => {
                setTab(x.id);
                setConfirmReset(false);
                setNote({ state: "idle", message: "" });
              }}
              className={`rounded-item px-2.5 py-1 text-meta transition-colors duration-150 ${
                tab === x.id ? "bg-sunken text-ink" : "text-ink-meta hover:bg-sunken hover:text-ink"
              }`}
            >
              {x.label}
              {saved?.[x.id] ? " · 已启用" : ""}
            </button>
          ))}
        </div>
        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">{t.hint}</p>
        <textarea
          className="min-h-[18rem] w-full resize-y border border-line bg-transparent p-3 font-mono text-meta leading-relaxed text-ink outline-none focus:border-ink"
          spellCheck={false}
          value={draft[tab] ?? ""}
          placeholder={t.placeholder}
          onChange={(e) => setDraft((d) => ({ ...d, [tab]: e.target.value }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || !dirty} onClick={() => save(tab, draft[tab])}>
            <Save size={14} /> 保存并应用
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft((d) => ({ ...d, [tab]: saved[tab] }))}>
              撤销改动
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy || (!saved?.[tab] && !draft[tab])}
            className={confirmReset ? "text-warn hover:text-warn" : ""}
            onClick={() => (confirmReset ? save(tab, "") : setConfirmReset(true))}
          >
            <RotateCcw size={13} /> {confirmReset ? `再点一次，清空${t.label}的 CSS` : "重置"}
          </Button>
        </div>
        <ResultNote state={note.state} message={note.message} />
      </div>
    </Card>
  );
}
