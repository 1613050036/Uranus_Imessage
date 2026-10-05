import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { roleLabel } from "../labels.js";
import { useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, Fold, NumberField, ResultNote, Switch, inputCls } from "../ui.jsx";
import { ModelSelect } from "./role.jsx";
import { AppIcon, IPhone, WALLPAPERS } from "./phoneos.jsx";

/**
 * 查手机（后端见 server/src/phonecheck.js，那台 iPhone 在 phoneos.jsx）。
 *
 * 左边（手机屏幕上是上面）是模拟的 iPhone：锁屏 → 桌面 → 各个 App，App 里右上角刷新
 * 只生成那一个。右边（手机屏幕上是下面）是生成按钮和这个角色的几样设置，最底下是全局设置。
 */

/** 没选角色时设置卡也要列内置 App。和 phonecheck.js 的 BUILTIN_APPS 对上。 */
const BUILTIN = [
  { id: "contacts", name: "通讯录" },
  { id: "chat", name: "信息" },
  { id: "call", name: "电话" },
  { id: "shop", name: "购物" },
  { id: "delivery", name: "外卖" },
  { id: "browser", name: "浏览器" },
  { id: "wallet", name: "钱包" },
  { id: "track", name: "活动轨迹" },
  { id: "favorites", name: "收藏夹" },
];

const LAYOUT_NAMES = {
  generic: "通用卡片",
  shop: "购物",
  feed: "社交动态",
  forum: "论坛",
  novel: "小说",
};

const WALLPAPER_KEY = "uranus.phone.wallpaper";

function ago(ts) {
  if (!ts) return "还没翻过";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚翻过";
  if (m < 60) return `${m} 分钟前翻过`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前翻过`;
  return `${Math.round(h / 24)} 天前翻过`;
}

/** 有任务在跑时每秒重渲一次，好让「已经 N 秒」往上走。 */
function useTick(on) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/* ---------------- 右边：生成和这个角色的设置 ---------------- */

function RoleControls({ role, data, apps, batch, onGenerate, onBooks, running, wallpaper, setWallpaper }) {
  const { updateRole } = useConfig();
  const p = role.phone ?? {};
  const set = (patch) => updateRole(role.id, { phone: { ...p, ...patch } });
  const books = data.bookIds ?? [];
  const generating = running.length > 0;
  useTick(generating);

  // 重置会把整台手机换掉，点两下才算数
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return undefined;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  const total = Object.values(data.apps ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0);
  const batchApps = apps.filter((a) => batch.includes(a.id));
  const syncOn = [p.injectChat, p.toDiary, p.command].filter(Boolean).length;
  const errors = (data.jobs ?? []).filter((j) => j.status === "error").slice(0, 2);

  return (
    <div className="grid grid-cols-1 gap-8">
      {/* 一、生成 */}
      <section className="grid grid-cols-1 gap-4">
        <div>
          <p className="font-serif text-h3 text-ink">翻一翻</p>
          <p className="mt-1 text-meta text-ink-faint">
            {ago(data.lastAt)}
            {total ? ` · 手机里现在有 ${total} 条` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-eyebrow uppercase text-ink-faint">一次生成</span>
          {batchApps.length ? (
            batchApps.map((a) => (
              <span key={a.id} className="flex items-center gap-1.5 text-meta text-ink-soft">
                <span className="h-[18px] w-[18px] overflow-hidden rounded-[5px]">
                  <AppIcon app={a} size={18} label={false} />
                </span>
                {a.name}
              </span>
            ))
          ) : (
            <span className="text-meta text-warn">还没勾，去下面「设置」里选</span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            disabled={generating || !batchApps.length}
            onClick={() => onGenerate(null, "append")}
            className="flex items-center gap-3 bg-ink px-4 py-3.5 text-left text-paper-invert transition-colors hover:bg-ink-hover disabled:opacity-40"
          >
            {generating ? <Loader2 size={18} className="shrink-0 animate-spin" /> : <Sparkles size={18} className="shrink-0" />}
            <span>
              <span className="block text-ui font-medium">{total ? "继续生成" : "一键生成"}</span>
              <span className="block text-meta opacity-70">{total ? "接着往下加，不重复" : "按勾的那几个 App 一起来"}</span>
            </span>
          </button>
          {total > 0 && (
            <button
              type="button"
              disabled={generating || !batchApps.length}
              onClick={() => {
                if (!confirmReset) return setConfirmReset(true);
                setConfirmReset(false);
                onGenerate(null, "reset");
              }}
              className={`flex items-center gap-3 border px-4 py-3.5 text-left transition-colors disabled:opacity-40 ${
                confirmReset ? "border-warn text-warn" : "border-line text-ink hover:bg-ink/[0.04]"
              }`}
            >
              <RefreshCw size={18} className="shrink-0" />
              <span>
                <span className="block text-ui font-medium">{confirmReset ? "再点一次确认" : "重置并重新生成"}</span>
                <span className="block text-meta opacity-70">整台手机清空换新，成功才清</span>
              </span>
            </button>
          )}
        </div>

        {running.map((j) => (
          <ResultNote key={j.id} state="loading" icon={Loader2} message={`${j.title} · 已经 ${Math.round((Date.now() - j.startedAt) / 1000)} 秒`} />
        ))}
        {errors.map((j) => (
          <ResultNote key={j.id} state="fail" message={`「${j.title}」没生成出来：${j.error}`} />
        ))}
      </section>

      {/* 二、这个角色的几样设置 */}
      <div className="grid grid-cols-1">
        <Fold title="世界书" desc="这个角色关联的那几本，勾哪几本带哪几本" badge={books.length ? `${books.length} 本` : "不带"}>
          <div className="grid grid-cols-1 gap-4">
            {!data.books.length && <p className="text-meta text-ink-faint">这个角色没有关联任何世界书。</p>}
            {data.books.map((b) => (
              <label key={b.id} className="flex items-center justify-between gap-4">
                <span className="text-ui text-ink">
                  {b.name || "未命名世界书"}
                  {b.global && <span className="ml-2 text-meta text-ink-faint">全局</span>}
                </span>
                <Switch
                  checked={books.includes(b.id)}
                  onChange={(v) => onBooks(v ? [...books, b.id] : books.filter((x) => x !== b.id))}
                  label={`带上世界书 ${b.name}`}
                />
              </label>
            ))}
          </div>
        </Fold>

        <Fold title="同步与指令" desc="查到的东西要不要让角色知道；改完点底下的「保存」" badge={syncOn ? `开 ${syncOn} 项` : "关"}>
          <div className="grid grid-cols-1 gap-5">
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">同步到私聊</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  之后聊天时把最近一次查手机压成几行摘要告诉角色，免得它和自己手机里的东西对不上。摘要
                  <strong className="text-ink-soft">只进当轮请求、不进存档</strong>，每轮固定多下面这么多字，过了时效就不再带。
                </span>
              </span>
              <Switch checked={Boolean(p.injectChat)} onChange={(v) => set({ injectChat: v })} label="同步到私聊" />
            </label>
            {p.injectChat && (
              <div className="grid grid-cols-1 gap-6 border-l-2 border-line pl-4 sm:grid-cols-2">
                <NumberField label="每轮最多带" value={p.injectChars ?? 300} min={50} max={3000} step={50} suffix="字" hint="中文约同样多的 token" onChange={(v) => set({ injectChars: v })} />
                <NumberField label="生成后多久内带" value={p.injectHours ?? 24} min={1} max={720} step={1} suffix="小时" hint="过了就不带" onChange={(v) => set({ injectHours: v })} />
              </div>
            )}
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">同步到日记待总结</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">每次生成完往日记流水里记一行，角色写日记时能顺带写到手机里的事。</span>
              </span>
              <Switch checked={Boolean(p.toDiary)} onChange={(v) => set({ toDiary: v })} label="同步到日记待总结" />
            </label>
            {p.toDiary && !role.memories?.diary?.enabled && (
              <p className="-mt-3 text-meta text-warn">这个角色的日记没开，这条暂时不起作用（在「角色 → 单独配置 → 记忆库」里开）。</p>
            )}
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">允许 /查手机 指令</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">在 iMessage 里发 /查手机，按「一次生成」那一组接着翻一次，结果回你一条消息（不进上下文）。</span>
              </span>
              <Switch checked={Boolean(p.command)} onChange={(v) => set({ command: v })} label="允许查手机指令" />
            </label>
          </div>
        </Fold>

        <Fold title="壁纸" desc="锁屏和桌面的背景，只存在这个浏览器里" badge={WALLPAPERS[wallpaper]?.name}>
          <div className="flex flex-wrap gap-3">
            {Object.entries(WALLPAPERS).map(([id, w]) => (
              <button key={id} type="button" onClick={() => setWallpaper(id)} className="flex flex-col items-center gap-1.5">
                <span
                  className={`block h-[86px] w-[44px] rounded-[10px] ${wallpaper === id ? "ring-2 ring-ink ring-offset-2" : ""}`}
                  style={{ background: w.css }}
                />
                <span className={`text-meta ${wallpaper === id ? "text-ink" : "text-ink-faint"}`}>{w.name}</span>
              </button>
            ))}
          </div>
        </Fold>
      </div>
    </div>
  );
}

function SettingsCard({ builtin }) {
  const { config, updateConfig } = useConfig();
  const s = config.phone ?? {};
  const patch = (p) => updateConfig((c) => ({ ...c, phone: { ...(c.phone ?? {}), ...p } }));
  const custom = s.customApps ?? [];
  const all = [...builtin, ...custom];
  const batch = s.batchApps ?? ["contacts", "call", "shop", "delivery"];
  const patchApp = (id, p) => patch({ customApps: custom.map((a) => (a.id === id ? { ...a, ...p } : a)) });

  return (
    <Card title="设置" desc="所有角色共用。改完点底下的「保存」。">
      <div className="grid grid-cols-1 gap-6">
        <Field label="生成用的模型" hint="不选 = 用这个角色自己的聊天模型（失败会退到它的副 API）">
          <ModelSelect category="chat" value={s.model} onChange={(v) => patch({ model: v })} />
        </Field>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <NumberField label="超时" value={s.timeout ?? 180} min={30} max={1800} step={10} suffix="秒" onChange={(v) => patch({ timeout: v })} />
          <NumberField label="每个 App 生成" value={s.count ?? 4} min={1} max={10} step={1} suffix="条" onChange={(v) => patch({ count: v })} />
          <NumberField
            label="带最近几条聊天"
            value={s.contextCount ?? 20}
            min={0}
            max={100}
            step={1}
            suffix="条"
            hint="0 = 不带"
            onChange={(v) => patch({ contextCount: v })}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 border-t border-line pt-5">
          <p className="text-ui text-ink">一键生成包括</p>
          <p className="-mt-2 text-meta text-ink-faint">勾上的 App 一次请求一起生成（人设和聊天只发一遍，比一个个刷省）。/查手机 指令也用这一组。</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {all.map((a) => (
              <label key={a.id} className="flex items-center justify-between gap-3">
                <span className="text-ui text-ink">{a.name}</span>
                <Switch
                  checked={batch.includes(a.id)}
                  onChange={(v) => patch({ batchApps: v ? [...batch, a.id] : batch.filter((x) => x !== a.id) })}
                  label={`一键生成包括 ${a.name}`}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-line pt-5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-ui text-ink">自定义 App</p>
            <Button
              variant="outline"
              onClick={() =>
                patch({
                  customApps: [...custom, { id: `c-${Date.now().toString(36)}`, name: "新 App", icon: "📱", color: "#8e8e93", prompt: "", layout: "generic" }],
                })
              }
            >
              <Plus size={13} /> 新增
            </Button>
          </div>
          <p className="-mt-2 text-meta text-ink-faint">起个名字、写一句它是干什么的，模型就照着生成。所有角色的手机里都会有。</p>
          {custom.map((a) => (
            <div key={a.id} className="grid grid-cols-1 gap-3 border-l-2 border-line pl-4">
              <div className="flex items-end gap-3">
                <span className="mb-1 shrink-0">
                  <AppIcon app={{ ...a, custom: true }} size={40} label={false} />
                </span>
                <Field label="图标">
                  <input className={`${inputCls} !w-14 text-center`} value={a.icon} maxLength={4} onChange={(e) => patchApp(a.id, { icon: e.target.value })} />
                </Field>
                <Field label="颜色">
                  <input type="color" className="h-9 w-12 cursor-pointer border-0 bg-transparent" value={a.color} onChange={(e) => patchApp(a.id, { color: e.target.value })} />
                </Field>
                <Field label="名字">
                  <input className={inputCls} value={a.name} maxLength={20} onChange={(e) => patchApp(a.id, { name: e.target.value })} />
                </Field>
                <Button variant="ghost" onClick={() => patch({ customApps: custom.filter((x) => x.id !== a.id), batchApps: batch.filter((x) => x !== a.id) })}>
                  <Trash2 size={13} />
                </Button>
              </div>
              <Field label="它是干什么的">
                <textarea
                  className={`${inputCls} min-h-[3.5rem] leading-relaxed`}
                  value={a.prompt}
                  onChange={(e) => patchApp(a.id, { prompt: e.target.value })}
                  placeholder="比如：记账 App，记着 TA 每一笔偷偷给 {{user}} 买礼物的钱"
                />
              </Field>
              <Field label="排版">
                <select className={inputCls} value={a.layout} onChange={(e) => patchApp(a.id, { layout: e.target.value })}>
                  {Object.entries(LAYOUT_NAMES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function PhonePanel() {
  const { config } = useConfig();
  const { itemId } = useSection();
  const role = (config.roles ?? []).find((r) => r.id === itemId) ?? null;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [wallpaper, setWallpaperState] = useState(() => {
    try {
      return localStorage.getItem(WALLPAPER_KEY) || "dusk";
    } catch {
      return "dusk";
    }
  });
  const setWallpaper = (id) => {
    setWallpaperState(id);
    try {
      localStorage.setItem(WALLPAPER_KEY, id);
    } catch {
      /* 存不进就只在这一次有效 */
    }
  };

  const refresh = useCallback(async () => {
    if (!itemId) return;
    try {
      setData((await api(`/api/phone/${itemId}`)).state);
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, [itemId]);

  useEffect(() => {
    setData(null);
    refresh();
  }, [refresh]);

  const running = useMemo(() => (data?.jobs ?? []).filter((j) => j.status === "running"), [data?.jobs]);
  useEffect(() => {
    if (!running.length) return undefined;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [running.length, refresh]);

  const builtin = data?.builtin ?? BUILTIN;
  const apps = useMemo(() => [...builtin, ...(config.phone?.customApps ?? []).map((a) => ({ ...a, custom: true }))], [builtin, config.phone?.customApps]);
  const batch = config.phone?.batchApps ?? ["contacts", "call", "shop", "delivery"];
  // 正在生成的 App：单个刷新的任务标题就是 App 名，一键 / 继续 / 重置算一次生成那一组
  const busyApps = useMemo(() => {
    const set = new Set();
    for (const j of running) {
      const hit = apps.find((a) => a.name === j.title);
      if (hit) set.add(hit.id);
      else batch.forEach((id) => set.add(id));
    }
    return set;
  }, [running, apps, batch]);

  /** mode: "append" 在原来的手机上接着加 | "reset" 整台手机换成新的一批 */
  async function generate(appIds, mode = "append") {
    try {
      const r = await api(`/api/phone/${itemId}/generate`, {
        method: "POST",
        body: { apps: appIds ?? [], bookIds: data?.bookIds ?? [], mode },
      });
      setData(r.state);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }
  async function setBooks(bookIds) {
    setData((d) => ({ ...d, bookIds }));
    try {
      setData((await api(`/api/phone/${itemId}/books`, { method: "POST", body: { bookIds } })).state);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }
  async function del(appId, item) {
    try {
      setData((await api(`/api/phone/${itemId}/apps/${appId}?item=${encodeURIComponent(item)}`, { method: "DELETE" })).state);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }

  if (!itemId || !role) {
    return (
      <>
        <Card title="查手机" desc="左边挑一个角色，翻翻 TA 自己的手机。">
          <p className="text-meta leading-relaxed text-ink-faint">
            这里的东西全是模型按人设、记忆和最近的聊天虚构出来的、角色自己手机里的内容 —— 和「查岗」（看你的真屏幕）不是一回事。
          </p>
        </Card>
        <SettingsCard builtin={builtin} />
      </>
    );
  }

  return (
    <>
      <Card title={`${roleLabel(role)} 的手机`}>
        {error && <ResultNote state="fail" message={error} />}
        {!data && !error && <p className="text-eyebrow uppercase text-ink-meta">读取中</p>}
        {data && (
          <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:gap-14">
            <div className="lg:sticky lg:top-6">
              <IPhone
                data={data}
                apps={apps}
                busyApps={busyApps}
                onRefresh={(id) => generate([id])}
                onDelete={del}
                roleName={role.name}
                roleId={role.id}
                wallpaper={wallpaper}
              />
              <p className="mt-4 text-center text-meta text-ink-meta">点屏幕解锁 · App 里点底部横条回桌面 · 点一条可以看全文或删掉</p>
            </div>
            <RoleControls
              role={role}
              data={data}
              apps={apps}
              batch={batch}
              running={running}
              onGenerate={generate}
              onBooks={setBooks}
              wallpaper={wallpaper}
              setWallpaper={setWallpaper}
            />
          </div>
        )}
      </Card>
      <SettingsCard builtin={builtin} />
    </>
  );
}
