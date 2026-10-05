import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BatteryFull,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Compass,
  Loader2,
  MapPin,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  ShoppingBag,
  Signal,
  Sparkles,
  Trash2,
  UserRound,
  UtensilsCrossed,
  Wallet,
  Wifi,
  X,
} from "lucide-react";
import { roleLabel } from "../labels.js";
import { useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, NumberField, ResultNote, Switch, inputCls } from "../ui.jsx";
import { ModelSelect } from "./role.jsx";

/**
 * 查手机（后端见 server/src/phonecheck.js）。
 *
 * 玩法参考 SullyOS（手抓糯米机，NMJ 作）的「查手机」App，界面和代码是重写的。
 *
 * 左边（手机上是上面）是一台模拟的 iPhone：桌面一格格 App，点进去看内容、
 * 右上角刷新就只生成这一个 App。右边（手机上是下面）是这个角色的开关、
 * 世界书和「一键生成」，最底下是全局设置。
 *
 * 「信息」App 是 iMessage 的样子：置顶那个对话是和你的真实聊天（最近五轮，
 * 直接读存档，不打模型），下面是模型生成的、角色和别人的聊天。
 */

/** 内置 App 的图标和配色。id 要和 phonecheck.js 的 BUILTIN_APPS 对上。 */
const APP_LOOK = {
  chat: { icon: MessageCircle, bg: "linear-gradient(180deg,#5af575,#14c34a)" },
  call: { icon: Phone, bg: "linear-gradient(180deg,#5af575,#14c34a)" },
  contacts: { icon: UserRound, bg: "linear-gradient(180deg,#d6d6db,#a5a5ad)" },
  shop: { icon: ShoppingBag, bg: "linear-gradient(180deg,#ff9f45,#ff6a00)" },
  delivery: { icon: UtensilsCrossed, bg: "linear-gradient(180deg,#ffd84d,#f5b400)" },
  browser: { icon: Compass, bg: "linear-gradient(180deg,#4fb2ff,#0a6cff)" },
  wallet: { icon: Wallet, bg: "linear-gradient(180deg,#3a3a3c,#000)" },
  track: { icon: MapPin, bg: "linear-gradient(180deg,#7ee38a,#2fb4ff)" },
  favorites: { icon: Bookmark, bg: "linear-gradient(180deg,#ff6b8b,#d6286b)" },
};
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

/** 放在 Dock 里的四个。 */
const DOCK = ["call", "chat", "browser", "favorites"];

const LAYOUT_NAMES = {
  generic: "通用卡片",
  shop: "购物",
  feed: "社交动态",
  forum: "论坛",
  novel: "小说",
};

function clock() {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `我: …` / `对方: …` 一行一句 → 气泡。认不出前缀的当对方说的。 */
function parseThread(detail) {
  return String(detail ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(我|对方)\s*[:：]\s*(.*)$/.exec(l);
      return m ? { from: m[1] === "我" ? "me" : "them", text: m[2] } : { from: "them", text: l };
    });
}

function AppIcon({ app, size = 56, onClick, label = true }) {
  const look = APP_LOOK[app.id];
  const Icon = look?.icon;
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-center gap-1 focus:outline-none">
      <span
        className="flex items-center justify-center shadow-sm"
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.23,
          background: look?.bg ?? app.color ?? "#8e8e93",
        }}
      >
        {Icon ? <Icon size={size * 0.5} color="#fff" strokeWidth={2.2} /> : <span style={{ fontSize: size * 0.5 }}>{app.icon}</span>}
      </span>
      {label && <span className="max-w-[64px] truncate text-[11px] text-white [text-shadow:0_1px_2px_rgba(0,0,0,.4)]">{app.name}</span>}
    </button>
  );
}

/* ---------------- 各个 App 的内页 ---------------- */

function Empty({ text }) {
  return <p className="px-6 py-16 text-center text-[13px] text-[#8e8e93]">{text}</p>;
}

/** iOS 分组列表那种白底圆角卡片。 */
function Group({ children }) {
  return <div className="mx-4 mb-4 overflow-hidden rounded-[12px] bg-white">{children}</div>;
}
function Row({ children, last, onClick, onDelete }) {
  return (
    <div
      onClick={onClick}
      className={`group relative flex items-start gap-3 px-4 py-2.5 ${onClick ? "cursor-pointer active:bg-[#e5e5ea]" : ""}`}
    >
      {children}
      {onDelete && (
        <button
          type="button"
          aria-label="删掉这条"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute right-2 top-2 hidden rounded-full bg-[#ff3b30] p-1 text-white group-hover:block"
        >
          <X size={10} />
        </button>
      )}
      {!last && <span className="absolute bottom-0 left-4 right-0 h-px bg-[#e5e5ea]" />}
    </div>
  );
}

function Messages({ items, userThread, userName, roleName, onDelete, open, setOpen }) {
  // open: null | "user" | 一条生成的聊天。状态在 IPhone 里 —— 打开对话时要盖住整个 App 页（大标题也收起来）
  if (open) {
    const bubbles = open === "user" ? userThread : parseThread(open.detail);
    const title = open === "user" ? userName || "你" : open.title;
    return (
      <div className="flex h-full flex-col bg-white">
        <div className="flex items-center gap-1 border-b border-[#e5e5ea] bg-[#f9f9f9]/90 px-2 py-2">
          <button type="button" onClick={() => setOpen(null)} className="flex items-center text-[17px] text-[#007aff]">
            <ChevronLeft size={24} />
            信息
          </button>
          <div className="flex flex-1 flex-col items-center pr-14">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-b from-[#a5a5ad] to-[#86868e] text-[15px] font-medium text-white">
              {title.slice(0, 1)}
            </span>
            <span className="mt-0.5 text-[11px] text-[#1c1c1e]">{title}</span>
          </div>
        </div>
        <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
          {open === "user" && (
            <p className="pb-2 text-center text-[11px] text-[#8e8e93]">最近五轮 · 来自真实聊天记录</p>
          )}
          {bubbles.map((b, i) => (
            <div key={i} className={`flex ${b.from === "me" ? "justify-end" : "justify-start"}`}>
              <span
                className={`max-w-[75%] whitespace-pre-wrap break-words rounded-[18px] px-3 py-1.5 text-[15px] leading-snug ${
                  b.from === "me" ? "bg-[#007aff] text-white" : "bg-[#e9e9eb] text-black"
                }`}
              >
                {b.text}
              </span>
            </div>
          ))}
          {!bubbles.length && <Empty text="这个对话是空的" />}
        </div>
      </div>
    );
  }
  const lastUser = userThread.at(-1);
  return (
    <div className="bg-white">
      {userThread.length > 0 && (
        <Row onClick={() => setOpen("user")}>
          <ThreadRow
            name={userName || "你"}
            preview={`${lastUser.from === "me" ? `${roleName}：` : ""}${lastUser.text}`}
            pinned
          />
        </Row>
      )}
      {items.map((it, i) => (
        <Row key={it.id} last={i === items.length - 1} onClick={() => setOpen(it)} onDelete={() => onDelete(it.id)}>
          <ThreadRow name={it.title} sub={it.value} time={it.time} preview={parseThread(it.detail).at(-1)?.text ?? ""} />
        </Row>
      ))}
      {!items.length && !userThread.length && <Empty text="还没有聊天，点右上角刷新" />}
    </div>
  );
}

function ThreadRow({ name, sub, time, preview, pinned }) {
  return (
    <>
      <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#a5a5ad] to-[#86868e] text-[17px] font-medium text-white">
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-black">
            {name}
            {sub && <span className="ml-1 text-[12px] font-normal text-[#8e8e93]">{sub}</span>}
          </span>
          <span className="flex shrink-0 items-center text-[12px] text-[#8e8e93]">
            {pinned ? "置顶" : time}
            <ChevronRight size={14} />
          </span>
        </span>
        <span className="line-clamp-2 text-[13px] leading-snug text-[#8e8e93]">{preview}</span>
      </span>
    </>
  );
}

function ListApp({ appId, items, balance, onDelete }) {
  if (!items.length) return <Empty text="还没有内容，点右上角刷新" />;

  if (appId === "track") {
    return (
      <Group>
        <div className="px-4 py-3">
          {items.map((it, i) => (
            <div key={it.id} className="group relative flex gap-3 pb-4 last:pb-0">
              <span className="flex flex-col items-center">
                <span className="mt-1 h-3 w-3 rounded-full border-2 border-white bg-[#34c759] shadow" />
                {i < items.length - 1 && <span className="w-0.5 flex-1 bg-[#d1d1d6]" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-[#8e8e93]">{it.value || it.time}</span>
                <span className="block text-[15px] font-semibold text-black">{it.title}</span>
                {it.detail && <span className="block text-[13px] leading-snug text-[#3c3c43]">{it.detail}</span>}
              </span>
              <DeleteBtn onClick={() => onDelete(it.id)} />
            </div>
          ))}
        </div>
      </Group>
    );
  }

  const money = appId === "wallet";
  return (
    <>
      {money && (
        <div className="mx-4 mb-4 rounded-[14px] bg-gradient-to-br from-[#1c1c1e] to-[#3a3a3c] px-5 py-5 text-white shadow">
          <p className="text-[12px] opacity-70">余额</p>
          <p className="mt-1 text-[28px] font-semibold tracking-tight">{balance || "—"}</p>
        </div>
      )}
      <Group>
        {items.map((it, i) => {
          const neg = money && /^\s*[-−]/.test(it.value);
          return (
            <Row key={it.id} last={i === items.length - 1} onDelete={() => onDelete(it.id)}>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[15px] text-black">{it.title}</span>
                  {it.value && (
                    <span
                      className={`shrink-0 text-[14px] ${
                        money ? (neg ? "text-black" : "text-[#34c759]") : appId === "shop" || appId === "delivery" ? "font-semibold text-[#ff6a00]" : "text-[#8e8e93]"
                      }`}
                    >
                      {it.value}
                    </span>
                  )}
                </span>
                {it.detail && (
                  <span className={`mt-0.5 block whitespace-pre-wrap text-[13px] leading-snug text-[#3c3c43] ${appId === "favorites" ? "" : "line-clamp-3"}`}>
                    {it.detail}
                  </span>
                )}
                {it.time && <span className="mt-0.5 block text-[11px] text-[#8e8e93]">{it.time}</span>}
              </span>
            </Row>
          );
        })}
      </Group>
    </>
  );
}

function DeleteBtn({ onClick }) {
  return (
    <button
      type="button"
      aria-label="删掉这条"
      onClick={onClick}
      className="absolute right-0 top-0 hidden rounded-full bg-[#ff3b30] p-1 text-white group-hover:block"
    >
      <X size={10} />
    </button>
  );
}

/* ---------------- 手机外壳 ---------------- */

function IPhone({ data, apps, busyApps, onRefresh, onDelete, roleName }) {
  const [open, setOpenApp] = useState(null); // app id
  const [thread, setThread] = useState(null); // 「信息」里打开的那个对话
  const setOpen = (id) => {
    setOpenApp(id);
    setThread(null);
  };
  const [now, setNow] = useState(clock());
  useEffect(() => {
    const t = setInterval(() => setNow(clock()), 20000);
    return () => clearInterval(t);
  }, []);

  const app = apps.find((a) => a.id === open);
  const items = (open && data.apps[open]) || [];
  const busy = open && busyApps.has(open);
  const grid = apps.filter((a) => !DOCK.includes(a.id));
  const dock = DOCK.map((id) => apps.find((a) => a.id === id)).filter(Boolean);

  return (
    <div className="mx-auto w-full max-w-[380px]">
      <div className="rounded-[54px] bg-[#1c1c1e] p-[11px] shadow-[0_0_0_2px_#3a3a3c,0_20px_50px_rgba(0,0,0,.25)]">
        <div
          className="relative flex flex-col overflow-hidden rounded-[44px]"
          style={{ height: "min(780px, 82vh)", minHeight: 560 }}
        >
          {/* 状态栏 + 灵动岛 */}
          <div
            className={`relative z-20 flex h-[50px] shrink-0 items-end justify-between px-7 pb-1.5 text-[15px] font-semibold ${
              open ? "bg-[#f2f2f7] text-black" : "text-white"
            }`}
          >
            <span>{now}</span>
            <span className="absolute left-1/2 top-[11px] h-[30px] w-[100px] -translate-x-1/2 rounded-full bg-black" />
            <span className="flex items-center gap-1">
              <Signal size={15} />
              <Wifi size={15} />
              <BatteryFull size={20} />
            </span>
          </div>

          {!open && (
            <div
              className="absolute inset-0 flex flex-col"
              style={{ background: "linear-gradient(160deg,#4b6cb7 0%,#8e6fb5 45%,#e48b9b 100%)" }}
            >
              <div className="h-[50px]" />
              <div className="grid grid-cols-4 gap-y-5 px-5 pt-6">
                {grid.map((a) => (
                  <AppIcon key={a.id} app={a} onClick={() => setOpen(a.id)} />
                ))}
              </div>
              <div className="flex-1" />
              <p className="pb-3 text-center text-[11px] text-white/80">{roleName} 的 iPhone</p>
              <div className="mx-3 mb-6 flex justify-around rounded-[30px] bg-white/25 px-3 py-3 backdrop-blur-md">
                {dock.map((a) => (
                  <AppIcon key={a.id} app={a} label={false} onClick={() => setOpen(a.id)} />
                ))}
              </div>
            </div>
          )}

          {open === "chat" && thread && (
            <div className="flex min-h-0 flex-1 flex-col pb-5">
              <Messages
                items={items}
                userThread={data.userThread ?? []}
                userName={data.userName}
                roleName={roleName}
                onDelete={(id) => onDelete(open, id)}
                open={thread}
                setOpen={setThread}
              />
            </div>
          )}

          {open && app && !(open === "chat" && thread) && (
            <div className="flex min-h-0 flex-1 flex-col bg-[#f2f2f7]">
              <div className="flex shrink-0 items-center justify-between px-2 pb-1">
                <button type="button" onClick={() => setOpen(null)} className="flex items-center text-[17px] text-[#007aff]">
                  <ChevronLeft size={24} />
                  桌面
                </button>
                <button
                  type="button"
                  onClick={() => onRefresh(app.id)}
                  disabled={busy}
                  aria-label="刷新这个 App"
                  className="p-2 text-[#007aff] disabled:opacity-40"
                >
                  {busy ? <Loader2 size={20} className="animate-spin" /> : <RefreshCw size={20} />}
                </button>
              </div>
              <h3 className="shrink-0 px-4 pb-2 text-[30px] font-bold tracking-tight text-black">{app.name}</h3>
              <div className="min-h-0 flex-1 overflow-y-auto pb-8">
                {open === "chat" ? (
                  <Messages
                    items={items}
                    userThread={data.userThread ?? []}
                    userName={data.userName}
                    roleName={roleName}
                    onDelete={(id) => onDelete(open, id)}
                    open={null}
                    setOpen={setThread}
                  />
                ) : (
                  <ListApp appId={open} items={items} balance={data.walletBalance} onDelete={(id) => onDelete(open, id)} />
                )}
              </div>
            </div>
          )}

          {/* Home 条：点一下回桌面 */}
          <button
            type="button"
            aria-label="回到桌面"
            onClick={() => setOpen(null)}
            className="absolute bottom-2 left-1/2 z-30 h-[5px] w-[134px] -translate-x-1/2 rounded-full bg-black/80"
            style={{ background: open ? "#000" : "#fff" }}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------- 右边：开关和一键生成 ---------------- */

function RoleControls({ role, data, apps, onGenerate, onBooks, generating }) {
  const { updateRole } = useConfig();
  const p = role.phone ?? {};
  const set = (patch) => updateRole(role.id, { phone: { ...p, ...patch } });
  const books = data.bookIds ?? [];
  // 重置会把整台手机换掉，点两下才算数
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return undefined;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);
  const hasContent = Object.values(data.apps ?? {}).some((l) => l?.length);

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => onGenerate(null, "append")} disabled={generating}>
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {hasContent ? " 继续生成" : " 一键生成"}
          </Button>
          {hasContent && (
            <Button
              variant="outline"
              disabled={generating}
              className={confirmReset ? "!border-warn text-warn hover:text-warn" : ""}
              onClick={() => {
                if (!confirmReset) return setConfirmReset(true);
                setConfirmReset(false);
                onGenerate(null, "reset");
              }}
            >
              <RefreshCw size={13} /> {confirmReset ? "再点一次：清空并重新生成" : "重置并重新生成"}
            </Button>
          )}
        </div>
        <p className="text-meta leading-relaxed text-ink-faint">
          一次生成：{apps.filter((a) => data.batch.includes(a.id)).map((a) => a.name).join("、") || "（在下面设置里勾）"}。
          {hasContent && (
            <>
              <br />
              <strong className="text-ink-soft">继续生成</strong>是在原来的手机上接着加：模型会看到已有的条目，往后写新的、不重复，活动轨迹从最后一站接着走。
              <br />
              <strong className="text-ink-soft">重置并重新生成</strong>是把整台手机清空，换成全新的一批（所有 App 都清，不只勾上的那几个）。生成成功才清，失败了旧内容还在。
            </>
          )}
        </p>
      </div>
      {(data.jobs ?? [])
        .filter((j) => j.status === "error")
        .slice(0, 2)
        .map((j) => (
          <ResultNote key={j.id} state="fail" message={`「${j.title}」没生成出来：${j.error}`} />
        ))}

      <div className="grid grid-cols-1 gap-3 border-t border-line pt-5">
        <p className="text-eyebrow uppercase text-ink-faint">
          世界书
          <span className="ml-2 normal-case tracking-normal text-ink-meta">这个角色关联的那几本，勾哪几本带哪几本</span>
        </p>
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

      <div className="grid grid-cols-1 gap-5 border-t border-line pt-5">
        <p className="text-meta text-ink-faint">下面三个开关是这个角色的，改完点底下的「保存」。</p>
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">同步到私聊</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              之后的聊天里，把最近一次查手机的内容压成几行摘要告诉角色，免得它聊着聊着和自己手机里的东西对不上。
              摘要<strong className="text-ink-soft">只进当轮请求、不进存档</strong>
              ，所以不会越攒越多：每轮固定多下面这么多字，过了时效就不再带。
            </span>
          </span>
          <Switch checked={Boolean(p.injectChat)} onChange={(v) => set({ injectChat: v })} label="同步到私聊" />
        </label>
        {p.injectChat && (
          <div className="grid grid-cols-1 gap-6 border-l-2 border-line pl-4 sm:grid-cols-2">
            <NumberField
              label="每轮最多带"
              value={p.injectChars ?? 300}
              min={50}
              max={3000}
              step={50}
              suffix="字"
              hint="中文大约同样多的 token"
              onChange={(v) => set({ injectChars: v })}
            />
            <NumberField
              label="只在生成后多久内带"
              value={p.injectHours ?? 24}
              min={1}
              max={720}
              step={1}
              suffix="小时"
              hint="过了就不带，花费归零"
              onChange={(v) => set({ injectHours: v })}
            />
          </div>
        )}
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">同步到日记待总结</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              每次生成完往日记流水里记一行，角色写日记时能顺带写到手机里的事。要这个角色开着「日记」才有用。
            </span>
          </span>
          <Switch checked={Boolean(p.toDiary)} onChange={(v) => set({ toDiary: v })} label="同步到日记待总结" />
        </label>
        {p.toDiary && !role.memories?.diary?.enabled && (
          <p className="-mt-3 text-meta text-warn">这个角色的日记没开，这条暂时不起作用（在「角色 → 单独配置 → 记忆库」里开）。</p>
        )}
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">允许 /查手机 指令</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              在 iMessage 里发 <code className="mx-1 bg-sunken px-1">/查手机</code> 就按「一键生成」那一组翻一次，结果回你一条消息（不进上下文）。
            </span>
          </span>
          <Switch checked={Boolean(p.command)} onChange={(v) => set({ command: v })} label="允许查手机指令" />
        </label>
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

  const running = (data?.jobs ?? []).filter((j) => j.status === "running");
  useEffect(() => {
    if (!running.length) return undefined;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [running.length, refresh]);

  const builtin = data?.builtin ?? BUILTIN;
  const apps = useMemo(
    () => [...builtin, ...(config.phone?.customApps ?? [])],
    [builtin, config.phone?.customApps]
  );
  // 正在生成的 App：单个刷新的任务标题就是 App 名，一键生成算全部
  const busyApps = useMemo(() => {
    const set = new Set();
    for (const j of running) {
      const hit = apps.find((a) => a.name === j.title);
      if (hit) set.add(hit.id);
      else (config.phone?.batchApps ?? []).forEach((id) => set.add(id));
    }
    return set;
  }, [running, apps, config.phone?.batchApps]);

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
            这里的东西全是模型按人设虚构的、角色自己手机里的内容 —— 和「查岗」（看你的真屏幕）不是一回事。
          </p>
        </Card>
        <SettingsCard builtin={builtin} />
      </>
    );
  }

  return (
    <>
      <Card title={`${roleLabel(role)} 的手机`} desc="点 App 进去看，右上角刷新只生成那一个；一键生成按设置里勾的那几个一起来。">
        {error && <ResultNote state="fail" message={error} />}
        {!data && !error && <p className="text-eyebrow uppercase text-ink-meta">读取中</p>}
        {data && (
          <div className="grid grid-cols-1 items-start gap-10 xl:grid-cols-[380px_minmax(0,1fr)]">
            <IPhone
              data={data}
              apps={apps}
              busyApps={busyApps}
              onRefresh={(id) => generate([id])}
              onDelete={del}
              roleName={role.name}
            />
            <RoleControls
              role={role}
              data={{ ...data, batch: config.phone?.batchApps ?? [] }}
              apps={apps}
              generating={running.length > 0}
              onGenerate={generate}
              onBooks={setBooks}
            />
          </div>
        )}
      </Card>
      <SettingsCard builtin={builtin} />
    </>
  );
}
