import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BatteryFull,
  BookOpen,
  Camera,
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Flashlight,
  Grid3x3,
  Heart,
  Info,
  Loader2,
  Mail,
  MessageCircle,
  Mic,
  Package,
  PenLine,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Plus,
  RotateCw,
  Search,
  Share,
  Signal,
  SquarePen,
  Star,
  UserRound,
  Video,
  Voicemail,
  Wifi,
} from "lucide-react";

/**
 * 查手机里那台 iPhone（数据和生成在 phone.jsx / server/src/phonecheck.js）。
 *
 * 锁屏 → 桌面 → 各个 App。每个 App 照着 iOS 上对应的那个应用画：信息、电话、通讯录、
 * Safari、钱包、地图、备忘录这几个是系统应用的样子，购物和外卖是国内常见的订单页。
 * 列表里点一条弹出操作表（看全文 / 删掉），手机上没有悬停也能删。
 *
 * 尺寸：整机宽度按视口高度算（再封顶 372px），所以电脑上不会比屏幕高，手机上不会撑破。
 * 机身里一律用像素，按 393×852 的屏幕设计，缩小时整体跟着窄一点，排版不变形。
 */

const SF = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif';
const BLUE = "#007aff";

/** 锁屏 / 桌面的壁纸。id 存在 localStorage，phone.jsx 那边挑。 */
export const WALLPAPERS = {
  dusk: {
    name: "暮色",
    css: "radial-gradient(120% 80% at 20% 10%, #f6a7a0 0%, transparent 55%), radial-gradient(120% 90% at 90% 30%, #8e7cf2 0%, transparent 60%), linear-gradient(180deg, #2c2a6b 0%, #5b3f8f 45%, #d9837f 100%)",
  },
  ocean: {
    name: "深海",
    css: "radial-gradient(100% 70% at 80% 0%, #3aa0ff 0%, transparent 60%), radial-gradient(90% 60% at 0% 60%, #0b3c8c 0%, transparent 70%), linear-gradient(180deg, #06162f 0%, #0d3a7a 55%, #1b6fd1 100%)",
  },
  meadow: {
    name: "晨雾",
    css: "radial-gradient(90% 60% at 30% 0%, #fff6e0 0%, transparent 60%), radial-gradient(100% 70% at 100% 70%, #9fd3b6 0%, transparent 65%), linear-gradient(180deg, #e9e4d6 0%, #b8d4c4 55%, #6f9e8a 100%)",
  },
  night: {
    name: "夜",
    css: "radial-gradient(80% 50% at 70% 15%, #3a3f55 0%, transparent 60%), linear-gradient(180deg, #050608 0%, #14161d 60%, #23262f 100%)",
  },
};

/* ================= 小工具 ================= */

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return now;
}
const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const WEEK = "日一二三四五六";

/** `我: …` / `对方: …` 一行一句 → 气泡。认不出前缀的当对方说的。 */
export function parseThread(detail) {
  return String(detail ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(我|对方)\s*[:：]\s*(.*)$/.exec(l);
      return m ? { from: m[1] === "我" ? "me" : "them", text: m[2] } : { from: "them", text: l };
    });
}

/** 拼音首字母（不引词库：拿每个字母的第一个汉字做边界，按 zh-CN 排序规则比）。 */
const PY_BOUNDS = "阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀".split("");
const PY_LETTERS = "ABCDEFGHJKLMNOPQRSTWXYZ".split("");
function initialOf(name) {
  const c = String(name ?? "").trim()[0] ?? "#";
  if (/[a-z]/i.test(c)) return c.toUpperCase();
  if (/[一-鿿]/.test(c)) {
    for (let i = PY_BOUNDS.length - 1; i >= 0; i--) {
      if (c.localeCompare(PY_BOUNDS[i], "zh-CN") >= 0) return PY_LETTERS[i];
    }
  }
  return "#";
}

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

/** 圆形首字头像。iOS 通讯录那种灰渐变；`tint` 给个别 App 换色。 */
function Avatar({ name, size = 40, tint }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: tint ?? "linear-gradient(180deg,#a8adb6,#858a93)",
      }}
    >
      {String(name ?? "?").trim().slice(0, 1) || "?"}
    </span>
  );
}

/** 「今天」「昨天」…… 历史记录分组用，按模型写的 time 粗分。 */
function dayOf(time) {
  const t = String(time ?? "");
  if (/昨天|昨日/.test(t)) return "昨天";
  if (/前天/.test(t)) return "前天";
  if (!t || /今天|刚刚|分钟前|小时前/.test(t) || /^\d{1,2}[:：]\d{2}$/.test(t.trim())) return "今天";
  return "更早";
}

const isMinus = (v) => /^\s*[-−–]/.test(String(v ?? ""));

/* ================= 图标 ================= */

/** 每个内置 App 的图标：照着 iOS 系统应用画，不用品牌 logo。 */
function IconArt({ id }) {
  switch (id) {
    case "chat":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <defs>
            <linearGradient id="g-msg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#67ff81" />
              <stop offset="1" stopColor="#0ac232" />
            </linearGradient>
          </defs>
          <rect width="60" height="60" fill="url(#g-msg)" />
          <path d="M30 13c-10.5 0-19 6.9-19 15.4 0 4.9 2.8 9.2 7.2 12-.4 2.4-1.7 4.6-3.6 6.3 3.6-.2 6.9-1.5 9.4-3.6 1.9.5 3.9.7 6 .7 10.5 0 19-6.9 19-15.4S40.5 13 30 13z" fill="#fff" />
        </svg>
      );
    case "call":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <defs>
            <linearGradient id="g-call" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#67ff81" />
              <stop offset="1" stopColor="#0ac232" />
            </linearGradient>
          </defs>
          <rect width="60" height="60" fill="url(#g-call)" />
          <path d="M22.6 15.5c.9-.3 1.9 0 2.4.8l3.1 5c.5.8.4 1.9-.3 2.6l-2.4 2.3c1.6 3.4 4.3 6.1 7.7 7.7l2.3-2.4c.7-.7 1.8-.8 2.6-.3l5 3.1c.8.5 1.1 1.5.8 2.4l-1.2 3.5c-.4 1.2-1.6 1.9-2.8 1.8C27.6 41 19 32.4 18 20.2c-.1-1.2.6-2.4 1.8-2.8l2.8-1.9z" fill="#fff" />
        </svg>
      );
    case "contacts":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <defs>
            <linearGradient id="g-ct" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f2f2f5" />
              <stop offset="1" stopColor="#c9c9cf" />
            </linearGradient>
          </defs>
          <rect width="60" height="60" fill="url(#g-ct)" />
          <circle cx="30" cy="24" r="8.5" fill="#8d8d95" />
          <path d="M14.5 46c1.6-8 8-12.4 15.5-12.4S43.9 38 45.5 46z" fill="#8d8d95" />
        </svg>
      );
    case "browser":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#fff" />
          <defs>
            <linearGradient id="g-saf" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1ad6fd" />
              <stop offset="1" stopColor="#1e5bf0" />
            </linearGradient>
          </defs>
          <circle cx="30" cy="30" r="22" fill="url(#g-saf)" />
          {Array.from({ length: 24 }).map((_, i) => (
            <rect key={i} x="29.5" y="9.5" width="1" height={i % 2 ? 2 : 3.5} fill="#fff" opacity=".85" transform={`rotate(${i * 15} 30 30)`} />
          ))}
          <path d="M30 30l11-11-6 17z" fill="#ff3b30" />
          <path d="M30 30L19 41l6-17z" fill="#fff" />
        </svg>
      );
    case "wallet":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#111" />
          <rect x="11" y="15" width="38" height="12" rx="3" fill="#4fb3ff" />
          <rect x="11" y="21" width="38" height="12" rx="3" fill="#ffcc00" />
          <rect x="11" y="27" width="38" height="12" rx="3" fill="#ff6b3d" />
          <path d="M9 33h42v11a4 4 0 01-4 4H13a4 4 0 01-4-4z" fill="#2c2c2e" />
          <path d="M9 33h14c1 3 3.6 4.6 7 4.6s6-1.6 7-4.6h14" stroke="#3a3a3c" strokeWidth="1.2" fill="none" />
        </svg>
      );
    case "track":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#e9f3e1" />
          <path d="M0 40l60-18v9L0 49z" fill="#ffd76a" />
          <path d="M18 0h7l17 60h-7z" fill="#fff" />
          <rect x="34" y="4" width="20" height="14" rx="3" fill="#bfe3a8" />
          <path d="M0 0h14v20C8 22 3 18 0 14z" fill="#a8d5f5" />
          <path d="M30 17c-5 0-8.6 3.7-8.6 8.4 0 6.2 8.6 14.6 8.6 14.6s8.6-8.4 8.6-14.6C38.6 20.7 35 17 30 17z" fill="#ff3b30" />
          <circle cx="30" cy="25.5" r="3.4" fill="#fff" />
        </svg>
      );
    case "favorites":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#fff" />
          <rect width="60" height="17" fill="#ffd54a" />
          <rect y="17" width="60" height="1.5" fill="#e6b800" opacity=".5" />
          {[27, 35, 43, 51].map((y) => (
            <rect key={y} x="9" y={y} width="42" height="1.2" fill="#d6d6db" />
          ))}
          <circle cx="9" cy="9" r="1.6" fill="#b38600" opacity=".35" />
        </svg>
      );
    case "shop":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <defs>
            <linearGradient id="g-shop" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ff9a3d" />
              <stop offset="1" stopColor="#ff4f00" />
            </linearGradient>
          </defs>
          <rect width="60" height="60" fill="url(#g-shop)" />
          <path d="M18 23h24l-2.2 20.5a3 3 0 01-3 2.5H23.2a3 3 0 01-3-2.5z" fill="#fff" />
          <path d="M24.5 26v-4a5.5 5.5 0 0111 0v4" stroke="#ff6a00" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "delivery":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#ffd100" />
          <circle cx="20" cy="41" r="5" fill="none" stroke="#1c1c1e" strokeWidth="3" />
          <circle cx="42" cy="41" r="5" fill="none" stroke="#1c1c1e" strokeWidth="3" />
          <path d="M20 41l7-13h9l6 13M27 28l-3-6h-5" stroke="#1c1c1e" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="33" y="17" width="12" height="9" rx="1.5" fill="#1c1c1e" />
        </svg>
      );
    default:
      return null;
  }
}

export function AppIcon({ app, size = 60, label = true, onClick, badge = 0, dark = false }) {
  const builtin = IconArt({ id: app.id });
  return (
    <button type="button" onClick={onClick} className="relative flex flex-col items-center gap-[5px] outline-none active:opacity-70">
      <span
        className="relative flex items-center justify-center overflow-hidden"
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.225,
          background: builtin ? undefined : `linear-gradient(180deg, ${app.color ?? "#8e8e93"}dd, ${app.color ?? "#8e8e93"})`,
          boxShadow: "0 1px 3px rgba(0,0,0,.18)",
        }}
      >
        {builtin ?? <span style={{ fontSize: size * 0.5, lineHeight: 1 }}>{app.icon || "📱"}</span>}
      </span>
      {badge > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-[#ff3b30] px-1.5 text-[12px] font-semibold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {label && (
        <span
          className={`max-w-[72px] truncate text-[11.5px] ${dark ? "text-black" : "text-white [text-shadow:0_1px_3px_rgba(0,0,0,.35)]"}`}
        >
          {app.name}
        </span>
      )}
    </button>
  );
}

/* ================= 通用的 App 外壳 ================= */

function RefreshBtn({ busy, onClick, color = BLUE }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} aria-label="刷新这个 App" className="p-1.5 disabled:opacity-50" style={{ color }}>
      {busy ? <Loader2 size={21} className="animate-spin" /> : <RotateCw size={20} strokeWidth={2.2} />}
    </button>
  );
}

/** iOS 的大标题页面：顶部一行（左右按钮），下面大标题，再下面是滚动内容。 */
function Screen({ title, left, right, children, bg = "#f2f2f7", large = true, footer, sub, accent = BLUE }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: bg }}>
      <div className="flex h-[44px] shrink-0 items-center justify-between px-2" style={{ color: accent }}>
        <div className="flex min-w-0 items-center">{left}</div>
        {!large && <span className="truncate text-[17px] font-semibold text-black">{title}</span>}
        <div className="flex items-center">{right}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none]">
        {large && (
          <div className="px-4 pb-2">
            <h3 className="text-[34px] font-bold leading-tight tracking-[-0.02em] text-black">{title}</h3>
            {sub && <p className="text-[13px] text-[#8e8e93]">{sub}</p>}
          </div>
        )}
        {children}
        <div className="h-8" />
      </div>
      {footer}
    </div>
  );
}

function BackBtn({ label, onClick, color = BLUE }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center text-[17px]" style={{ color }}>
      <ChevronLeft size={28} strokeWidth={2.4} className="-mr-1" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function SearchField({ placeholder = "搜索" }) {
  return (
    <div className="mx-4 mb-3 flex h-9 items-center gap-1.5 rounded-[10px] bg-[#767680]/[0.12] px-2 text-[17px] text-[#8e8e93]">
      <Search size={16} />
      <span>{placeholder}</span>
      <Mic size={16} className="ml-auto" />
    </div>
  );
}

function EmptyState({ text, onRefresh, busy }) {
  return (
    <div className="flex flex-col items-center px-8 pt-20 text-center">
      <p className="text-[20px] font-semibold text-black">{text}</p>
      <p className="mt-1 text-[14px] text-[#8e8e93]">TA 的这个 App 还没翻过</p>
      <button type="button" disabled={busy} onClick={onRefresh} className="mt-4 text-[17px] text-[#007aff] disabled:opacity-50">
        {busy ? "生成中…" : "生成内容"}
      </button>
    </div>
  );
}

/** 白底圆角分组（inset grouped）。 */
function Grouped({ children, className = "" }) {
  return <div className={`mx-4 overflow-hidden rounded-[10px] bg-white ${className}`}>{children}</div>;
}

function Cell({ children, onClick, last, inset = 16 }) {
  return (
    <div onClick={onClick} className={`relative flex items-center gap-3 px-4 py-[11px] ${onClick ? "cursor-pointer active:bg-[#d1d1d6]" : ""}`}>
      {children}
      {!last && <span className="absolute bottom-0 right-0 h-px bg-[#c6c6c8]/60" style={{ left: inset }} />}
    </div>
  );
}

/** 点一条弹出来的 iOS 操作表：上面是全文，下面「删除」「取消」。 */
function ActionSheet({ item, appName, onDelete, onClose }) {
  if (!item) return null;
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end bg-black/30 p-2 pb-6" onClick={onClose}>
      <div className="mb-2 max-h-[70%] overflow-hidden rounded-[14px] bg-white/95 backdrop-blur" onClick={(e) => e.stopPropagation()}>
        <div className="max-h-[52vh] overflow-y-auto px-4 py-3 text-center [scrollbar-width:none]">
          <p className="text-[13px] font-semibold text-[#8e8e93]">{appName}</p>
          <p className="mt-1 text-[15px] font-semibold text-black">{item.title}</p>
          {item.value && <p className="text-[13px] text-[#8e8e93]">{item.value}</p>}
          {item.detail && <p className="mt-2 whitespace-pre-wrap text-left text-[14px] leading-relaxed text-[#3c3c43]">{item.detail}</p>}
          {item.time && <p className="mt-2 text-[12px] text-[#8e8e93]">{item.time}</p>}
        </div>
        <button
          type="button"
          onClick={() => {
            onDelete(item.id);
            onClose();
          }}
          className="w-full border-t border-[#c6c6c8]/70 py-3.5 text-[19px] text-[#ff3b30] active:bg-[#e5e5ea]"
        >
          删除这条记录
        </button>
      </div>
      <button type="button" onClick={onClose} className="rounded-[14px] bg-white py-3.5 text-[19px] font-semibold text-[#007aff] active:bg-[#e5e5ea]">
        取消
      </button>
    </div>
  );
}

/* ================= 信息 ================= */

function MessagesApp({ items, ctx }) {
  const [open, setOpen] = useState(null); // "user" | item
  const { userThread = [], userName, roleName } = ctx;

  if (open) {
    const isUser = open === "user";
    const bubbles = isUser ? userThread : parseThread(open.detail);
    const name = isUser ? userName || "你" : open.title;
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-white">
        <div className="flex shrink-0 items-start justify-between border-b border-[#c6c6c8]/50 bg-[#f6f6f6]/95 px-1 pb-1.5">
          <BackBtn label="" onClick={() => setOpen(null)} />
          <div className="-ml-6 flex flex-col items-center">
            <Avatar name={name} size={44} tint={!isUser && open.real ? "linear-gradient(180deg,#9fb7ff,#6f8de8)" : undefined} />
            <span className="mt-0.5 flex items-center text-[11.5px] text-black">
              {name}
              <ChevronRight size={11} className="text-[#8e8e93]" />
            </span>
          </div>
          <Video size={24} className="mr-3 mt-2 text-[#007aff]" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 [scrollbar-width:none]">
          <p className="py-2 text-center text-[11px] text-[#8e8e93]">
            iMessage 信息
            <br />
            {isUser ? "最近五轮 · 真实聊天记录" : open.time || "今天"}
          </p>
          {bubbles.map((b, i) => {
            const me = b.from === "me";
            const tail = bubbles[i + 1]?.from !== b.from;
            return (
              <div key={i} className={`flex ${me ? "justify-end" : "justify-start"} ${tail ? "mb-2" : "mb-[2px]"}`}>
                <span
                  className={`max-w-[76%] whitespace-pre-wrap break-words px-3 py-[7px] text-[16px] leading-[1.3] ${
                    me ? "bg-[#007aff] text-white" : "bg-[#e9e9eb] text-black"
                  }`}
                  style={{
                    borderRadius: 18,
                    ...(tail ? (me ? { borderBottomRightRadius: 5 } : { borderBottomLeftRadius: 5 }) : {}),
                  }}
                >
                  {b.text}
                </span>
              </div>
            );
          })}
          {bubbles.at(-1)?.from === "me" && <p className="-mt-1 pr-1 text-right text-[11px] text-[#8e8e93]">已送达</p>}
          {!isUser && (
            <button type="button" onClick={() => (ctx.onDelete(open.id), setOpen(null))} className="mx-auto mt-6 block text-[13px] text-[#ff3b30]">
              删除这段对话
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-[#c6c6c8]/40 bg-white px-2.5 py-2 pb-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e9e9eb] text-[#8e8e93]">
            <Plus size={20} />
          </span>
          <span className="flex h-8 flex-1 items-center rounded-full border border-[#c6c6c8] px-3 text-[15px] text-[#c7c7cc]">
            iMessage 信息
            <Mic size={16} className="ml-auto text-[#8e8e93]" />
          </span>
        </div>
      </div>
    );
  }

  const last = userThread.at(-1);
  return (
    <Screen
      title="信息"
      left={<span className="px-2 text-[17px]">编辑</span>}
      right={
        <>
          <RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} />
          <SquarePen size={22} className="mx-2" />
        </>
      }
      bg="#fff"
    >
      <SearchField />
      {userThread.length > 0 && (
        <button type="button" onClick={() => setOpen("user")} className="mx-auto mb-2 flex flex-col items-center px-4">
          <span className="relative">
            <Avatar name={userName || "你"} size={76} />
            <span className="absolute -top-2 left-1/2 max-w-[120px] -translate-x-1/2 truncate rounded-[12px] bg-[#e9e9eb] px-2 py-1 text-[11px] text-[#3c3c43] shadow-sm">
              {last?.text}
            </span>
          </span>
          <span className="mt-1 text-[12px] text-black">{userName || "你"}</span>
        </button>
      )}
      {!items.length && !userThread.length && <EmptyState text="没有信息" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      <div>
        {items.map((it, i) => {
          const preview = parseThread(it.detail).at(-1);
          const unread = ctx.isNew(it);
          return (
            <div key={it.id} onClick={() => setOpen(it)} className="relative flex cursor-pointer gap-3 py-[9px] pl-[22px] pr-4 active:bg-[#e5e5ea]">
              {unread && <span className="absolute left-[7px] top-1/2 h-[10px] w-[10px] -translate-y-1/2 rounded-full bg-[#007aff]" />}
              <Avatar name={it.title} size={46} tint={it.real ? "linear-gradient(180deg,#9fb7ff,#6f8de8)" : undefined} />
              <div className="relative min-w-0 flex-1 pb-[9px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[16px] font-semibold text-black">{it.title}</span>
                  <span className="flex shrink-0 items-center text-[14px] text-[#8e8e93]">
                    {it.time || "昨天"}
                    <ChevronRight size={14} />
                  </span>
                </div>
                <p className="line-clamp-2 text-[14.5px] leading-[1.3] text-[#8e8e93]">
                  {preview ? `${preview.from === "me" ? "" : ""}${preview.text}` : it.value}
                </p>
                {i < items.length - 1 && <span className="absolute -bottom-[9px] left-0 right-[-16px] h-px bg-[#c6c6c8]/60" />}
              </div>
            </div>
          );
        })}
      </div>
      {roleName && items.length > 0 && <p className="pt-4 text-center text-[11px] text-[#c7c7cc]">{roleName} 的 iMessage</p>}
    </Screen>
  );
}

/* ================= 电话 / 通讯录 ================= */

function callKind(v) {
  const s = String(v ?? "");
  if (/未接|拒接|missed/i.test(s)) return "missed";
  if (/呼出|拨出|out/i.test(s)) return "out";
  return "in";
}

function RecentsList({ items, ctx, onPick }) {
  const [tab, setTab] = useState("all");
  const list = tab === "missed" ? items.filter((x) => callKind(x.value) === "missed") : items;
  return (
    <Screen
      title="最近通话"
      left={<span className="px-2 text-[17px]">编辑</span>}
      right={<RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} />}
      bg="#fff"
      large
    >
      <div className="mx-auto mb-3 flex w-[200px] rounded-[9px] bg-[#767680]/[0.12] p-[2px] text-[13px] font-medium">
        {[
          ["all", "全部"],
          ["missed", "未接来电"],
        ].map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`flex-1 rounded-[7px] py-1 ${tab === k ? "bg-white shadow-[0_1px_3px_rgba(0,0,0,.15)]" : ""}`}
          >
            {l}
          </button>
        ))}
      </div>
      {!items.length && <EmptyState text="没有最近通话" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      {list.map((it, i) => {
        const k = callKind(it.value);
        const Icon = k === "missed" ? PhoneMissed : k === "out" ? PhoneOutgoing : PhoneIncoming;
        return (
          <div key={it.id} onClick={() => onPick(it)} className="relative flex cursor-pointer items-center gap-3 py-2 pl-4 pr-3 active:bg-[#e5e5ea]">
            <Avatar name={it.title} size={40} />
            <div className="min-w-0 flex-1">
              <p className={`truncate text-[17px] ${k === "missed" ? "text-[#ff3b30]" : "text-black"}`}>{it.title}</p>
              <p className="flex items-center gap-1 text-[14px] text-[#8e8e93]">
                <Icon size={12} />
                <span className="truncate">{String(it.value || "").replace(/^(呼入|呼出|未接)\s*/, "") || (k === "missed" ? "未接来电" : "手机")}</span>
              </p>
            </div>
            <span className="text-[15px] text-[#8e8e93]">{it.time}</span>
            <Info size={22} className="text-[#007aff]" />
            {i < list.length - 1 && <span className="absolute bottom-0 left-[68px] right-0 h-px bg-[#c6c6c8]/60" />}
          </div>
        );
      })}
    </Screen>
  );
}

function ContactCard({ it, onBack, onDelete, backLabel }) {
  return (
    <Screen title="" large={false} left={<BackBtn label={backLabel} onClick={onBack} />} bg="#f2f2f7">
      <div className="flex flex-col items-center px-4 pb-4 pt-2">
        <Avatar name={it.title} size={96} tint={it.real ? "linear-gradient(180deg,#9fb7ff,#6f8de8)" : undefined} />
        <p className="mt-3 text-[28px] font-semibold text-black">{it.title}</p>
        {it.value && <p className="text-[15px] text-[#8e8e93]">{it.value}</p>}
        <div className="mt-4 grid w-full grid-cols-4 gap-2">
          {[
            [MessageCircle, "信息"],
            [Phone, "呼叫"],
            [Video, "视频"],
            [Mail, "邮件"],
          ].map(([I, l]) => (
            <span key={l} className="flex flex-col items-center gap-1 rounded-[10px] bg-white py-2 text-[11px] text-[#007aff]">
              <I size={20} fill={l === "邮件" ? "none" : "#007aff"} strokeWidth={l === "邮件" ? 2 : 0} />
              {l}
            </span>
          ))}
        </div>
      </div>
      <Grouped className="mb-4">
        <Cell last>
          <div className="min-w-0">
            <p className="text-[13px] text-black">备注</p>
            <p className="whitespace-pre-wrap text-[15px] leading-snug text-[#3c3c43]">{it.detail || "—"}</p>
          </div>
        </Cell>
      </Grouped>
      {it.real && <p className="mb-4 px-8 text-center text-[12px] text-[#8e8e93]">这是 Uranus 里真实存在的另一个角色</p>}
      <Grouped>
        <Cell last onClick={() => (onDelete(it.id), onBack())}>
          <span className="text-[17px] text-[#ff3b30]">删除联系人</span>
        </Cell>
      </Grouped>
    </Screen>
  );
}

function ContactsList({ items, ctx, onPick, title = "通讯录" }) {
  const groups = useMemo(() => {
    const sorted = [...items].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    const map = new Map();
    for (const it of sorted) {
      const k = initialOf(it.title);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)));
  }, [items]);
  return (
    <Screen
      title={title}
      left={<span className="px-2 text-[17px]">列表</span>}
      right={
        <>
          <RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} />
          <Plus size={24} className="mx-1.5" />
        </>
      }
      bg="#fff"
    >
      <SearchField />
      <div className="flex items-center gap-3 border-b border-[#c6c6c8]/60 px-4 pb-3">
        <Avatar name={ctx.roleName} size={60} />
        <div>
          <p className="text-[20px] font-semibold text-black">{ctx.roleName}</p>
          <p className="text-[13px] text-[#8e8e93]">我的名片</p>
        </div>
      </div>
      {!items.length && <EmptyState text="没有联系人" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      <div className="relative pr-5">
        {groups.map(([letter, list]) => (
          <div key={letter}>
            <p className="sticky top-0 bg-white px-4 pb-0.5 pt-2 text-[13px] font-semibold text-[#8e8e93]">{letter}</p>
            {list.map((it, i) => (
              <div key={it.id} onClick={() => onPick(it)} className="relative cursor-pointer px-4 py-[10px] active:bg-[#e5e5ea]">
                <span className="text-[17px] text-black">{it.title}</span>
                {it.value && <span className="ml-2 text-[13px] text-[#8e8e93]">{it.value}</span>}
                {i < list.length - 1 && <span className="absolute bottom-0 left-4 right-0 h-px bg-[#c6c6c8]/60" />}
              </div>
            ))}
          </div>
        ))}
        {groups.length > 0 && (
          <div className="absolute right-1 top-2 flex flex-col items-center text-[10px] font-semibold leading-[14px] text-[#007aff]">
            {groups.map(([l]) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        )}
      </div>
    </Screen>
  );
}

function PhoneTabBar({ tab, setTab }) {
  const tabs = [
    ["fav", Star, "个人收藏"],
    ["recents", Clock, "最近通话"],
    ["contacts", UserRound, "通讯录"],
    ["keypad", Grid3x3, "拨号键盘"],
    ["voicemail", Voicemail, "语音留言"],
  ];
  return (
    <div className="flex shrink-0 justify-around border-t border-[#c6c6c8]/60 bg-[#f9f9f9]/95 pb-5 pt-1.5">
      {tabs.map(([k, I, l]) => (
        <button
          key={k}
          type="button"
          onClick={() => (k === "recents" || k === "contacts") && setTab(k)}
          className={`flex flex-col items-center gap-0.5 text-[10px] ${tab === k ? "text-[#007aff]" : "text-[#999]"}`}
        >
          <I size={24} fill={tab === k && (k === "fav" || k === "contacts") ? "#007aff" : "none"} strokeWidth={tab === k ? 2.2 : 1.8} />
          {l}
        </button>
      ))}
    </div>
  );
}

/** 「电话」：最近通话 + 通讯录两个标签，和 iPhone 上一样在同一个 App 里。 */
function PhoneApp({ items, ctx, contactsCtx, sheet }) {
  const [tab, setTab] = useState("recents");
  const [card, setCard] = useState(null);
  if (card) return <ContactCard it={card} backLabel="通讯录" onBack={() => setCard(null)} onDelete={contactsCtx.onDelete} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab === "recents" ? (
        <RecentsList items={items} ctx={ctx} onPick={sheet} />
      ) : (
        <ContactsList items={contactsCtx.items} ctx={contactsCtx} onPick={setCard} />
      )}
      <PhoneTabBar tab={tab} setTab={setTab} />
    </div>
  );
}

function ContactsApp({ items, ctx }) {
  const [card, setCard] = useState(null);
  if (card) return <ContactCard it={card} backLabel="通讯录" onBack={() => setCard(null)} onDelete={ctx.onDelete} />;
  return <ContactsList items={items} ctx={ctx} onPick={setCard} />;
}

/* ================= 购物 / 外卖 ================= */

function orderStatus(detail) {
  const s = String(detail ?? "");
  if (/已签收|已收货|已完成|待评价/.test(s)) return ["review", "交易成功"];
  if (/运输|派送|揽收|已发货|在途|配送/.test(s)) return ["receive", "卖家已发货"];
  if (/待发货|备货|未发货/.test(s)) return ["ship", "等待卖家发货"];
  if (/待付款|未付款/.test(s)) return ["pay", "等待买家付款"];
  return ["review", "交易成功"];
}

const PASTEL = ["#ffe3d3", "#e3efff", "#e9f7e3", "#fff3c9", "#f1e6ff", "#ffe0ea"];

function ShopApp({ items, ctx, sheet, app }) {
  const [tab, setTab] = useState("all");
  const tabs = [
    ["all", "全部"],
    ["pay", "待付款"],
    ["ship", "待发货"],
    ["receive", "待收货"],
    ["review", "待评价"],
  ];
  const color = app.color && app.custom ? app.color : "#ff5000";
  const list = tab === "all" ? items : items.filter((x) => orderStatus(x.detail)[0] === tab);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f4f4f4]">
      <div className="shrink-0 bg-white">
        <div className="flex h-[44px] items-center justify-between px-2">
          <BackBtn label="" onClick={ctx.close} color="#1c1c1e" />
          <span className="text-[17px] font-semibold text-black">{app.custom ? app.name : "我的订单"}</span>
          <RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} color="#1c1c1e" />
        </div>
        <div className="mx-3 mb-2 flex h-8 items-center gap-1.5 rounded-full bg-[#f4f4f4] px-3 text-[13px] text-[#999]">
          <Search size={14} />
          搜索我的订单
        </div>
        <div className="flex justify-around text-[13px]">
          {tabs.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className="relative pb-2 pt-1" style={{ color: tab === k ? "#000" : "#666", fontWeight: tab === k ? 600 : 400 }}>
              {l}
              {tab === k && <span className="absolute bottom-0 left-1/2 h-[3px] w-5 -translate-x-1/2 rounded-full" style={{ background: color }} />}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5 [scrollbar-width:none]">
        {!items.length && <EmptyState text="还没有订单" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {list.map((it, i) => {
          const [k, label] = orderStatus(it.detail);
          return (
            <div key={it.id} onClick={() => sheet(it)} className="mb-2.5 cursor-pointer rounded-[12px] bg-white p-3 active:opacity-80">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-semibold text-black">
                  {it.time ? `下单时间 ${it.time}` : "订单"} <ChevronRight size={12} className="inline text-[#999]" />
                </span>
                <span style={{ color }}>{label}</span>
              </div>
              <div className="mt-2.5 flex gap-2.5">
                <span className="flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-[8px]" style={{ background: PASTEL[i % PASTEL.length] }}>
                  <Package size={30} className="text-black/25" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[14px] leading-snug text-black">{it.title}</p>
                  <p className="mt-1 line-clamp-1 rounded-[4px] bg-[#f6f6f6] px-1.5 py-0.5 text-[12px] text-[#999]">{it.detail}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[14px] font-semibold text-black">{it.value}</p>
                  <p className="text-[12px] text-[#999]">x1</p>
                </div>
              </div>
              <p className="mt-2 text-right text-[13px] text-black">
                实付款 <span className="font-semibold">{it.value}</span>
              </p>
              <div className="mt-2 flex justify-end gap-2 text-[13px]">
                {k === "receive" && <span className="rounded-full border border-[#ccc] px-3 py-1 text-[#333]">查看物流</span>}
                <span className="rounded-full border px-3 py-1" style={{ borderColor: color, color }}>
                  {k === "receive" ? "确认收货" : k === "review" ? "评价" : k === "pay" ? "付款" : "提醒发货"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeliveryApp({ items, ctx, sheet }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f5f5f5]">
      <div className="shrink-0 bg-gradient-to-b from-[#ffd100] to-[#ffe14d] px-2 pb-3">
        <div className="flex h-[44px] items-center justify-between">
          <BackBtn label="" onClick={ctx.close} color="#1c1c1e" />
          <span className="text-[17px] font-semibold text-black">订单</span>
          <RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} color="#1c1c1e" />
        </div>
        <div className="flex gap-5 px-2 text-[15px] text-black">
          <span className="font-semibold">全部</span>
          <span className="opacity-60">待评价</span>
          <span className="opacity-60">退款</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5 [scrollbar-width:none]">
        {!items.length && <EmptyState text="还没有外卖订单" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.map((it) => (
          <div key={it.id} onClick={() => sheet(it)} className="mb-2.5 cursor-pointer rounded-[12px] bg-white p-3 active:opacity-80">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#fff4c2] text-[15px] font-bold text-[#a57800]">
                {it.title.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-black">
                {it.title} <ChevronRight size={13} className="inline text-[#999]" />
              </span>
              <span className="text-[13px] text-[#999]">已送达</span>
            </div>
            <p className="mt-2 line-clamp-2 pl-11 text-[13px] leading-snug text-[#666]">{it.detail}</p>
            <div className="mt-2 flex items-center justify-between pl-11 text-[12px] text-[#999]">
              <span>{it.time}</span>
              <span className="text-[14px] text-black">
                实付 <span className="font-semibold">{it.value}</span>
              </span>
            </div>
            <div className="mt-2.5 flex justify-end gap-2 text-[13px]">
              <span className="rounded-full border border-[#ddd] px-3 py-1 text-[#333]">评价</span>
              <span className="rounded-full bg-[#ffd100] px-3 py-1 font-medium text-black">再来一单</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= Safari ================= */

function BrowserApp({ items, ctx, sheet }) {
  const groups = useMemo(() => {
    const order = ["今天", "昨天", "前天", "更早"];
    const map = new Map(order.map((k) => [k, []]));
    for (const it of items) map.get(dayOf(it.time)).push(it);
    return order.map((k) => [k, map.get(k)]).filter(([, l]) => l.length);
  }, [items]);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f2f2f7]">
      <Screen title="历史记录" left={<span className="px-2 text-[17px]">清除</span>} right={<RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} />} bg="#f2f2f7">
        <SearchField placeholder="搜索历史记录" />
        {!items.length && <EmptyState text="没有浏览记录" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {groups.map(([day, list]) => (
          <div key={day} className="mb-4">
            <p className="px-8 pb-1.5 text-[13px] uppercase text-[#6d6d72]">{day}</p>
            <Grouped>
              {list.map((it, i) => {
                const search = /搜索|search/i.test(it.value) || !it.value;
                return (
                  <Cell key={it.id} onClick={() => sheet(it)} last={i === list.length - 1} inset={60}>
                    <span
                      className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[7px] text-[14px] font-semibold"
                      style={{ background: search ? "#e9e9eb" : `hsl(${hash(it.value) % 360} 55% 92%)`, color: search ? "#8e8e93" : `hsl(${hash(it.value) % 360} 45% 38%)` }}
                    >
                      {search ? <Search size={15} /> : it.value.slice(0, 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[16px] text-black">{it.title}</p>
                      <p className="truncate text-[13px] text-[#8e8e93]">{search ? `搜索 · ${it.detail || it.title}` : `${it.value} — ${it.detail}`}</p>
                    </div>
                  </Cell>
                );
              })}
            </Grouped>
          </div>
        ))}
      </Screen>
      <div className="shrink-0 border-t border-[#c6c6c8]/60 bg-[#f9f9f9]/95 px-3 pb-5 pt-2">
        <div className="mb-2 flex h-10 items-center justify-center gap-1.5 rounded-[12px] bg-white text-[15px] text-[#8e8e93] shadow-[0_1px_4px_rgba(0,0,0,.08)]">
          <Search size={15} />
          搜索或输入网站名称
        </div>
        <div className="flex justify-between px-3 text-[#007aff]">
          <ChevronLeft size={24} />
          <ChevronRight size={24} className="opacity-30" />
          <Share size={22} />
          <BookOpen size={22} />
          <Grid3x3 size={22} />
        </div>
      </div>
    </div>
  );
}

/* ================= 钱包 ================= */

function WalletApp({ items, ctx, sheet }) {
  return (
    <Screen
      title="钱包"
      right={
        <>
          <RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} />
          <span className="mx-1 flex h-8 w-8 items-center justify-center rounded-full bg-[#e5e5ea]">
            <Plus size={19} />
          </span>
        </>
      }
      bg="#f2f2f7"
    >
      {/* 叠起来的卡：后面两张露个边，最前面是余额卡 */}
      <div className="relative mx-4 mb-5 h-[230px]">
        <div className="absolute inset-x-0 top-0 h-[150px] rounded-[14px] bg-gradient-to-br from-[#2f6fde] to-[#1d4aa8] p-4 text-white shadow">
          <p className="text-[13px] font-semibold opacity-90">储蓄卡</p>
        </div>
        <div className="absolute inset-x-0 top-[34px] h-[150px] rounded-[14px] bg-gradient-to-br from-[#e8b04a] to-[#c27c1c] p-4 text-white shadow">
          <p className="text-[13px] font-semibold opacity-90">信用卡 ···· 6688</p>
        </div>
        <div className="absolute inset-x-0 top-[68px] h-[162px] rounded-[14px] bg-gradient-to-br from-[#1c1c1e] to-[#3a3a3c] p-4 text-white shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold">零钱</span>
            <span className="text-[11px] opacity-60">可用余额</span>
          </div>
          <p className="mt-6 text-[34px] font-semibold tracking-tight">{ctx.balance || "¥—"}</p>
          <p className="mt-1 text-[12px] opacity-60">{ctx.roleName}</p>
        </div>
      </div>
      <div className="mb-1.5 flex items-baseline justify-between px-5">
        <p className="text-[20px] font-bold text-black">最近交易</p>
        <span className="text-[15px] text-[#007aff]">全部</span>
      </div>
      {!items.length && <EmptyState text="还没有交易" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      {items.length > 0 && (
        <Grouped>
          {items.map((it, i) => {
            const minus = isMinus(it.value);
            return (
              <Cell key={it.id} onClick={() => sheet(it)} last={i === items.length - 1} inset={64}>
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white"
                  style={{ background: `hsl(${hash(it.title) % 360} 50% 55%)` }}
                >
                  {it.title.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-semibold text-black">{it.title}</p>
                  <p className="truncate text-[13px] text-[#8e8e93]">{it.detail}</p>
                  {it.time && <p className="text-[12px] text-[#8e8e93]">{it.time}</p>}
                </div>
                <span className={`shrink-0 text-[16px] ${minus ? "text-black" : "text-[#34c759]"}`}>{it.value}</span>
                <ChevronRight size={16} className="text-[#c7c7cc]" />
              </Cell>
            );
          })}
        </Grouped>
      )}
    </Screen>
  );
}

/* ================= 地图（活动轨迹） ================= */

/** 路线在画布高度的哪一截。模块级常量：当默认参数写在函数签名里会每次渲染都是新数组，useMemo 白算 */
const APP_BAND = [0.14, 0.4];

/**
 * 一张假地图 + 今天的路线。按 items 的标题做种子，同一批数据每次画出来一样。
 *
 * @param {number} h 画布高度（宽固定 393）。要和容器的长宽比差不多，不然 slice 会把两边裁掉：
 *        App 里是整块屏幕（≈800），小组件是正方形（393）
 * @param {[number, number]} band 路线放在高度的哪一截（App 里底部抽屉会盖住下半截）
 */
function RouteMap({ items, h = 800, band = APP_BAND }) {
  const W = 393;
  const { roads, pts, parks, water } = useMemo(() => {
    const r = rng(hash(items.map((x) => x.title).join("|")) || 7);
    const roads = [];
    for (let y = 30 + r() * 30; y < h; y += 60 + r() * 30) {
      roads.push(`M-10 ${y} C 120 ${y + (r() - 0.5) * 60}, 260 ${y + (r() - 0.5) * 60}, ${W + 10} ${y + (r() - 0.5) * 40}`);
    }
    for (let x = 20 + r() * 30; x < W; x += 70 + r() * 30) {
      roads.push(`M${x} -10 C ${x + (r() - 0.5) * 50} ${h * 0.35}, ${x + (r() - 0.5) * 50} ${h * 0.7}, ${x + (r() - 0.5) * 30} ${h + 10}`);
    }
    const parks = Array.from({ length: Math.round(h / 140) }, () => ({ x: r() * (W - 60), y: r() * (h - 60), w: 40 + r() * 70, h: 30 + r() * 60 }));
    const wy = h * (0.55 + r() * 0.25);
    const water = `M-10 ${wy} C 100 ${wy - 40 + r() * 60}, 240 ${wy + 40 + r() * 60}, ${W + 10} ${wy + r() * 40} L${W + 10} ${h + 10} L-10 ${h + 10} Z`;
    // 一站一个点：第 N 个点 = 第 N 段行程到的地方，从左往右排
    const n = Math.max(1, Math.min(items.length, 10));
    const [top, bottom] = band;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? W / 2 : 60 + (i * (W - 120)) / (n - 1) + (r() - 0.5) * 24;
      const y = h * (top + r() * (bottom - top));
      pts.push([Math.round(x), Math.round(y)]);
    }
    return { roads, pts, parks, water };
  }, [items, h, band]);
  const line = pts.map((p) => p.join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full">
      <rect width={W} height={h} fill="#f3efe6" />
      <path d={water} fill="#a9d4f5" />
      {parks.map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx="10" fill="#cfe8bd" />
      ))}
      {roads.map((d, i) => (
        <g key={i}>
          <path d={d} stroke="#e1dccf" strokeWidth={i === 2 ? 13 : 9} fill="none" />
          <path d={d} stroke={i === 2 ? "#ffd56a" : "#fff"} strokeWidth={i === 2 ? 10 : 6} fill="none" />
        </g>
      ))}
      {items.length > 0 && (
        <>
          <polyline points={line} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={line} fill="none" stroke="#0a84ff" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
          {pts.map(([px, py], i) => {
            const last = i === pts.length - 1;
            return (
              <g key={i}>
                <circle cx={px} cy={py} r={last ? 11 : 9} fill={last ? "#ff3b30" : "#0a84ff"} stroke="#fff" strokeWidth="3" />
                <text x={px} y={py + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">
                  {i + 1}
                </text>
              </g>
            );
          })}
        </>
      )}
    </svg>
  );
}

const WIDGET_BAND = [0.3, 0.6];

function MapsApp({ items, ctx, sheet }) {
  // 轨迹按时间先后排；地图上第 N 个点 = 第 N 站出发的地方，最后一个点是现在在哪
  const where = items.length ? String(items.at(-1).title).split(/→|->|—>/).pop().trim() : "";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <RouteMap items={items} />
      <div className="absolute left-3 top-1 z-10 flex gap-2">
        <button type="button" onClick={ctx.close} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/95 shadow-md">
          <ChevronLeft size={22} className="text-[#1c1c1e]" />
        </button>
      </div>
      <div className="absolute right-3 top-1 z-10 flex flex-col overflow-hidden rounded-[10px] bg-white/95 shadow-md">
        <RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} />
        <span className="border-t border-[#e5e5ea] p-1.5 text-[#007aff]">
          <ArrowUpRight size={20} />
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-10 flex max-h-[56%] flex-col rounded-t-[14px] bg-white shadow-[0_-4px_20px_rgba(0,0,0,.12)]">
        <span className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-full bg-[#c7c7cc]" />
        <div className="shrink-0 px-4 pb-2 pt-2">
          <p className="text-[22px] font-bold text-black">今天</p>
          <p className="text-[13px] text-[#8e8e93]">{items.length ? `${items.length} 段行程 · 现在在 ${where}` : "还没有行程"}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 [scrollbar-width:none]">
          {!items.length && <EmptyState text="今天还没出门" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
          {items.map((it, i) => (
            <div key={it.id} onClick={() => sheet(it)} className="flex cursor-pointer gap-3 active:opacity-70">
              <div className="flex w-6 flex-col items-center">
                <span
                  className="mt-1 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ background: i === items.length - 1 ? "#ff3b30" : "#0a84ff" }}
                >
                  {i + 1}
                </span>
                {i < items.length - 1 && <span className="my-1 w-[2px] flex-1 bg-[#d1d1d6]" />}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <p className="text-[12px] text-[#8e8e93]">{it.value || it.time}</p>
                <p className="text-[16px] font-semibold text-black">{it.title}</p>
                {it.detail && <p className="text-[13.5px] leading-snug text-[#3c3c43]">{it.detail}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================= 备忘录（收藏夹） ================= */

const NOTE_Y = "#e3a500";

function NotesApp({ items, ctx, title = "收藏夹" }) {
  const [open, setOpen] = useState(null);
  const toolbar = (
    <div className="flex shrink-0 items-center justify-between border-t border-[#c6c6c8]/50 bg-[#f9f9f9]/95 px-5 pb-6 pt-2.5" style={{ color: NOTE_Y }}>
      <span className="text-[12px] text-black">{open ? "" : `${items.length} 个备忘录`}</span>
      <div className="flex gap-6">
        {open ? (
          <>
            <Camera size={22} />
            <PenLine size={22} />
          </>
        ) : null}
        <SquarePen size={22} />
      </div>
    </div>
  );
  if (open) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-white">
        <div className="flex h-[44px] shrink-0 items-center justify-between px-2" style={{ color: NOTE_Y }}>
          <BackBtn label={title} onClick={() => setOpen(null)} color={NOTE_Y} />
          <Share size={21} className="mr-2" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:none]">
          <p className="pb-3 text-center text-[13px] text-[#8e8e93]">{open.time || "今天"}</p>
          <p className="text-[26px] font-bold leading-tight text-black">{open.title}</p>
          {open.value && <p className="mt-1 text-[15px]" style={{ color: NOTE_Y }}>{open.value}</p>}
          <p className="mt-3 whitespace-pre-wrap text-[17px] leading-[1.55] text-black">{open.detail}</p>
          <button type="button" onClick={() => (ctx.onDelete(open.id), setOpen(null))} className="mt-10 text-[14px] text-[#ff3b30]">
            删除备忘录
          </button>
        </div>
        {toolbar}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Screen
        title={title}
        left={<BackBtn label="文件夹" onClick={ctx.close} color={NOTE_Y} />}
        right={<RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} color={NOTE_Y} />}
        accent={NOTE_Y}
      >
        <SearchField />
        {!items.length && <EmptyState text="没有备忘录" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.length > 0 && (
          <Grouped>
            {items.map((it, i) => (
              <Cell key={it.id} onClick={() => setOpen(it)} last={i === items.length - 1}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-semibold text-black">{it.title}</p>
                  <p className="truncate text-[14px] text-[#8e8e93]">
                    <span className="text-black/70">{it.time || "今天"}</span>
                    {"  "}
                    {it.detail}
                  </p>
                  {it.value && <p className="mt-0.5 text-[12px]" style={{ color: NOTE_Y }}>{it.value}</p>}
                </div>
              </Cell>
            ))}
          </Grouped>
        )}
      </Screen>
      {toolbar}
    </div>
  );
}

/* ================= 自定义 App ================= */

function FeedApp({ items, ctx, sheet, app }) {
  return (
    <Screen title={app.name} accent={app.color} right={<RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} color={app.color} />} bg="#fff">
      {!items.length && <EmptyState text="还没有动态" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      {items.map((it) => (
        <div key={it.id} onClick={() => sheet(it)} className="flex cursor-pointer gap-3 border-b border-[#efeff4] px-4 py-3 active:bg-[#f5f5f5]">
          <Avatar name={ctx.roleName} size={40} tint={`linear-gradient(180deg, ${app.color}aa, ${app.color})`} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold" style={{ color: app.color }}>
              {ctx.roleName}
            </p>
            {it.title && <p className="text-[13px] text-[#8e8e93]">{it.title}</p>}
            <p className="mt-1 whitespace-pre-wrap text-[15px] leading-snug text-black">{it.detail}</p>
            <div className="mt-2 flex items-center gap-4 text-[13px] text-[#8e8e93]">
              <span>{it.time}</span>
              <span className="ml-auto flex items-center gap-1">
                <Heart size={14} /> {it.value || ""}
              </span>
              <MessageCircle size={14} />
            </div>
          </div>
        </div>
      ))}
    </Screen>
  );
}

function ForumApp({ items, ctx, sheet, app }) {
  return (
    <Screen title={app.name} accent={app.color} right={<RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} color={app.color} />} bg="#f4f4f4">
      {!items.length && <EmptyState text="还没有帖子" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      {items.map((it) => (
        <div key={it.id} onClick={() => sheet(it)} className="mx-3 mb-2 cursor-pointer rounded-[10px] bg-white p-3 active:opacity-80">
          {it.value && (
            <span className="mb-1 inline-block rounded-[4px] px-1.5 py-0.5 text-[11px] text-white" style={{ background: app.color }}>
              {it.value}
            </span>
          )}
          <p className="text-[16px] font-semibold leading-snug text-black">{it.title}</p>
          <p className="mt-1 line-clamp-3 text-[14px] leading-snug text-[#555]">{it.detail}</p>
          <p className="mt-2 text-[12px] text-[#999]">
            楼主 {ctx.roleName} · {it.time}
          </p>
        </div>
      ))}
    </Screen>
  );
}

function NovelApp({ items, ctx, app }) {
  const [open, setOpen] = useState(null);
  if (open) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#f5ecd7]">
        <div className="flex h-[44px] shrink-0 items-center px-2 text-[#7a5c2e]">
          <BackBtn label="目录" onClick={() => setOpen(null)} color="#7a5c2e" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 [scrollbar-width:none]">
          <p className="pb-4 pt-2 text-center font-serif text-[20px] font-bold text-[#3b2f1e]">{open.title}</p>
          <p className="whitespace-pre-wrap font-serif text-[17px] leading-[1.9] text-[#3b2f1e] [text-indent:2em]">{open.detail}</p>
          <button type="button" onClick={() => (ctx.onDelete(open.id), setOpen(null))} className="mt-10 block w-full text-center text-[13px] text-[#b25b3a]">
            删除这一章
          </button>
        </div>
      </div>
    );
  }
  return (
    <Screen title={app.name} accent={app.color} right={<RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} color={app.color} />} bg="#fff">
      {!items.length && <EmptyState text="书架是空的" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      {items.map((it) => (
        <div key={it.id} onClick={() => setOpen(it)} className="flex cursor-pointer gap-3 border-b border-[#efeff4] px-4 py-3 active:bg-[#f5f5f5]">
          <span className="flex h-[72px] w-[54px] shrink-0 items-end rounded-[3px] p-1 text-[10px] text-white shadow" style={{ background: `linear-gradient(160deg, ${app.color}, #222)` }}>
            {app.name}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold text-black">{it.title}</p>
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-[#8e8e93]">{it.detail}</p>
            <p className="mt-1 text-[12px]" style={{ color: app.color }}>
              {it.value}
            </p>
          </div>
        </div>
      ))}
    </Screen>
  );
}

function GenericApp({ items, ctx, sheet, app }) {
  return (
    <Screen title={app.name} accent={app.color} right={<RefreshBtn busy={ctx.busy} onClick={ctx.onRefresh} color={app.color} />}>
      {!items.length && <EmptyState text="还没有内容" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
      {items.length > 0 && (
        <Grouped>
          {items.map((it, i) => (
            <Cell key={it.id} onClick={() => sheet(it)} last={i === items.length - 1}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[16px] text-black">{it.title}</p>
                  {it.value && <span className="shrink-0 text-[14px] text-[#8e8e93]">{it.value}</span>}
                </div>
                <p className="line-clamp-2 text-[14px] leading-snug text-[#8e8e93]">{it.detail}</p>
              </div>
              <ChevronRight size={16} className="text-[#c7c7cc]" />
            </Cell>
          ))}
        </Grouped>
      )}
    </Screen>
  );
}

/* ================= 锁屏 / 桌面 ================= */

function LockScreen({ now, wallpaper, notes, onUnlock }) {
  return (
    <div className="absolute inset-0 z-10 flex cursor-pointer flex-col" style={{ background: wallpaper }} onClick={onUnlock}>
      <div className="h-[54px]" />
      <div className="text-center text-white [text-shadow:0_1px_8px_rgba(0,0,0,.15)]">
        <p className="text-[17px] font-semibold opacity-90">
          {now.getMonth() + 1}月{now.getDate()}日 星期{WEEK[now.getDay()]}
        </p>
        <p className="-mt-1 text-[88px] font-semibold leading-none tracking-[-0.03em]" style={{ fontFamily: SF }}>
          {hhmm(now)}
        </p>
      </div>
      <div className="mt-auto space-y-2 px-3 pb-3">
        {notes.length > 0 && <p className="px-1 text-[13px] font-semibold text-white/80">通知中心</p>}
        {notes.map((n) => (
          <div key={n.key} className="flex gap-2.5 rounded-[18px] bg-white/55 px-3 py-2.5 backdrop-blur-xl">
            <span className="mt-0.5 h-[34px] w-[34px] shrink-0 overflow-hidden rounded-[8px]">
              <AppIcon app={n.app} size={34} label={false} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[14px] font-semibold text-black">{n.app.id === "chat" ? n.item.title : n.app.name}</span>
                <span className="shrink-0 text-[12px] text-black/50">{n.item.time || "现在"}</span>
              </div>
              <p className="line-clamp-2 text-[13.5px] leading-snug text-black/80">{n.text}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-12 pb-9">
        <span className="flex h-[50px] w-[50px] items-center justify-center rounded-full bg-black/25 text-white backdrop-blur">
          <Flashlight size={22} />
        </span>
        <span className="text-[13px] text-white/85">点一下解锁</span>
        <span className="flex h-[50px] w-[50px] items-center justify-center rounded-full bg-black/25 text-white backdrop-blur">
          <Camera size={22} />
        </span>
      </div>
    </div>
  );
}

function Widgets({ now, track, roleName }) {
  const where = track.length ? String(track.at(-1).title).split(/→|->|—>/).pop().trim() : "";
  return (
    <div className="grid grid-cols-2 gap-[18px] px-[22px] pt-3">
      <div className="h-[150px] rounded-[22px] bg-white p-3.5 shadow-[0_2px_8px_rgba(0,0,0,.08)]">
        <p className="text-[12px] font-semibold uppercase text-[#ff3b30]">星期{WEEK[now.getDay()]}</p>
        <p className="text-[44px] font-light leading-none text-black">{now.getDate()}</p>
        <p className="mt-3 line-clamp-2 text-[12px] leading-snug text-[#3c3c43]">
          {track.length ? `今天去过 ${track.length} 个地方` : "今天没有日程"}
        </p>
      </div>
      <div className="relative h-[150px] overflow-hidden rounded-[22px] shadow-[0_2px_8px_rgba(0,0,0,.08)]">
        <RouteMap items={track} h={393} band={WIDGET_BAND} />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/90 to-transparent px-3 pb-2.5 pt-6">
          <p className="text-[11px] text-[#8e8e93]">{roleName} 现在在</p>
          <p className="truncate text-[13px] font-semibold text-black">{where || "未知位置"}</p>
        </div>
      </div>
      <p className="col-span-1 -mt-3 text-center text-[11.5px] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.35)]">日历</p>
      <p className="col-span-1 -mt-3 text-center text-[11.5px] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.35)]">地图</p>
    </div>
  );
}

/* ================= 整机 ================= */

/** 放在 Dock 里的四个。 */
const DOCK = ["call", "chat", "browser", "favorites"];

/**
 * @param {object} props
 * @param {object} props.data       /api/phone/:roleId 的 state
 * @param {object[]} props.apps     [{id, name, custom?, icon?, color?, layout?}]
 * @param {Set<string>} props.busyApps 正在生成的 App
 * @param {(appId: string) => void} props.onRefresh
 * @param {(appId: string, itemId: string) => void} props.onDelete
 */
export function IPhone({ data, apps, busyApps, onRefresh, onDelete, roleName, roleId, wallpaper = "dusk" }) {
  const now = useClock();
  const [locked, setLocked] = useState(true);
  const [open, setOpen] = useState(null);
  const [sheet, setSheet] = useState(null); // {app, item}
  const wp = (WALLPAPERS[wallpaper] ?? WALLPAPERS.dusk).css;

  // 「看过了」的时间，按角色 + App 记在 localStorage。比它新的条目算未读：桌面角标、信息里的蓝点
  const seenKey = `uranus.phone.seen.${roleId}`;
  const [seen, setSeen] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(seenKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const markSeen = (id) => {
    const next = { ...seen, [id]: Date.now() };
    setSeen(next);
    try {
      localStorage.setItem(seenKey, JSON.stringify(next));
    } catch {
      /* 存不进就算了 */
    }
  };
  const roleRef = useRef(roleId);
  useEffect(() => {
    if (roleRef.current === roleId) return;
    roleRef.current = roleId;
    setLocked(true);
    setOpen(null);
    try {
      setSeen(JSON.parse(localStorage.getItem(seenKey) ?? "{}"));
    } catch {
      setSeen({});
    }
  }, [roleId, seenKey]);

  const itemsOf = (id) => data.apps?.[id] ?? [];
  const newCount = (id) => itemsOf(id).filter((x) => (x.at ?? 0) > (seen[id] ?? 0)).length;

  // 锁屏通知：各个 App 最新的几条，按生成时间排
  const notes = useMemo(() => {
    const out = [];
    // 真手机上通讯录、浏览记录、行程、备忘录不会推通知
    const NOTIFY = new Set(["chat", "call", "shop", "delivery", "wallet"]);
    for (const a of apps.filter((x) => NOTIFY.has(x.id) || x.custom)) {
      for (const it of (data.apps?.[a.id] ?? []).slice(0, 2)) {
        if (a.id === "call" && callKind(it.value) !== "missed") continue;
        const text =
          a.id === "chat"
            ? parseThread(it.detail).at(-1)?.text ?? it.detail
            : a.id === "call"
              ? `未接来电：${it.title}`
              : `${it.title}${it.value ? ` · ${it.value}` : ""}`;
        out.push({ key: `${a.id}-${it.id}`, app: a, item: it, text, at: it.at ?? 0 });
      }
    }
    return out.sort((x, y) => y.at - x.at).slice(0, 4);
  }, [apps, data.apps]);

  const [seenBefore, setSeenBefore] = useState(0);
  const go = (id) => {
    setSeenBefore(seen[id] ?? 0);
    setOpen(id);
    setLocked(false);
    markSeen(id);
  };
  const close = () => setOpen(null);

  const app = apps.find((a) => a.id === open);
  const ctx = {
    busy: open ? busyApps.has(open) : false,
    onRefresh: () => open && onRefresh(open),
    onDelete: (itemId) => open && onDelete(open, itemId),
    close,
    roleName,
    userName: data.userName,
    userThread: data.userThread ?? [],
    balance: data.walletBalance,
    isNew: (it) => (it.at ?? 0) > seenBefore,
  };
  const sheetOpen = (item) => setSheet({ app, item });

  let body = null;
  if (app) {
    const items = itemsOf(app.id);
    const props = { items, ctx, sheet: sheetOpen, app };
    if (app.id === "chat") body = <MessagesApp {...props} />;
    else if (app.id === "call")
      body = (
        <PhoneApp
          {...props}
          contactsCtx={{
            ...ctx,
            items: itemsOf("contacts"),
            busy: busyApps.has("contacts"),
            onRefresh: () => onRefresh("contacts"),
            onDelete: (id) => onDelete("contacts", id),
          }}
        />
      );
    else if (app.id === "contacts") body = <ContactsApp {...props} />;
    else if (app.id === "shop") body = <ShopApp {...props} />;
    else if (app.id === "delivery") body = <DeliveryApp {...props} />;
    else if (app.id === "browser") body = <BrowserApp {...props} />;
    else if (app.id === "wallet") body = <WalletApp {...props} />;
    else if (app.id === "track") body = <MapsApp {...props} />;
    else if (app.id === "favorites") body = <NotesApp {...props} />;
    else if (app.layout === "shop") body = <ShopApp {...props} />;
    else if (app.layout === "feed") body = <FeedApp {...props} />;
    else if (app.layout === "forum") body = <ForumApp {...props} />;
    else if (app.layout === "novel") body = <NovelApp {...props} />;
    else body = <GenericApp {...props} />;
  }

  const onHome = !locked && !open;
  const lightStatus = locked || onHome;
  const grid = apps.filter((a) => !DOCK.includes(a.id));
  const dock = DOCK.map((id) => apps.find((a) => a.id === id)).filter(Boolean);

  return (
    <div className="mx-auto" style={{ width: "min(372px, 100%, calc((100dvh - 150px) * 0.462))" }}>
      <style>{`@keyframes uranusAppIn{from{transform:scale(.9);opacity:0}to{transform:none;opacity:1}}`}</style>
      {/* 机身：钛金属边 + 侧键 */}
      <div
        className="relative rounded-[58px] p-[3px]"
        style={{
          aspectRatio: "393 / 852",
          background: "linear-gradient(145deg,#8d8c91 0%,#3f3e43 18%,#2a292e 50%,#5b5a60 82%,#9a999e 100%)",
          boxShadow: "0 30px 60px -20px rgba(0,0,0,.45), 0 10px 20px -10px rgba(0,0,0,.3)",
        }}
      >
        <span className="absolute -left-[3px] top-[17%] h-[4.2%] w-[4px] rounded-l bg-[#48474c]" />
        <span className="absolute -left-[3px] top-[25%] h-[7%] w-[4px] rounded-l bg-[#48474c]" />
        <span className="absolute -left-[3px] top-[33.5%] h-[7%] w-[4px] rounded-l bg-[#48474c]" />
        <span className="absolute -right-[3px] top-[28%] h-[11%] w-[4px] rounded-r bg-[#48474c]" />
        <div className="h-full rounded-[55px] bg-black p-[10px]">
          <div className="relative flex h-full flex-col overflow-hidden rounded-[46px] bg-black" style={{ fontFamily: SF }}>
            {/* 状态栏 + 灵动岛 */}
            <div
              className={`relative z-30 flex h-[50px] shrink-0 items-center justify-between px-[30px] pt-2 text-[16px] font-semibold ${
                lightStatus ? "text-white" : "text-black"
              }`}
            >
              <span className="w-[54px] text-center">{locked ? "" : hhmm(now)}</span>
              <span className="absolute left-1/2 top-[11px] h-[35px] w-[122px] -translate-x-1/2 rounded-full bg-black" />
              <span className="flex items-center gap-[5px]">
                <Signal size={17} strokeWidth={2.6} />
                <Wifi size={17} strokeWidth={2.6} />
                <BatteryFull size={25} strokeWidth={1.8} />
              </span>
            </div>

            {/* 桌面（一直垫在底下，锁屏和 App 盖在上面） */}
            <div className="absolute inset-0 flex flex-col" style={{ background: wp }}>
              <div className="h-[50px]" />
              <Widgets now={now} track={itemsOf("track")} roleName={roleName} />
              <div className="grid grid-cols-4 gap-y-[22px] px-[18px] pt-[22px]">
                {grid.map((a) => (
                  <AppIcon key={a.id} app={a} onClick={() => go(a.id)} badge={newCount(a.id)} />
                ))}
              </div>
              <div className="flex-1" />
              <div className="mx-auto mb-3 flex h-[30px] items-center gap-1.5 rounded-full bg-white/25 px-3.5 text-[13px] text-white backdrop-blur-md">
                <Search size={13} strokeWidth={2.6} />
                搜索
              </div>
              <div className="mx-[12px] mb-[26px] flex justify-around rounded-[34px] bg-white/30 px-2 py-[14px] backdrop-blur-xl">
                {dock.map((a) => (
                  <AppIcon key={a.id} app={a} label={false} onClick={() => go(a.id)} badge={newCount(a.id)} />
                ))}
              </div>
            </div>

            {/* App */}
            {open && app && (
              <div
                key={open}
                className={`absolute inset-0 z-20 flex flex-col ${open === "track" ? "" : "pt-[50px]"}`}
                style={{
                  animation: "uranusAppIn .22s ease-out",
                  // 状态栏那 50px 露出来的是这个底色，要和 App 顶部接得上
                  background:
                    open === "track"
                      ? "#f3efe6"
                      : open === "delivery"
                        ? "#ffd100"
                        : ["chat", "call", "contacts", "favorites", "shop"].includes(open) || app?.layout === "feed" || app?.layout === "novel"
                          ? "#fff"
                          : "#f2f2f7",
                }}
              >
                {open === "track" && <div className="h-[50px] shrink-0 bg-transparent" />}
                {body}
                <ActionSheet item={sheet?.item} appName={sheet?.app?.name} onDelete={(id) => onDelete(sheet.app.id, id)} onClose={() => setSheet(null)} />
              </div>
            )}

            {locked && <LockScreen now={now} wallpaper={wp} notes={notes} onUnlock={() => setLocked(false)} />}

            {/* Home 条：App 里点一下回桌面；桌面上点一下锁屏 */}
            <button
              type="button"
              aria-label={open ? "回到桌面" : "锁屏"}
              onClick={() => (open ? (setOpen(null), setSheet(null)) : setLocked(true))}
              className="absolute bottom-[8px] left-1/2 z-50 h-[5px] w-[136px] -translate-x-1/2 rounded-full"
              style={{ background: open && open !== "track" ? "#000" : "#fff" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export { DOCK };
