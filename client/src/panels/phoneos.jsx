import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  BookOpen,
  Camera,
  ChevronLeft,
  ChevronRight,
  Clock,
  Ellipsis,
  FileText,
  Flashlight,
  Folder,
  Grid3x3,
  Heart,
  Image as ImageIcon,
  Loader2,
  Mail,
  Maximize2,
  MessageCircle,
  Mic,
  Music2,
  Package,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Play,
  Plus,
  RotateCw,
  Search,
  Share,
  SlidersHorizontal,
  SquarePen,
  Video,
  X,
} from "lucide-react";

/**
 * 查手机里那台 iPhone（数据和生成在 phone.jsx / server/src/phonecheck.js）。
 *
 * 照着用户截的 iOS 27 画的：顶栏标题居中、两边是悬浮的玻璃按钮；底部是悬浮的搜索胶囊 /
 * 标签栏；默认头像是淡紫灰渐变。没截图参考的几个（钱包、地图、Safari）沿用上一版。
 *
 * ── 尺寸 ──
 *
 * 屏幕一律按 393×852（真 iPhone 的点数）排版，整机再按容器宽度**等比缩放**。以前是
 * 跟着容器变窄重新排，手机上一窄就挤成一团；现在在哪儿看都和真手机一个比例。
 * 右上角的按钮可以全屏看。
 */

const SF = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif';
const BLUE = "#007aff";
/** iOS 27 没有照片时的默认头像底色（截图里那种淡紫灰）。 */
const LAV = "linear-gradient(180deg,#b0b9df 0%,#7f89b8 100%)";
const SCREEN_W = 393;
const SCREEN_H = 852;
const BEZEL = 12;
const DEV_W = SCREEN_W + BEZEL * 2;
const DEV_H = SCREEN_H + BEZEL * 2;

/** 预设壁纸。用户也可以在手机「设置 → 墙纸」里传自己的图（按角色存）。 */
export const WALLPAPERS = {
  ocean: {
    name: "海",
    css: "radial-gradient(100% 70% at 80% 0%, #3aa0ff 0%, transparent 60%), radial-gradient(90% 60% at 0% 60%, #0b3c8c 0%, transparent 70%), linear-gradient(180deg, #06162f 0%, #0d3a7a 55%, #1b6fd1 100%)",
  },
  dusk: {
    name: "暮色",
    css: "radial-gradient(120% 80% at 20% 10%, #f6a7a0 0%, transparent 55%), radial-gradient(120% 90% at 90% 30%, #8e7cf2 0%, transparent 60%), linear-gradient(180deg, #2c2a6b 0%, #5b3f8f 45%, #d9837f 100%)",
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

/** 一段话按气泡分隔符拆开（和 iMessage 那头发出去的一样）。 */
function splitSep(text, sep) {
  const t = String(text ?? "");
  if (!sep) return [t.trim()].filter(Boolean);
  return t
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** `我: …` / `对方: …` 一行一句 → 气泡；一句里的分隔符再拆成几个气泡。 */
export function parseThread(detail, sep = "$") {
  const out = [];
  for (const raw of String(detail ?? "").split(/\n+/)) {
    const l = raw.trim();
    if (!l) continue;
    const m = /^(我|对方)\s*[:：]\s*(.*)$/.exec(l);
    const from = m ? (m[1] === "我" ? "me" : "them") : "them";
    for (const t of splitSep(m ? m[2] : l, sep)) out.push({ from, text: t });
  }
  return out;
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

function dayOf(time) {
  const t = String(time ?? "");
  if (/昨天|昨日/.test(t)) return "昨天";
  if (/前天/.test(t)) return "前天";
  if (!t || /今天|刚刚|分钟前|小时前/.test(t) || /^\d{1,2}[:：]\d{2}$/.test(t.trim())) return "今天";
  return "更早";
}
const isMinus = (v) => /^\s*[-−–]/.test(String(v ?? ""));

/* ================= iOS 27 的基本件 ================= */

/**
 * 这一屏是深色的（联系人名片、无痕浏览……），让状态栏换成白字。
 * 只有页面自己知道自己是不是深色，所以由页面报上去，离开时撤回。
 */
function useDarkStatus(ctx, dark) {
  const set = ctx?.setDark;
  useEffect(() => {
    if (!set) return undefined;
    set(dark);
    return () => set(false);
  }, [set, dark]);
}

/** 悬浮玻璃按钮：圆（只放图标）或胶囊（放字）。 */
export function Glass({ children, onClick, dark = false, label, disabled, className = "" }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-full px-[13px] text-[17px] backdrop-blur-xl transition-transform active:scale-95 disabled:opacity-50 ${
        dark
          ? "border border-white/15 bg-white/10 text-white"
          : "border border-white/70 bg-white/80 text-black shadow-[0_2px_12px_rgba(0,0,0,0.08)]"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** 顶栏：左右悬浮按钮、标题居中（iOS 27 不再是左边的大标题）。 */
export function TopBar({ left, title, sub, right, dark = false }) {
  return (
    <div className="grid h-[60px] shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4">
      <div className="flex items-center justify-start gap-2">{left}</div>
      <div className="max-w-[200px] text-center">
        <p className={`truncate text-[17px] font-semibold ${dark ? "text-white" : "text-black"}`}>{title}</p>
        {sub && <p className={`truncate text-[13px] ${dark ? "text-white/60" : "text-[#8e8e93]"}`}>{sub}</p>}
      </div>
      <div className="flex items-center justify-end gap-2">{right}</div>
    </div>
  );
}

export function BackGlass({ onClick, dark }) {
  return (
    <Glass onClick={onClick} dark={dark} label="返回" className="!px-0">
      <ChevronLeft size={26} strokeWidth={2.3} />
    </Glass>
  );
}

function RefreshGlass({ busy, onClick, dark }) {
  return (
    <Glass onClick={onClick} disabled={busy} dark={dark} label="刷新这个 App" className="!px-0">
      {busy ? <Loader2 size={20} className="animate-spin" /> : <RotateCw size={19} strokeWidth={2.3} />}
    </Glass>
  );
}

/** 底部悬浮的搜索胶囊 + 右边一个圆钮。 */
function BottomSearch({ placeholder = "搜索", icon = SquarePen, dark = false }) {
  const Icon = icon;
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-[30px] z-10 flex gap-2.5">
      <div
        className={`flex h-[50px] flex-1 items-center gap-2 rounded-full px-4 text-[17px] backdrop-blur-xl ${
          dark ? "border border-white/10 bg-white/10 text-white/60" : "border border-white/70 bg-white/85 text-[#3c3c43]/70 shadow-[0_4px_18px_rgba(0,0,0,0.1)]"
        }`}
      >
        <Search size={20} strokeWidth={2.3} />
        <span className="flex-1">{placeholder}</span>
        <Mic size={20} />
      </div>
      <span
        className={`flex h-[50px] w-[50px] items-center justify-center rounded-full backdrop-blur-xl ${
          dark ? "border border-white/10 bg-white/10 text-white" : "border border-white/70 bg-white/85 text-black shadow-[0_4px_18px_rgba(0,0,0,0.1)]"
        }`}
      >
        <Icon size={22} />
      </span>
    </div>
  );
}

/** 滚动区：底下留出悬浮栏的位置。 */
export function Scroll({ children, pad = 120, className = "" }) {
  return (
    <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] ${className}`} style={{ paddingBottom: pad }}>
      {children}
    </div>
  );
}

function PersonGlyph({ size }) {
  return (
    <svg viewBox="0 0 40 40" width={size * 0.62} height={size * 0.62}>
      <circle cx="20" cy="14" r="7.6" fill="#fff" />
      <path d="M5.5 37c1.6-8.6 7.4-13 14.5-13s12.9 4.4 14.5 13" fill="#fff" />
    </svg>
  );
}

/** 头像：iOS 27 的淡紫灰。`initials` 时显示名字（两个字的中文名两个字都放）。 */
export function Avatar({ name, size = 44, initials = false, tint }) {
  const n = String(name ?? "").trim();
  let text = "";
  if (initials && n) {
    text = /^[一-鿿]{2}$/.test(n) ? n : /[a-z]/i.test(n[0]) ? n[0].toUpperCase() : n[0];
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * (text.length > 1 ? 0.3 : 0.42), background: tint ?? LAV }}
    >
      {text || <PersonGlyph size={size} />}
    </span>
  );
}

function EmptyState({ text, onRefresh, busy, dark }) {
  return (
    <div className="flex flex-col items-center px-8 pt-24 text-center">
      <p className={`text-[20px] font-semibold ${dark ? "text-white" : "text-black"}`}>{text}</p>
      <p className="mt-1 text-[15px] text-[#8e8e93]">TA 的这个 App 还没翻过</p>
      <button type="button" disabled={busy} onClick={onRefresh} className="mt-5 rounded-full bg-[#007aff] px-5 py-2.5 text-[16px] font-medium text-white disabled:opacity-50">
        {busy ? "生成中…" : "生成内容"}
      </button>
    </div>
  );
}

/** iOS 27 的大圆角分组卡片。 */
export function Card27({ children, className = "", dark = false }) {
  return <div className={`mx-4 overflow-hidden rounded-[26px] ${dark ? "bg-white/[0.07]" : "bg-white"} ${className}`}>{children}</div>;
}

/** 列表一行，分隔线从文字那一列开始（`inset`）。 */
export function Row27({ children, onClick, last, inset = 16, className = "" }) {
  return (
    <div onClick={onClick} className={`relative flex items-center gap-3 px-4 py-[12px] ${onClick ? "cursor-pointer active:bg-black/[0.06]" : ""} ${className}`}>
      {children}
      {!last && <span className="absolute bottom-0 right-4 h-px bg-[#c6c6c8]/60" style={{ left: inset }} />}
    </div>
  );
}

/** 点一条弹出来的操作表：全文 + 删除 + 取消。 */
function ActionSheet({ item, appName, onDelete, onClose, dark }) {
  if (!item) return null;
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end bg-black/35 p-2.5 pb-8" onClick={onClose}>
      <div className={`mb-2 overflow-hidden rounded-[22px] backdrop-blur-xl ${dark ? "bg-[#2c2c2e]/95" : "bg-white/95"}`} onClick={(e) => e.stopPropagation()}>
        <div className="max-h-[440px] overflow-y-auto px-5 py-4 text-center [scrollbar-width:none]">
          <p className="text-[13px] font-semibold text-[#8e8e93]">{appName}</p>
          <p className={`mt-1 text-[16px] font-semibold ${dark ? "text-white" : "text-black"}`}>{item.title}</p>
          {item.value && <p className="text-[14px] text-[#8e8e93]">{item.value}</p>}
          {item.detail && <p className={`mt-2.5 whitespace-pre-wrap text-left text-[15px] leading-relaxed ${dark ? "text-white/85" : "text-[#3c3c43]"}`}>{item.detail}</p>}
          {item.time && <p className="mt-2 text-[13px] text-[#8e8e93]">{item.time}</p>}
        </div>
        <button
          type="button"
          onClick={() => {
            onDelete(item.id);
            onClose();
          }}
          className={`w-full border-t py-4 text-[19px] text-[#ff3b30] ${dark ? "border-white/10" : "border-[#c6c6c8]/70"}`}
        >
          删除这条记录
        </button>
      </div>
      <button type="button" onClick={onClose} className={`rounded-[22px] py-4 text-[19px] font-semibold text-[#007aff] ${dark ? "bg-[#2c2c2e]" : "bg-white"}`}>
        取消
      </button>
    </div>
  );
}

/* ================= 图标（照 iOS 27 的玻璃质感画） ================= */

function GlassShine() {
  return (
    <>
      <defs>
        <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="60" height="60" fill="url(#shine)" opacity=".5" />
    </>
  );
}

function IconArt({ id, skin }) {
  const glassGreen = (
    <defs>
      <linearGradient id="gg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#8be796" />
        <stop offset="1" stopColor="#55c865" />
      </linearGradient>
      <linearGradient id="gw" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" />
        <stop offset="1" stopColor="#e3f7e5" />
      </linearGradient>
    </defs>
  );
  switch (id) {
    case "chat":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          {glassGreen}
          <rect width="60" height="60" fill="url(#gg)" />
          <path d="M30 14c-10.2 0-18.4 6.7-18.4 15 0 4.8 2.7 9 7 11.8-.3 2.3-1.6 4.4-3.4 6 3.5-.2 6.7-1.4 9.1-3.4 1.8.4 3.7.7 5.7.7 10.2 0 18.4-6.7 18.4-15S40.2 14 30 14z" fill="url(#gw)" opacity=".96" />
        </svg>
      );
    case "call":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          {glassGreen}
          <rect width="60" height="60" fill="url(#gg)" />
          <path d="M22.4 15.6c.9-.3 1.9 0 2.4.8l3.1 5c.5.8.4 1.9-.3 2.6l-2.4 2.3c1.6 3.4 4.3 6.1 7.7 7.7l2.3-2.4c.7-.7 1.8-.8 2.6-.3l5 3.1c.8.5 1.1 1.5.8 2.4l-1.2 3.5c-.4 1.2-1.6 1.9-2.8 1.8C27.6 41 19 32.4 18 20.2c-.1-1.2.6-2.4 1.8-2.8z" fill="url(#gw)" opacity=".96" />
        </svg>
      );
    case "contacts":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#d8d6c9" />
          <rect x="52" y="0" width="8" height="20" fill="#56c1fb" />
          <rect x="52" y="20" width="8" height="20" fill="#fd9e2a" />
          <rect x="52" y="40" width="8" height="20" fill="#66d97a" />
          <circle cx="26" cy="30" r="17" fill="#a29e91" />
          <circle cx="26" cy="25" r="7" fill="#fff" />
          <path d="M14 41.5c2.6-5 6.9-7.6 12-7.6s9.4 2.6 12 7.6c-3.1 3-7.3 4.8-12 4.8s-8.9-1.8-12-4.8z" fill="#f2f2ee" />
        </svg>
      );
    case "browser":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#f4f4f6" />
          <defs>
            <linearGradient id="saf" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5ec2ff" />
              <stop offset="1" stopColor="#1e6ff0" />
            </linearGradient>
          </defs>
          <circle cx="30" cy="30" r="23" fill="url(#saf)" />
          {Array.from({ length: 32 }).map((_, i) => (
            <rect key={i} x="29.5" y="9" width="1" height={i % 2 ? 2 : 3.6} rx=".5" fill="#fff" opacity=".8" transform={`rotate(${i * 11.25} 30 30)`} />
          ))}
          <path d="M45 15L31.6 31.6 28.4 28.4z" fill="#ff4b42" />
          <path d="M15 45l13.4-16.6 3.2 3.2z" fill="#fff" />
        </svg>
      );
    case "wallet":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#232324" />
          <rect x="10" y="14" width="40" height="32" rx="5" fill="#e9e5df" opacity=".9" />
          <rect x="13" y="17" width="34" height="10" rx="3" fill="#2aa8f5" />
          <rect x="13" y="21.5" width="34" height="10" rx="3" fill="#f6c625" />
          <rect x="13" y="26" width="34" height="12" rx="3" fill="#f66b52" />
          <path d="M10 31h11c2 0 3 4.5 9 4.5s7-4.5 9-4.5h11v10a5 5 0 01-5 5H15a5 5 0 01-5-5z" fill="#efe6df" opacity=".95" />
        </svg>
      );
    case "track":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#f2f2ee" />
          <path d="M0 0h22L14 22 0 18z" fill="#7ed97f" />
          <path d="M30 0h30v26C48 22 38 12 30 0z" fill="#8fe08a" />
          <path d="M0 40l14-4 6 24H0z" fill="#f59ad1" />
          <path d="M40 60l6-16 14 4v12z" fill="#fbd75b" />
          <path d="M22 0h8l-4 60h-8z" fill="#3b8cf6" />
          <circle cx="30" cy="34" r="12" fill="#fff" />
          <circle cx="30" cy="34" r="10" fill="#2d7cf5" />
          <path d="M30 27l5 11-5-2.5-5 2.5z" fill="#fff" />
        </svg>
      );
    case "favorites":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#f2f2f4" />
          <defs>
            <linearGradient id="fold" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2fb5ff" />
              <stop offset="1" stopColor="#1e88f2" />
            </linearGradient>
          </defs>
          <path d="M9 17a3 3 0 013-3h11l3 3h22a3 3 0 013 3v4H9z" fill="#1aa4ff" />
          <rect x="11" y="18" width="38" height="6" rx="1.5" fill="#fff" />
          <rect x="8" y="21" width="44" height="27" rx="4" fill="url(#fold)" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <defs>
            <linearGradient id="set" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#9a9aa0" />
              <stop offset="1" stopColor="#68686e" />
            </linearGradient>
          </defs>
          <rect width="60" height="60" fill="url(#set)" />
          <g transform="translate(30 30)">
            {Array.from({ length: 24 }).map((_, i) => (
              <rect key={i} x="-2" y="-21" width="4" height="5" rx="1" fill="#e9e9ec" transform={`rotate(${i * 15})`} />
            ))}
            <circle r="17" fill="#e9e9ec" />
            <circle r="13" fill="url(#set)" />
            <circle r="11" fill="none" stroke="#d4d4d8" strokeWidth="1.2" />
            {[0, 120, 240].map((a) => (
              <rect key={a} x="-1.4" y="-12" width="2.8" height="12" rx="1.4" fill="#e9e9ec" transform={`rotate(${a})`} />
            ))}
            <circle r="2.6" fill="#e9e9ec" />
          </g>
        </svg>
      );
    case "shop":
      return skin === "amazon" ? (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#232f3e" />
          <path d="M17 22h26l-2.5 20a3 3 0 01-3 2.6H22.5a3 3 0 01-3-2.6z" fill="#fff" />
          <path d="M24 25v-3.5a6 6 0 0112 0V25" stroke="#232f3e" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          <path d="M20 34c6 4 14 4 20 0" stroke="#ff9900" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <defs>
            <linearGradient id="tb" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ff8a3d" />
              <stop offset="1" stopColor="#ff5a12" />
            </linearGradient>
          </defs>
          <rect width="60" height="60" fill="url(#tb)" />
          <path d="M17 22h26l-2.5 20a3 3 0 01-3 2.6H22.5a3 3 0 01-3-2.6z" fill="#fff" />
          <path d="M24 25v-3.5a6 6 0 0112 0V25" stroke="#ff6a1a" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "delivery":
      return (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill={skin === "doordash" ? "#ff3008" : "#ffd84d"} />
          <g stroke={skin === "doordash" ? "#fff" : "#1c1c1e"} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="20" cy="41" r="5" />
            <circle cx="42" cy="41" r="5" />
            <path d="M20 41l7-13h9l6 13M27 28l-3-6h-5" />
          </g>
          <rect x="33" y="17" width="12" height="9" rx="1.5" fill={skin === "doordash" ? "#fff" : "#1c1c1e"} />
        </svg>
      );
    case "video":
      return skin === "youtube" ? (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#fff" />
          <rect x="10" y="17" width="40" height="27" rx="8" fill="#ff1f1f" />
          <path d="M26 24.5l11 6-11 6z" fill="#fff" />
        </svg>
      ) : (
        <svg viewBox="0 0 60 60" className="h-full w-full">
          <rect width="60" height="60" fill="#0b0b0f" />
          <path d="M25 20.5l15 9.5-15 9.5z" fill="#25f4ee" transform="translate(-1.6 -1.2)" />
          <path d="M25 20.5l15 9.5-15 9.5z" fill="#fe2c55" transform="translate(1.6 1.2)" />
          <path d="M25 20.5l15 9.5-15 9.5z" fill="#fff" />
        </svg>
      );
    default:
      return null;
  }
}

export function AppIcon({ app, size = 62, label = true, onClick, badge = 0, image, skin, dark = false }) {
  const art = image ? null : IconArt({ id: app.id, skin });
  return (
    <button type="button" onClick={onClick} className="relative flex flex-col items-center gap-[6px] outline-none active:opacity-70">
      <span
        className="relative flex items-center justify-center overflow-hidden"
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.235,
          background: image || art ? undefined : `linear-gradient(180deg, ${app.color ?? "#8e8e93"}cc, ${app.color ?? "#8e8e93"})`,
          boxShadow: "0 2px 6px rgba(0,0,0,.18), inset 0 0 0 0.5px rgba(255,255,255,.35)",
        }}
      >
        {image ? (
          <img src={image} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          art ?? <span style={{ fontSize: size * 0.5, lineHeight: 1 }}>{app.icon || "📱"}</span>
        )}
        {art && (
          <svg viewBox="0 0 60 60" className="pointer-events-none absolute inset-0 h-full w-full">
            <GlassShine />
          </svg>
        )}
      </span>
      {badge > 0 && (
        <span className="absolute -right-2 -top-2 flex h-[24px] min-w-[24px] items-center justify-center rounded-full bg-[#ff3b30] px-1.5 text-[14px] font-medium text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {label && (
        <span className={`max-w-[76px] truncate text-[12px] font-medium ${dark ? "text-black" : "text-white [text-shadow:0_1px_3px_rgba(0,0,0,.4)]"}`}>{app.name}</span>
      )}
    </button>
  );
}

/* ================= 信息 ================= */

function MessagesApp({ items, ctx }) {
  const [open, setOpen] = useState(null); // "user" | item
  const { userThread = [], userName, sep } = ctx;

  if (open) {
    const isUser = open === "user";
    const bubbles = isUser ? userThread.map((m) => ({ from: m.from === "user" ? "them" : "me", text: m.text })) : parseThread(open.detail, sep);
    const name = isUser ? userName || "你" : open.title;
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-white">
        <div className="flex h-[96px] shrink-0 items-start justify-between px-4 pt-1">
          <BackGlass onClick={() => setOpen(null)} />
          <div className="flex flex-col items-center">
            <Avatar name={name} size={52} initials={!isUser} />
            <span className="mt-1 flex items-center gap-0.5 rounded-full border border-white/70 bg-white/85 px-3 py-[3px] text-[13px] font-medium text-black shadow-[0_2px_10px_rgba(0,0,0,0.08)]">
              {name}
              <ChevronRight size={12} className="text-[#8e8e93]" />
            </span>
          </div>
          <Glass label="视频通话" className="!px-0">
            <Video size={21} />
          </Glass>
        </div>
        <Scroll pad={110} className="px-3.5">
          <p className="pb-3 pt-1 text-center text-[12px] text-[#8e8e93]">
            iMessage 信息
            <br />
            {isUser ? "今天" : open.time || "今天"}
          </p>
          {bubbles.map((b, i) => {
            const me = b.from === "me";
            const tail = bubbles[i + 1]?.from !== b.from;
            return (
              <div key={i} className={`flex ${me ? "justify-end" : "justify-start"} ${tail ? "mb-2.5" : "mb-[3px]"}`}>
                <span
                  className={`max-w-[75%] whitespace-pre-wrap break-words px-[14px] py-[8px] text-[17px] leading-[1.3] ${me ? "bg-[#0a84ff] text-white" : "bg-[#e9e9eb] text-black"}`}
                  style={{ borderRadius: 20, ...(tail ? (me ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }) : {}) }}
                >
                  {b.text}
                </span>
              </div>
            );
          })}
          {bubbles.at(-1)?.from === "me" && <p className="-mt-1.5 pr-1 text-right text-[12px] text-[#8e8e93]">已送达</p>}
          {!isUser && (
            <button type="button" onClick={() => (ctx.onDelete(open.id), setOpen(null))} className="mx-auto mt-8 block text-[14px] text-[#ff3b30]">
              删除这段对话
            </button>
          )}
        </Scroll>
        <div className="absolute inset-x-3 bottom-[30px] flex items-center gap-2.5">
          <span className="flex h-[44px] w-[44px] items-center justify-center rounded-full border border-white/70 bg-white/85 shadow-[0_2px_12px_rgba(0,0,0,0.1)] backdrop-blur-xl">
            <Plus size={24} className="text-[#3c3c43]" />
          </span>
          <span className="flex h-[44px] flex-1 items-center rounded-full border border-[#d1d1d6] bg-white/90 px-4 text-[17px] text-[#c7c7cc] backdrop-blur-xl">
            iMessage 信息
            <Mic size={20} className="ml-auto text-[#8e8e93]" />
          </span>
        </div>
      </div>
    );
  }

  const last = userThread.at(-1);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white">
      <TopBar
        left={<Glass>编辑</Glass>}
        title="信息"
        right={
          <>
            <RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />
            <Glass label="筛选" className="!px-0">
              <SlidersHorizontal size={20} />
            </Glass>
          </>
        }
      />
      <Scroll>
        {userThread.length > 0 && (
          <div className="grid grid-cols-3 px-4 pb-3 pt-2">
            <button type="button" onClick={() => setOpen("user")} className="flex flex-col items-center">
              <span className="relative">
                <Avatar name={userName || "你"} size={96} />
                {last && (
                  <span className="absolute -top-3 left-1/2 max-w-[120px] -translate-x-1/2 truncate rounded-[14px] bg-white px-2.5 py-1 text-[12px] text-[#3c3c43] shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
                    {last.text}
                  </span>
                )}
              </span>
              <span className="mt-1.5 text-[15px] text-[#3c3c43]">{userName || "你"}</span>
            </button>
          </div>
        )}
        {!items.length && !userThread.length && <EmptyState text="没有信息" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.map((it, i) => {
          const preview = parseThread(it.detail, sep).at(-1);
          return (
            <div key={it.id} onClick={() => setOpen(it)} className="relative flex cursor-pointer items-center gap-3 py-[14px] pl-[22px] pr-4 active:bg-black/[0.05]">
              {ctx.isNew(it) && <span className="absolute left-[7px] top-1/2 h-[10px] w-[10px] -translate-y-1/2 rounded-full bg-[#007aff]" />}
              <Avatar name={it.title} size={52} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[17px] font-semibold text-black">{it.title}</span>
                  <span className="flex shrink-0 items-center text-[15px] text-[#8e8e93]">
                    {it.time || "昨天"}
                    <ChevronRight size={16} />
                  </span>
                </div>
                <p className="line-clamp-2 text-[15px] leading-[1.35] text-[#8e8e93]">{preview?.text ?? it.value}</p>
              </div>
              {i < items.length - 1 && <span className="absolute bottom-0 left-[86px] right-4 h-px bg-[#c6c6c8]/60" />}
            </div>
          );
        })}
      </Scroll>
      <BottomSearch />
    </div>
  );
}

/* ================= 电话 / 通讯录 ================= */

function callKind(v) {
  const s = String(v ?? "");
  if (/未接|拒接|missed/i.test(s)) return "missed";
  if (/呼出|拨出|out/i.test(s)) return "out";
  return "in";
}

function CallsList({ items, ctx, onPick }) {
  return (
    <>
      <TopBar
        left={<Glass>编辑</Glass>}
        title="通话"
        right={
          <>
            <RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />
            <Glass label="筛选" className="!px-0">
              <SlidersHorizontal size={20} />
            </Glass>
          </>
        }
      />
      <Scroll>
        {!items.length && <EmptyState text="没有最近通话" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.map((it, i) => {
          const k = callKind(it.value);
          const Icon = k === "out" ? PhoneOutgoing : PhoneIncoming;
          const dur = String(it.value || "").replace(/^(呼入|呼出|未接)\s*/, "");
          return (
            <div key={it.id} onClick={() => onPick(it)} className="relative flex cursor-pointer items-center gap-3 py-[12px] pl-4 pr-4 active:bg-black/[0.05]">
              <Avatar name={it.title} size={54} />
              <div className="min-w-0 flex-1">
                <p className={`truncate text-[19px] font-medium ${k === "missed" ? "text-[#ff3b30]" : "text-black"}`}>{it.title}</p>
                <p className="flex items-center gap-1 truncate text-[16px] text-[#8e8e93]">
                  {k !== "missed" && <Icon size={14} />}
                  {k === "missed" ? "未接来电" : dur || "手机"}
                </p>
              </div>
              <span className="text-[17px] text-[#8e8e93]">{it.time}</span>
              <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-[#f2f2f7]">
                <Phone size={22} className="text-[#007aff]" fill="#007aff" strokeWidth={0} />
              </span>
              {i < items.length - 1 && <span className="absolute bottom-0 left-[82px] right-4 h-px bg-[#c6c6c8]/60" />}
            </div>
          );
        })}
      </Scroll>
    </>
  );
}

function ContactCard({ it, onBack, onDelete, ctx }) {
  useDarkStatus(ctx, true);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#2b201a]">
      <TopBar dark left={<BackGlass dark onClick={onBack} />} title="" right={<Glass dark>编辑</Glass>} />
      <Scroll pad={60}>
        <div className="flex flex-col items-center px-4 pb-5 pt-2">
          <Avatar name={it.title} size={156} initials />
          <p className="mt-5 text-[34px] font-bold text-white">{it.title}</p>
          {it.value && <p className="text-[16px] text-white/55">{it.value}</p>}
          <div className="mt-5 flex gap-4">
            {[MessageCircle, Phone, Video, Mail].map((I, i) => (
              <span key={i} className="flex h-[66px] w-[66px] items-center justify-center rounded-full border border-white/20 bg-white/[0.08]">
                <I size={28} className={i < 2 ? "text-white" : "text-white/40"} fill={i < 3 ? "currentColor" : "none"} strokeWidth={i < 3 ? 0 : 1.6} />
              </span>
            ))}
          </div>
        </div>
        <Card27 dark className="mb-3">
          <div className="px-5 py-4">
            <p className="text-[17px] text-[#c9a27e]">关系</p>
            <p className="text-[19px] text-white">{it.value || "—"}</p>
          </div>
          <div className="mx-5 h-px bg-white/10" />
          <div className="min-h-[120px] px-5 py-4">
            <p className="text-[17px] text-[#c9a27e]">备注</p>
            <p className="mt-1 whitespace-pre-wrap text-[17px] leading-snug text-white/85">{it.detail}</p>
          </div>
        </Card27>
        {it.real && <p className="mb-3 px-8 text-center text-[13px] text-white/45">这是 Uranus 里真实存在的另一个角色</p>}
        <Card27 dark>
          <button type="button" onClick={() => (onDelete(it.id), onBack())} className="w-full px-5 py-4 text-left text-[18px] text-[#ff453a]">
            删除联系人
          </button>
        </Card27>
      </Scroll>
    </div>
  );
}

function ContactsList({ items, ctx, onPick }) {
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
    <>
      <TopBar
        left={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />}
        title="通讯录"
        right={
          <Glass label="新增" className="!px-0">
            <Plus size={24} />
          </Glass>
        }
      />
      <Scroll>
        <div className="flex items-center gap-3 px-4 pb-3 pt-1">
          <Avatar name={ctx.roleName} size={62} initials />
          <div>
            <p className="text-[22px] font-semibold text-black">{ctx.roleName}</p>
            <p className="text-[16px] text-[#8e8e93]">我的卡片</p>
          </div>
        </div>
        {!items.length && <EmptyState text="没有联系人" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        <div className="relative pr-6">
          {groups.map(([letter, list]) => (
            <div key={letter}>
              <p className="mx-4 border-b border-[#c6c6c8]/70 pb-1.5 pt-3 text-[17px] text-[#8e8e93]">{letter}</p>
              {list.map((it, i) => (
                <div key={it.id} onClick={() => onPick(it)} className="relative flex cursor-pointer items-center gap-3 px-4 py-[10px] active:bg-black/[0.05]">
                  <Avatar name={it.title} size={46} initials />
                  <span className="text-[19px] text-black">{it.title}</span>
                  {it.value && <span className="ml-auto text-[15px] text-[#8e8e93]">{it.value}</span>}
                  {i < list.length - 1 && <span className="absolute bottom-0 left-[74px] right-0 h-px bg-[#c6c6c8]/60" />}
                </div>
              ))}
            </div>
          ))}
          {groups.length > 0 && (
            <div className="absolute right-1.5 top-3 flex flex-col items-center text-[12px] font-medium leading-[17px] text-[#007aff]">
              {groups.map(([l]) => (
                <span key={l}>{l}</span>
              ))}
            </div>
          )}
        </div>
      </Scroll>
    </>
  );
}

/** 电话底部那条悬浮标签栏 + 单独的搜索圆钮。 */
function PhoneTabBar({ tab, setTab, missed }) {
  const tabs = [
    ["calls", Clock, "通话"],
    ["contacts", null, "通讯录"],
    ["keypad", Grid3x3, "拨号键盘"],
  ];
  return (
    <div className="absolute inset-x-4 bottom-[30px] z-10 flex gap-2.5">
      <div className="flex h-[66px] flex-1 items-center rounded-full border border-white/70 bg-white/85 p-1.5 shadow-[0_4px_18px_rgba(0,0,0,0.1)] backdrop-blur-xl">
        {tabs.map(([k, I, l]) => {
          const on = tab === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => k !== "keypad" && setTab(k)}
              className={`relative flex h-full flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium ${on ? "bg-black/[0.06] text-[#007aff]" : "text-black"}`}
            >
              {I ? (
                <I size={24} strokeWidth={2.2} />
              ) : (
                <svg viewBox="0 0 24 24" width="24" height="24">
                  <circle cx="12" cy="12" r="11" fill="currentColor" />
                  <circle cx="12" cy="9.5" r="3.6" fill="#fff" />
                  <path d="M5.5 18.5c1.3-2.8 3.7-4.2 6.5-4.2s5.2 1.4 6.5 4.2" fill="#fff" />
                </svg>
              )}
              {l}
              {k === "calls" && missed > 0 && (
                <span className="absolute left-1/2 top-0 ml-1 rounded-full bg-[#ff3b30] px-1.5 text-[12px] font-medium leading-[18px] text-white">{missed}</span>
              )}
            </button>
          );
        })}
      </div>
      <span className="flex h-[66px] w-[66px] items-center justify-center rounded-full border border-white/70 bg-white/85 shadow-[0_4px_18px_rgba(0,0,0,0.1)] backdrop-blur-xl">
        <Search size={26} strokeWidth={2.3} />
      </span>
    </div>
  );
}

function PhoneApp({ items, ctx, contactsCtx, sheet }) {
  const [tab, setTab] = useState("calls");
  const [card, setCard] = useState(null);
  if (card) return <ContactCard it={card} ctx={ctx} onBack={() => setCard(null)} onDelete={contactsCtx.onDelete} />;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white">
      {tab === "calls" ? (
        <CallsList items={items} ctx={ctx} onPick={sheet} />
      ) : (
        <ContactsList items={contactsCtx.items} ctx={contactsCtx} onPick={setCard} />
      )}
      <PhoneTabBar tab={tab} setTab={setTab} missed={items.filter((x) => callKind(x.value) === "missed").length} />
    </div>
  );
}

function ContactsApp({ items, ctx }) {
  const [card, setCard] = useState(null);
  if (card) return <ContactCard it={card} ctx={ctx} onBack={() => setCard(null)} onDelete={ctx.onDelete} />;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white">
      <ContactsList items={items} ctx={ctx} onPick={setCard} />
      <BottomSearch />
    </div>
  );
}

/* ================= 文件（原来的「收藏夹」） ================= */

function fileKind(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  if (["m4a", "mp3", "wav", "aac", "caf"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "heic", "gif", "webp"].includes(ext)) return "image";
  if (["mp4", "mov"].includes(ext)) return "video";
  return "doc";
}

function FileThumb({ name, size = 84 }) {
  const k = fileKind(name);
  if (k === "image" || k === "video") {
    const h = hash(name) % 360;
    return (
      <span className="relative flex items-center justify-center overflow-hidden rounded-[10px]" style={{ width: size, height: size * 0.8, background: `linear-gradient(135deg,hsl(${h} 45% 70%),hsl(${(h + 50) % 360} 50% 45%))` }}>
        {k === "video" ? <Play size={size * 0.28} fill="#fff" className="text-white" /> : <ImageIcon size={size * 0.3} className="text-white/80" />}
      </span>
    );
  }
  if (k === "audio") {
    return (
      <span className="flex items-center justify-center rounded-[12px] bg-gradient-to-b from-[#ff9f6b] to-[#ff5e3a]" style={{ width: size * 0.78, height: size * 0.78 }}>
        <Music2 size={size * 0.34} className="text-white" />
      </span>
    );
  }
  return (
    <span className="relative flex flex-col gap-[5px] rounded-[6px] border border-[#e0e0e5] bg-white px-[10px] pt-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]" style={{ width: size * 0.66, height: size * 0.86 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="h-[2px] rounded bg-[#d1d1d6]" style={{ width: i === 4 ? "55%" : "100%" }} />
      ))}
    </span>
  );
}

function FilesApp({ items, ctx }) {
  const [folder, setFolder] = useState(null);
  const [file, setFile] = useState(null);
  const folders = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      const f = it.value || "私密";
      if (!map.has(f)) map.set(f, []);
      map.get(f).push(it);
    }
    return [...map.entries()];
  }, [items]);

  if (file) {
    const k = fileKind(file.title);
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-white">
        <TopBar
          left={<BackGlass onClick={() => setFile(null)} />}
          title={file.title}
          sub={file.value}
          right={
            <Glass label="分享" className="!px-0">
              <Share size={20} />
            </Glass>
          }
        />
        <Scroll pad={60} className="px-6">
          <p className="pb-4 pt-1 text-center text-[15px] text-[#8e8e93]">{file.time || "今天"}</p>
          {k === "audio" && (
            <div className="mb-5 rounded-[22px] bg-[#f2f2f7] px-5 py-5">
              <div className="flex h-[48px] items-center gap-[3px]">
                {Array.from({ length: 42 }).map((_, i) => (
                  <span key={i} className="w-[3px] rounded-full bg-[#ff6b3d]" style={{ height: 8 + ((hash(file.title + i) % 100) / 100) * 38 }} />
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between text-[13px] text-[#8e8e93]">
                <span>0:00</span>
                <Play size={26} fill="#1c1c1e" className="text-black" />
                <span>
                  {(hash(file.title) % 5) + 1}:{String(hash(file.id) % 60).padStart(2, "0")}
                </span>
              </div>
            </div>
          )}
          {(k === "image" || k === "video") && (
            <div className="mb-5 flex justify-center">
              <FileThumb name={file.title} size={300} />
            </div>
          )}
          <p className="whitespace-pre-wrap text-[18px] leading-[1.6] text-black">{file.detail}</p>
          <button type="button" onClick={() => (ctx.onDelete(file.id), setFile(null))} className="mt-10 text-[15px] text-[#ff3b30]">
            删除这个文件
          </button>
        </Scroll>
      </div>
    );
  }

  if (folder) {
    const list = folders.find(([f]) => f === folder)?.[1] ?? [];
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-white">
        <TopBar
          left={<BackGlass onClick={() => setFolder(null)} />}
          title={folder}
          sub={`${list.length} 项`}
          right={
            <Glass label="更多" className="!px-0">
              <Ellipsis size={22} />
            </Glass>
          }
        />
        <Scroll>
          <div className="grid grid-cols-3 gap-x-3 gap-y-6 px-5 pt-3">
            {list.map((it) => (
              <button key={it.id} type="button" onClick={() => setFile(it)} className="flex flex-col items-center">
                <span className="flex h-[92px] items-end justify-center">
                  <FileThumb name={it.title} size={92} />
                </span>
                <span className="mt-2 line-clamp-2 text-center text-[13px] font-medium leading-tight text-black">{it.title}</span>
                <span className="text-[12px] text-[#8e8e93]">{it.time}</span>
              </button>
            ))}
          </div>
        </Scroll>
        <BottomSearch />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#f2f2f7]">
      <TopBar
        left={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />}
        title="浏览"
        right={
          <Glass label="更多" className="!px-0">
            <Ellipsis size={22} />
          </Glass>
        }
      />
      <Scroll>
        {!items.length && <EmptyState text="这里什么都没有" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.length > 0 && (
          <>
            <p className="px-8 pb-2 pt-2 text-[20px] font-bold text-black">最近项目</p>
            <div className="flex gap-4 overflow-x-auto px-5 pb-4 [scrollbar-width:none]">
              {items.slice(0, 6).map((it) => (
                <button key={it.id} type="button" onClick={() => setFile(it)} className="flex w-[84px] shrink-0 flex-col items-center">
                  <span className="flex h-[84px] items-end">
                    <FileThumb name={it.title} size={84} />
                  </span>
                  <span className="mt-1.5 line-clamp-2 text-center text-[12px] leading-tight text-black">{it.title}</span>
                </button>
              ))}
            </div>
            <p className="px-8 pb-2 pt-2 text-[20px] font-bold text-black">位置</p>
            <Card27>
              {folders.map(([f, list], i) => (
                <Row27 key={f} onClick={() => setFolder(f)} last={i === folders.length - 1} inset={60}>
                  <Folder size={28} className="text-[#1e9bff]" fill="#1e9bff" />
                  <span className="flex-1 text-[18px] text-black">{f}</span>
                  <span className="text-[16px] text-[#8e8e93]">{list.length}</span>
                  <ChevronRight size={18} className="text-[#c7c7cc]" />
                </Row27>
              ))}
            </Card27>
          </>
        )}
      </Scroll>
      <BottomSearch placeholder="搜索" icon={FileText} />
    </div>
  );
}

/* ================= 购物（淘宝 / Amazon） ================= */

function orderStatus(detail) {
  const s = String(detail ?? "");
  if (/已签收|已收货|已完成|待评价|已送达/.test(s)) return ["review", "交易成功"];
  if (/运输|派送|揽收|已发货|在途|配送/.test(s)) return ["receive", "卖家已发货"];
  if (/待发货|备货|未发货/.test(s)) return ["ship", "等待卖家发货"];
  if (/待付款|未付款/.test(s)) return ["pay", "等待买家付款"];
  return ["review", "交易成功"];
}
const PASTEL = ["#ffe3d3", "#e3efff", "#e9f7e3", "#fff3c9", "#f1e6ff", "#ffe0ea"];

function TaobaoApp({ items, ctx, sheet }) {
  const [tab, setTab] = useState("all");
  const tabs = [
    ["all", "全部"],
    ["pay", "待付款"],
    ["ship", "待发货"],
    ["receive", "待收货"],
    ["review", "待评价"],
  ];
  const list = tab === "all" ? items : items.filter((x) => orderStatus(x.detail)[0] === tab);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white">
      <div className="shrink-0 bg-white">
        <TopBar left={<BackGlass onClick={ctx.close} />} title="我的订单" right={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />} />
        <div className="mx-4 mb-2 flex h-9 items-center gap-1.5 rounded-full bg-[#f4f4f4] px-3.5 text-[14px] text-[#999]">
          <Search size={15} />
          搜索我的订单
        </div>
        <div className="flex justify-around text-[15px]">
          {tabs.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className="relative pb-2.5 pt-1" style={{ color: tab === k ? "#000" : "#666", fontWeight: tab === k ? 600 : 400 }}>
              {l}
              {tab === k && <span className="absolute bottom-0 left-1/2 h-[3px] w-6 -translate-x-1/2 rounded-full bg-[#ff5000]" />}
            </button>
          ))}
        </div>
      </div>
      <Scroll pad={50} className="bg-[#f4f4f4] px-3 pt-3">
        {!items.length && <EmptyState text="还没有订单" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {list.map((it, i) => {
          const [k, label] = orderStatus(it.detail);
          return (
            <div key={it.id} onClick={() => sheet(it)} className="mb-3 cursor-pointer rounded-[16px] bg-white p-3.5 active:opacity-80">
              <div className="flex items-center justify-between text-[14px]">
                <span className="font-semibold text-black">
                  {it.time ? `下单 ${it.time}` : "订单"} <ChevronRight size={13} className="inline text-[#999]" />
                </span>
                <span className="text-[#ff5000]">{label}</span>
              </div>
              <div className="mt-3 flex gap-3">
                <span className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-[10px]" style={{ background: PASTEL[i % PASTEL.length] }}>
                  <Package size={34} className="text-black/25" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[15px] leading-snug text-black">{it.title}</p>
                  <p className="mt-1.5 line-clamp-1 rounded-[5px] bg-[#f6f6f6] px-2 py-0.5 text-[13px] text-[#999]">{it.detail}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[15px] font-semibold text-black">{it.value}</p>
                  <p className="text-[13px] text-[#999]">x1</p>
                </div>
              </div>
              <p className="mt-2.5 text-right text-[14px] text-black">
                实付款 <span className="font-semibold">{it.value}</span>
              </p>
              <div className="mt-2.5 flex justify-end gap-2 text-[14px]">
                {k === "receive" && <span className="rounded-full border border-[#ccc] px-3.5 py-1 text-[#333]">查看物流</span>}
                <span className="rounded-full border border-[#ff5000] px-3.5 py-1 text-[#ff5000]">
                  {k === "receive" ? "确认收货" : k === "review" ? "评价" : k === "pay" ? "付款" : "提醒发货"}
                </span>
              </div>
            </div>
          );
        })}
      </Scroll>
    </div>
  );
}

function AmazonApp({ items, ctx, sheet }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#82d8e3]">
      <div className="shrink-0 bg-gradient-to-b from-[#82d8e3] to-[#a6e7ce] pb-3">
        <TopBar left={<BackGlass onClick={ctx.close} />} title="" right={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />} />
        <div className="mx-4 flex h-11 items-center gap-2 rounded-[10px] border border-[#d5d9d9] bg-white px-3 text-[16px] text-[#666] shadow-sm">
          <Search size={18} />
          搜索 Amazon
          <Camera size={18} className="ml-auto" />
        </div>
      </div>
      <Scroll pad={50} className="bg-[#eaeded]">
        <p className="px-4 pb-2 pt-4 text-[24px] font-bold text-[#0f1111]">您的订单</p>
        {!items.length && <EmptyState text="没有订单" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.map((it, i) => {
          const [k] = orderStatus(it.detail);
          const status = k === "review" ? "已送达" : k === "receive" ? "运输中" : k === "ship" ? "准备发货" : "待付款";
          return (
            <div key={it.id} onClick={() => sheet(it)} className="mb-2 cursor-pointer border-y border-[#d5d9d9] bg-white px-4 py-3.5 active:opacity-80">
              <p className={`text-[17px] font-bold ${k === "review" ? "text-[#007600]" : "text-[#c45500]"}`}>{status}</p>
              <p className="text-[14px] text-[#565959]">{it.time}</p>
              <div className="mt-2.5 flex gap-3">
                <span className="flex h-[86px] w-[86px] shrink-0 items-center justify-center rounded-[6px]" style={{ background: PASTEL[i % PASTEL.length] }}>
                  <Package size={34} className="text-black/25" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[15px] leading-snug text-[#007185]">{it.title}</p>
                  <p className="mt-1 line-clamp-1 text-[13px] text-[#565959]">{it.detail}</p>
                  <p className="mt-1 text-[16px] font-medium text-[#0f1111]">{it.value}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2 text-[14px]">
                <span className="flex-1 rounded-full bg-[#ffd814] py-2 text-center text-[#0f1111]">再次购买</span>
                <span className="flex-1 rounded-full border border-[#d5d9d9] py-2 text-center text-[#0f1111]">{k === "receive" ? "跟踪包裹" : "查看商品"}</span>
              </div>
            </div>
          );
        })}
      </Scroll>
    </div>
  );
}

/* ================= 外卖（美团 / DoorDash） ================= */

function MeituanApp({ items, ctx, sheet }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#ffd84d]">
      <div className="shrink-0 bg-gradient-to-b from-[#ffd84d] to-[#ffe680] pb-3">
        <TopBar left={<BackGlass onClick={ctx.close} />} title="订单" right={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />} />
        <div className="flex gap-6 px-6 text-[16px] text-black">
          <span className="font-semibold">全部</span>
          <span className="opacity-60">待评价</span>
          <span className="opacity-60">退款/售后</span>
        </div>
      </div>
      <Scroll pad={50} className="bg-[#f5f5f5] px-3 pt-3">
        {!items.length && <EmptyState text="还没有外卖订单" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.map((it) => (
          <div key={it.id} onClick={() => sheet(it)} className="mb-3 cursor-pointer rounded-[16px] bg-white p-3.5 active:opacity-80">
            <div className="flex items-center gap-2.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-[#fff4c2] text-[18px] font-bold text-[#a57800]">{it.title.slice(0, 1)}</span>
              <span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-black">
                {it.title} <ChevronRight size={14} className="inline text-[#999]" />
              </span>
              <span className="text-[14px] text-[#999]">已送达</span>
            </div>
            <p className="mt-2 line-clamp-2 pl-[54px] text-[14px] leading-snug text-[#666]">{it.detail}</p>
            <div className="mt-2 flex items-center justify-between pl-[54px] text-[13px] text-[#999]">
              <span>{it.time}</span>
              <span className="text-[15px] text-black">
                实付 <span className="font-semibold">{it.value}</span>
              </span>
            </div>
            <div className="mt-3 flex justify-end gap-2 text-[14px]">
              <span className="rounded-full border border-[#ddd] px-3.5 py-1 text-[#333]">评价</span>
              <span className="rounded-full bg-[#ffd84d] px-3.5 py-1 font-medium text-black">再来一单</span>
            </div>
          </div>
        ))}
      </Scroll>
    </div>
  );
}

function DoorDashApp({ items, ctx, sheet }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white">
      <TopBar left={<BackGlass onClick={ctx.close} />} title="" right={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />} />
      <Scroll pad={50}>
        <p className="px-5 pb-1 text-[30px] font-bold text-[#191919]">订单</p>
        <div className="flex gap-2 px-5 pb-3 pt-2 text-[14px] font-medium">
          <span className="rounded-full bg-[#191919] px-4 py-1.5 text-white">已完成</span>
          <span className="rounded-full bg-[#f1f1f1] px-4 py-1.5 text-[#191919]">进行中</span>
        </div>
        {!items.length && <EmptyState text="还没有订单" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.map((it) => (
          <div key={it.id} onClick={() => sheet(it)} className="flex cursor-pointer gap-3.5 border-b border-[#eee] px-5 py-4 active:bg-black/[0.03]">
            <span className="flex h-[54px] w-[54px] shrink-0 items-center justify-center rounded-full bg-[#ffece8] text-[20px] font-bold text-[#ff3008]">{it.title.slice(0, 1)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[17px] font-bold text-[#191919]">{it.title}</p>
              <p className="text-[14px] text-[#767676]">
                已送达 · {it.time} · {it.value}
              </p>
              <p className="mt-1 line-clamp-2 text-[14px] leading-snug text-[#494949]">{it.detail}</p>
            </div>
            <span className="self-center rounded-full bg-[#ff3008] px-3.5 py-2 text-[14px] font-semibold text-white">再点一次</span>
          </div>
        ))}
      </Scroll>
    </div>
  );
}

/* ================= 视频（TikTok / 抖音 / YouTube） ================= */

function Thumb({ seed, className = "", children }) {
  const h = hash(seed) % 360;
  return (
    <div className={`relative overflow-hidden ${className}`} style={{ background: `linear-gradient(160deg,hsl(${h} 50% 55%),hsl(${(h + 60) % 360} 55% 25%))` }}>
      {children}
    </div>
  );
}

function ShortVideoApp({ items, ctx, sheet, skinName }) {
  const [play, setPlay] = useState(null);
  if (play) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-black">
        <Thumb seed={play.id + play.title} className="absolute inset-0 opacity-90" />
        <div className="relative z-10">
          <TopBar
            dark
            left={<BackGlass dark onClick={() => setPlay(null)} />}
            title=""
            right={
              <Glass dark label="更多" className="!px-0" onClick={() => sheet(play)}>
                <Ellipsis size={22} />
              </Glass>
            }
          />
        </div>
        <div className="absolute bottom-[150px] right-3 z-10 flex flex-col items-center gap-5 text-white">
          {[
            [Heart, `${(hash(play.id) % 900) / 10}万`],
            [MessageCircle, `${hash(play.title) % 9000}`],
            [Share, "分享"],
          ].map(([I, n], i) => (
            <span key={i} className="flex flex-col items-center text-[12px] font-semibold">
              <I size={34} fill={i === 0 ? "#fe2c55" : "#fff"} strokeWidth={0} />
              {n}
            </span>
          ))}
        </div>
        <div className="absolute bottom-[60px] left-4 right-16 z-10 text-white [text-shadow:0_1px_3px_rgba(0,0,0,.5)]">
          <p className="text-[17px] font-semibold">{play.value || "@用户"}</p>
          <p className="mt-1 text-[16px] leading-snug">{play.title}</p>
          {play.detail && <p className="mt-2 text-[14px] leading-snug text-white/75">{play.detail}</p>}
        </div>
        <div className="absolute inset-x-0 bottom-[42px] z-10 h-[2px] bg-white/25">
          <div className="h-full bg-white" style={{ width: `${20 + (hash(play.id) % 70)}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-black">
      <TopBar dark left={<BackGlass dark onClick={ctx.close} />} title="观看历史" sub={skinName} right={<RefreshGlass dark busy={ctx.busy} onClick={ctx.onRefresh} />} />
      <Scroll pad={50}>
        {!items.length && <EmptyState dark text="没有观看记录" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        <div className="grid grid-cols-3 gap-[2px]">
          {items.map((it) => (
            <button key={it.id} type="button" onClick={() => setPlay(it)} className="relative block">
              <Thumb seed={it.id + it.title} className="aspect-[3/4] w-full">
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1.5 pt-6 text-left">
                  <span className="line-clamp-2 text-[12px] leading-tight text-white">{it.title}</span>
                  <span className="mt-0.5 flex items-center gap-0.5 text-[11px] text-white/80">
                    <Play size={10} fill="#fff" strokeWidth={0} />
                    {((hash(it.title) % 990) / 10).toFixed(1)}万
                  </span>
                </span>
              </Thumb>
            </button>
          ))}
        </div>
      </Scroll>
    </div>
  );
}

function YouTubeApp({ items, ctx, sheet }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white">
      <TopBar left={<BackGlass onClick={ctx.close} />} title="历史记录" right={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />} />
      <Scroll pad={50}>
        <div className="mx-4 mb-3 flex h-10 items-center gap-2 rounded-full bg-[#f2f2f2] px-4 text-[15px] text-[#606060]">
          <Search size={17} />
          搜索观看记录
        </div>
        {!items.length && <EmptyState text="没有观看记录" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.map((it) => (
          <div key={it.id} onClick={() => sheet(it)} className="flex cursor-pointer gap-3 px-4 py-2.5 active:bg-black/[0.04]">
            <Thumb seed={it.id + it.title} className="h-[94px] w-[168px] shrink-0 rounded-[10px]">
              <span className="absolute bottom-1.5 right-1.5 rounded-[4px] bg-black/80 px-1 text-[11px] font-medium text-white">
                {(hash(it.id) % 18) + 1}:{String(hash(it.title) % 60).padStart(2, "0")}
              </span>
              <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/40">
                <span className="block h-full bg-[#ff0033]" style={{ width: `${30 + (hash(it.id) % 70)}%` }} />
              </span>
            </Thumb>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[15px] font-medium leading-snug text-[#0f0f0f]">{it.title}</p>
              <p className="mt-1 text-[13px] text-[#606060]">{it.value}</p>
              <p className="text-[13px] text-[#606060]">{it.time}</p>
            </div>
            <Ellipsis size={18} className="shrink-0 rotate-90 text-[#606060]" />
          </div>
        ))}
      </Scroll>
    </div>
  );
}

/* ================= Safari（历史记录 + 无痕） ================= */

function SafariApp({ items, ctx, sheet, privItems, privCtx }) {
  const [priv, setPriv] = useState(false);
  const list = priv ? privItems : items;
  const c = priv ? privCtx : ctx;
  const groups = useMemo(() => {
    const order = ["今天", "昨天", "前天", "更早"];
    const map = new Map(order.map((k) => [k, []]));
    for (const it of list) map.get(dayOf(it.time)).push(it);
    return order.map((k) => [k, map.get(k)]).filter(([, l]) => l.length);
  }, [list]);
  const dark = priv;
  useDarkStatus(ctx, priv);
  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${dark ? "bg-[#1c1c1e]" : "bg-[#f2f2f7]"}`}>
      <TopBar dark={dark} left={<Glass dark={dark}>清除</Glass>} title={priv ? "无痕浏览" : "历史记录"} right={<RefreshGlass dark={dark} busy={c.busy} onClick={c.onRefresh} />} />
      <div className={`mx-auto mb-3 flex w-[230px] rounded-full p-[3px] text-[14px] font-medium ${dark ? "bg-white/10" : "bg-[#767680]/[0.12]"}`}>
        {[
          [false, "历史记录"],
          [true, "无痕"],
        ].map(([v, l]) => (
          <button
            key={l}
            type="button"
            onClick={() => setPriv(v)}
            className={`flex-1 rounded-full py-1.5 ${priv === v ? (dark ? "bg-white/20 text-white" : "bg-white shadow-sm") : dark ? "text-white/60" : "text-black"}`}
          >
            {l}
          </button>
        ))}
      </div>
      <Scroll pad={140}>
        {!list.length && <EmptyState dark={dark} text={priv ? "没有无痕记录" : "没有浏览记录"} onRefresh={c.onRefresh} busy={c.busy} />}
        {groups.map(([day, rows]) => (
          <div key={day} className="mb-4">
            <p className={`px-8 pb-1.5 text-[14px] ${dark ? "text-white/50" : "text-[#6d6d72]"}`}>{day}</p>
            <Card27 dark={dark}>
              {rows.map((it, i) => {
                const search = /搜索|search/i.test(it.value) || !it.value;
                return (
                  <Row27 key={it.id} onClick={() => sheet(it, priv ? "incognito" : "browser")} last={i === rows.length - 1} inset={62}>
                    <span
                      className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] text-[15px] font-semibold"
                      style={{
                        background: search ? (dark ? "#3a3a3c" : "#e9e9eb") : `hsl(${hash(it.value) % 360} 55% ${dark ? 30 : 92}%)`,
                        color: search ? "#8e8e93" : `hsl(${hash(it.value) % 360} 45% ${dark ? 80 : 38}%)`,
                      }}
                    >
                      {search ? <Search size={16} /> : it.value.slice(0, 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-[17px] ${dark ? "text-white" : "text-black"}`}>{it.title}</p>
                      <p className="truncate text-[14px] text-[#8e8e93]">{search ? `搜索 · ${it.detail || it.title}` : `${it.value} — ${it.detail}`}</p>
                    </div>
                  </Row27>
                );
              })}
            </Card27>
          </div>
        ))}
      </Scroll>
      <div className={`absolute inset-x-0 bottom-0 px-4 pb-8 pt-2 backdrop-blur-xl ${dark ? "bg-[#1c1c1e]/90" : "bg-[#f9f9f9]/90"}`}>
        <div className={`mb-2.5 flex h-[46px] items-center justify-center gap-1.5 rounded-full text-[16px] ${dark ? "bg-white/10 text-white/60" : "bg-white text-[#8e8e93] shadow-[0_1px_6px_rgba(0,0,0,.08)]"}`}>
          <Search size={16} />
          {priv ? "无痕浏览" : "搜索或输入网站名称"}
        </div>
        <div className="flex justify-between px-4 text-[#007aff]">
          <ChevronLeft size={26} />
          <ChevronRight size={26} className="opacity-30" />
          <Share size={23} />
          <BookOpen size={23} />
          <button type="button" onClick={() => setPriv((v) => !v)} aria-label="切换无痕">
            <Grid3x3 size={23} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= 钱包（沿用上一版） ================= */

function WalletApp({ items, ctx, sheet }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#f2f2f7]">
      <TopBar
        left={<BackGlass onClick={ctx.close} />}
        title="钱包"
        right={
          <>
            <RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />
            <Glass label="添加" className="!px-0">
              <Plus size={22} />
            </Glass>
          </>
        }
      />
      <Scroll pad={50}>
        <div className="relative mx-4 mb-5 mt-2 h-[236px]">
          <div className="absolute inset-x-0 top-0 h-[150px] rounded-[18px] bg-gradient-to-br from-[#2f6fde] to-[#1d4aa8] p-4 text-white shadow">
            <p className="text-[14px] font-semibold opacity-90">储蓄卡</p>
          </div>
          <div className="absolute inset-x-0 top-[36px] h-[150px] rounded-[18px] bg-gradient-to-br from-[#e8b04a] to-[#c27c1c] p-4 text-white shadow">
            <p className="text-[14px] font-semibold opacity-90">信用卡 ···· 6688</p>
          </div>
          <div className="absolute inset-x-0 top-[72px] h-[164px] rounded-[18px] bg-gradient-to-br from-[#1c1c1e] to-[#3a3a3c] p-4 text-white shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-[16px] font-semibold">零钱</span>
              <span className="text-[12px] opacity-60">可用余额</span>
            </div>
            <p className="mt-6 text-[36px] font-semibold tracking-tight">{ctx.balance || "¥—"}</p>
            <p className="mt-1 text-[13px] opacity-60">{ctx.roleName}</p>
          </div>
        </div>
        <div className="mb-2 flex items-baseline justify-between px-6">
          <p className="text-[22px] font-bold text-black">最近交易</p>
          <span className="text-[16px] text-[#007aff]">全部</span>
        </div>
        {!items.length && <EmptyState text="还没有交易" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
        {items.length > 0 && (
          <Card27>
            {items.map((it, i) => {
              const minus = isMinus(it.value);
              return (
                <Row27 key={it.id} onClick={() => sheet(it)} last={i === items.length - 1} inset={68}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[16px] font-semibold text-white" style={{ background: `hsl(${hash(it.title) % 360} 50% 55%)` }}>
                    {it.title.slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[17px] font-semibold text-black">{it.title}</p>
                    <p className="truncate text-[14px] text-[#8e8e93]">{it.detail}</p>
                    {it.time && <p className="text-[13px] text-[#8e8e93]">{it.time}</p>}
                  </div>
                  <span className={`shrink-0 text-[17px] ${minus ? "text-black" : "text-[#34c759]"}`}>{it.value}</span>
                </Row27>
              );
            })}
          </Card27>
        )}
      </Scroll>
    </div>
  );
}

/* ================= 地图（沿用上一版） ================= */

const APP_BAND = [0.14, 0.4];
const WIDGET_BAND = [0.3, 0.6];

/**
 * 假地图 + 今天的路线。按 items 的标题做种子，同一批数据每次画出来一样。
 * @param {number} h 画布高度（宽固定 393），要和容器长宽比接近，不然 slice 会把两边裁掉
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
    const n = Math.max(1, Math.min(items.length, 10));
    const [top, bottom] = band;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? W / 2 : 60 + (i * (W - 120)) / (n - 1) + (r() - 0.5) * 24;
      pts.push([Math.round(x), Math.round(h * (top + r() * (bottom - top)))]);
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

function MapsApp({ items, ctx, sheet }) {
  const where = items.length ? String(items.at(-1).title).split(/→|->|—>/).pop().trim() : "";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <RouteMap items={items} />
      <div className="relative z-10">
        <TopBar
          left={<BackGlass onClick={ctx.close} />}
          title=""
          right={
            <>
              <RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />
              <Glass className="!px-0">
                <ArrowUpRight size={20} className="text-[#007aff]" />
              </Glass>
            </>
          }
        />
      </div>
      <div className="absolute inset-x-2 bottom-2 z-10 flex max-h-[56%] flex-col rounded-[32px] bg-white/95 shadow-[0_-4px_24px_rgba(0,0,0,.14)] backdrop-blur-xl">
        <span className="mx-auto mt-2 h-[5px] w-10 shrink-0 rounded-full bg-[#c7c7cc]" />
        <div className="shrink-0 px-5 pb-2 pt-2">
          <p className="text-[24px] font-bold text-black">今天</p>
          <p className="text-[14px] text-[#8e8e93]">{items.length ? `${items.length} 段行程 · 现在在 ${where}` : "还没有行程"}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 [scrollbar-width:none]">
          {!items.length && <EmptyState text="今天还没出门" onRefresh={ctx.onRefresh} busy={ctx.busy} />}
          {items.map((it, i) => (
            <div key={it.id} onClick={() => sheet(it)} className="flex cursor-pointer gap-3 active:opacity-70">
              <div className="flex w-7 flex-col items-center">
                <span className="mt-1 flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-bold text-white" style={{ background: i === items.length - 1 ? "#ff3b30" : "#0a84ff" }}>
                  {i + 1}
                </span>
                {i < items.length - 1 && <span className="my-1 w-[2px] flex-1 bg-[#d1d1d6]" />}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <p className="text-[13px] text-[#8e8e93]">{it.value || it.time}</p>
                <p className="text-[17px] font-semibold text-black">{it.title}</p>
                {it.detail && <p className="text-[14.5px] leading-snug text-[#3c3c43]">{it.detail}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================= 自定义 App ================= */

function CustomApp({ items, ctx, sheet, app }) {
  const color = app.color ?? BLUE;
  if (app.layout === "shop") return <TaobaoApp items={items} ctx={ctx} sheet={sheet} />;
  const head = <TopBar left={<BackGlass onClick={ctx.close} />} title={app.name} right={<RefreshGlass busy={ctx.busy} onClick={ctx.onRefresh} />} />;
  const empty = !items.length && <EmptyState text="还没有内容" onRefresh={ctx.onRefresh} busy={ctx.busy} />;
  if (app.layout === "feed") {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-white">
        {head}
        <Scroll pad={50}>
          {empty}
          {items.map((it) => (
            <div key={it.id} onClick={() => sheet(it)} className="flex cursor-pointer gap-3 border-b border-[#efeff4] px-4 py-3.5 active:bg-black/[0.03]">
              <Avatar name={ctx.roleName} size={44} initials tint={`linear-gradient(180deg, ${color}aa, ${color})`} />
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-semibold" style={{ color }}>
                  {ctx.roleName}
                </p>
                {it.title && <p className="text-[14px] text-[#8e8e93]">{it.title}</p>}
                <p className="mt-1 whitespace-pre-wrap text-[16px] leading-snug text-black">{it.detail}</p>
                <div className="mt-2 flex items-center gap-4 text-[14px] text-[#8e8e93]">
                  <span>{it.time}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <Heart size={15} /> {it.value || ""}
                  </span>
                  <MessageCircle size={15} />
                </div>
              </div>
            </div>
          ))}
        </Scroll>
      </div>
    );
  }
  if (app.layout === "forum") {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-[#f4f4f4]">
        {head}
        <Scroll pad={50}>
          {empty}
          {items.map((it) => (
            <div key={it.id} onClick={() => sheet(it)} className="mx-3 mb-2.5 cursor-pointer rounded-[18px] bg-white p-4 active:opacity-80">
              {it.value && (
                <span className="mb-1.5 inline-block rounded-[6px] px-2 py-0.5 text-[12px] text-white" style={{ background: color }}>
                  {it.value}
                </span>
              )}
              <p className="text-[17px] font-semibold leading-snug text-black">{it.title}</p>
              <p className="mt-1 line-clamp-3 text-[15px] leading-snug text-[#555]">{it.detail}</p>
              <p className="mt-2 text-[13px] text-[#999]">
                楼主 {ctx.roleName} · {it.time}
              </p>
            </div>
          ))}
        </Scroll>
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#f2f2f7]">
      {head}
      <Scroll pad={50}>
        {empty}
        {items.length > 0 && (
          <Card27>
            {items.map((it, i) => (
              <Row27 key={it.id} onClick={() => sheet(it)} last={i === items.length - 1}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[17px] text-black">{it.title}</p>
                    {it.value && <span className="shrink-0 text-[15px] text-[#8e8e93]">{it.value}</span>}
                  </div>
                  <p className="line-clamp-2 text-[15px] leading-snug text-[#8e8e93]">{it.detail}</p>
                </div>
                <ChevronRight size={18} className="text-[#c7c7cc]" />
              </Row27>
            ))}
          </Card27>
        )}
      </Scroll>
    </div>
  );
}

/* ================= 状态栏 / 锁屏 / 桌面 ================= */

/** 状态栏的电池：白底里写着电量数字（iOS 27 那样）。 */
function Battery({ dark }) {
  return (
    <span className="flex items-center">
      <span className={`flex h-[14px] w-[28px] items-center justify-center rounded-[4.5px] text-[10.5px] font-bold leading-none ${dark ? "bg-black text-white" : "bg-white text-black"}`}>76</span>
      <span className={`ml-[1px] h-[5px] w-[2px] rounded-r ${dark ? "bg-black/40" : "bg-white/50"}`} />
    </span>
  );
}

function StatusBar({ now, dark, showTime }) {
  return (
    <div className={`relative z-30 flex h-[54px] shrink-0 items-center justify-between px-[34px] pt-[6px] text-[17px] font-semibold ${dark ? "text-black" : "text-white"}`}>
      <span className="w-[60px] text-center">{showTime ? hhmm(now) : ""}</span>
      <span className="absolute left-1/2 top-[11px] h-[36px] w-[124px] -translate-x-1/2 rounded-full bg-black" />
      <span className="flex items-center gap-[6px]">
        <svg viewBox="0 0 18 12" width="18" height="12" fill="currentColor">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg viewBox="0 0 16 12" width="16" height="12" fill="currentColor">
          <path d="M8 2.2c2.4 0 4.6.9 6.3 2.5l1.2-1.3C13.5 1.5 10.9.4 8 .4S2.5 1.5.5 3.4l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.5c1.5 0 2.8.5 3.8 1.5l1.2-1.3C11.6 4.6 9.9 3.9 8 3.9s-3.6.7-5 2l1.2 1.3c1-1 2.3-1.5 3.8-1.5zM8 9.3l2.3-2.4A3.4 3.4 0 008 6a3.4 3.4 0 00-2.3.9z" />
        </svg>
        <Battery dark={dark} />
      </span>
    </div>
  );
}

function LockScreen({ now, wallpaper, notes, onUnlock, icons, skins }) {
  return (
    <div className="absolute inset-0 z-[35] flex cursor-pointer flex-col" style={{ background: wallpaper }} onClick={onUnlock}>
      <div className="h-[60px]" />
      <div className="text-center text-white [text-shadow:0_1px_10px_rgba(0,0,0,.18)]">
        <p className="text-[20px] font-semibold opacity-90">
          {now.getMonth() + 1}月{now.getDate()}日 星期{WEEK[now.getDay()]}
        </p>
        <p className="-mt-1 text-[96px] font-semibold leading-none tracking-[-0.03em]">{hhmm(now)}</p>
      </div>
      <div className="mt-auto space-y-2 px-3 pb-3">
        {notes.map((n) => (
          <div key={n.key} className="flex gap-3 rounded-[24px] bg-white/55 px-3.5 py-3 backdrop-blur-2xl">
            <span className="mt-0.5 h-[38px] w-[38px] shrink-0 overflow-hidden rounded-[9px]">
              <AppIcon app={n.app} size={38} label={false} image={icons?.[n.app.id]} skin={skins?.[n.app.id]} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[15px] font-semibold text-black">{n.app.id === "chat" ? n.item.title : n.app.name}</span>
                <span className="shrink-0 text-[13px] text-black/50">{n.item.time || "现在"}</span>
              </div>
              <p className="line-clamp-2 text-[15px] leading-snug text-black/80">{n.text}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-12 pb-11">
        <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-black/25 text-white backdrop-blur">
          <Flashlight size={22} />
        </span>
        <span className="text-[14px] text-white/85">点一下解锁</span>
        <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-black/25 text-white backdrop-blur">
          <Camera size={22} />
        </span>
      </div>
    </div>
  );
}

function Widgets({ now, track, roleName }) {
  const where = track.length ? String(track.at(-1).title).split(/→|->|—>/).pop().trim() : "";
  return (
    <div className="grid grid-cols-2 gap-[22px] px-[26px] pt-3">
      <div>
        <div className="h-[158px] rounded-[26px] bg-white p-4 shadow-[0_2px_10px_rgba(0,0,0,.1)]">
          <p className="text-[13px] font-semibold text-[#ff3b30]">星期{WEEK[now.getDay()]}</p>
          <p className="text-[48px] font-light leading-none text-black">{now.getDate()}</p>
          <p className="mt-4 line-clamp-2 text-[13px] leading-snug text-[#3c3c43]">{track.length ? `今天去过 ${track.length} 个地方` : "今天没有日程"}</p>
        </div>
        <p className="mt-1.5 text-center text-[12px] font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,.4)]">日历</p>
      </div>
      <div>
        <div className="relative h-[158px] overflow-hidden rounded-[26px] shadow-[0_2px_10px_rgba(0,0,0,.1)]">
          <RouteMap items={track} h={393} band={WIDGET_BAND} />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/90 to-transparent px-3.5 pb-3 pt-7">
            <p className="text-[12px] text-[#8e8e93]">{roleName} 现在在</p>
            <p className="truncate text-[14px] font-semibold text-black">{where || "未知位置"}</p>
          </div>
        </div>
        <p className="mt-1.5 text-center text-[12px] font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,.4)]">地图</p>
      </div>
    </div>
  );
}

/* ================= 整机 ================= */

/** Dock 里的四个；无痕浏览在 Safari 里面，不单独上桌面。 */
export const DOCK = ["call", "chat", "browser", "settings"];
const HIDDEN = new Set(["incognito"]);

/** 跟着容器宽度算缩放比例；全屏时按窗口算。 */
function useScale(ref, full) {
  const [s, setS] = useState(0.8);
  useLayoutEffect(() => {
    const calc = () => {
      if (full) setS(Math.min((window.innerWidth * 0.98) / DEV_W, (window.innerHeight * 0.96) / DEV_H));
      else if (ref.current) setS(Math.min(1, ref.current.getBoundingClientRect().width / DEV_W));
    };
    calc();
    const ro = new ResizeObserver(calc);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", calc);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", calc);
    };
  }, [ref, full]);
  return s;
}

/**
 * @param {object} props
 * @param {object} props.data       /api/phone/:roleId 的 state
 * @param {object[]} props.apps     [{id, name, custom?, icon?, color?, layout?}]，含「设置」
 * @param {Set<string>} props.busyApps
 * @param {(appId: string) => void} props.onRefresh
 * @param {(appId: string, itemId: string) => void} props.onDelete
 * @param {(close: () => void) => any} props.renderSettings 手机里「设置」App 的内容（phonesettings.jsx）
 */
export function IPhone(props) {
  const { roleId } = props;
  const slot = useRef(null);
  const [full, setFull] = useState(false);
  const scale = useScale(slot, full);
  const [inlineH, setInlineH] = useState(0);

  // 锁屏 / 打开的 App 放在这一层：切全屏时手机会重新挂一次，这两样不能丢
  const [locked, setLocked] = useState(true);
  const [open, setOpen] = useState(null);
  const roleRef = useRef(roleId);
  useEffect(() => {
    if (roleRef.current === roleId) return;
    roleRef.current = roleId;
    setLocked(true);
    setOpen(null);
  }, [roleId]);

  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const device = (
    <div style={{ width: DEV_W * scale, height: DEV_H * scale }}>
      <div style={{ width: DEV_W, height: DEV_H, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <Device {...props} locked={locked} setLocked={setLocked} open={open} setOpen={setOpen} />
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full" style={{ maxWidth: "min(400px, calc((100dvh - 120px) * 0.476))" }}>
      <div ref={slot} className="relative w-full">
        {full ? <div style={{ height: inlineH }} /> : device}
        {!full && (
          <button
            type="button"
            onClick={() => {
              setInlineH(slot.current?.getBoundingClientRect().height ?? 0);
              setFull(true);
            }}
            aria-label="全屏看"
            className="absolute -right-2 -top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-line bg-paper text-ink-soft hover:text-ink"
          >
            <Maximize2 size={15} />
          </button>
        )}
      </div>
      {full &&
        createPortal(
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-sm" onClick={() => setFull(false)}>
            <div onClick={(e) => e.stopPropagation()}>{device}</div>
            <button type="button" onClick={() => setFull(false)} aria-label="退出全屏" className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white">
              <X size={20} />
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

function Device({ data, apps, busyApps, onRefresh, onDelete, roleName, roleId, wallpaper, renderSettings, locked, setLocked, open, setOpen }) {
  const now = useClock();
  const [sheet, setSheet] = useState(null); // {appId, appName, item}
  const [screenDark, setScreenDark] = useState(false); // 页面自己报的「我是深色的」
  const skins = data.skins ?? {};
  const icons = data.icons ?? {};
  const wp = data.wallpaperImage ? `center / cover no-repeat url(${data.wallpaperImage})` : (WALLPAPERS[wallpaper] ?? WALLPAPERS.ocean).css;

  // 「看过了」的时间按角色 + App 记在 localStorage：桌面角标、信息里的蓝点
  const seenKey = `uranus.phone.seen.${roleId}`;
  const [seen, setSeen] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(seenKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const [seenBefore, setSeenBefore] = useState(0);
  const markSeen = (id) => {
    const next = { ...seen, [id]: Date.now() };
    setSeen(next);
    try {
      localStorage.setItem(seenKey, JSON.stringify(next));
    } catch {
      /* 存不进就算了 */
    }
  };

  const itemsOf = (id) => data.apps?.[id] ?? [];
  const newCount = (id) => itemsOf(id).filter((x) => (x.at ?? 0) > (seen[id] ?? 0)).length;

  const notes = useMemo(() => {
    const out = [];
    const NOTIFY = new Set(["chat", "call", "shop", "delivery", "wallet"]);
    for (const a of apps.filter((x) => NOTIFY.has(x.id) || x.custom)) {
      for (const it of (data.apps?.[a.id] ?? []).slice(0, 2)) {
        if (a.id === "call" && callKind(it.value) !== "missed") continue;
        const text =
          a.id === "chat"
            ? parseThread(it.detail, data.separator).at(-1)?.text ?? it.detail
            : a.id === "call"
              ? `未接来电：${it.title}`
              : `${it.title}${it.value ? ` · ${it.value}` : ""}`;
        out.push({ key: `${a.id}-${it.id}`, app: a, item: it, text, at: it.at ?? 0 });
      }
    }
    return out.sort((x, y) => y.at - x.at).slice(0, 4);
  }, [apps, data.apps, data.separator]);

  const go = (id) => {
    setSeenBefore(seen[id] ?? 0);
    setOpen(id);
    setLocked(false);
    markSeen(id);
  };
  const close = () => {
    setOpen(null);
    setSheet(null);
  };

  const app = apps.find((a) => a.id === open);
  const ctxOf = (id) => ({
    busy: busyApps.has(id),
    onRefresh: () => onRefresh(id),
    onDelete: (itemId) => onDelete(id, itemId),
    close,
    roleName,
    userName: data.userName,
    userThread: data.userThread ?? [],
    balance: data.walletBalance,
    sep: data.separator ?? "$",
    isNew: (it) => (it.at ?? 0) > seenBefore,
    setDark: setScreenDark,
  });
  const sheetOpen = (item, appId = open) => setSheet({ appId, appName: apps.find((a) => a.id === appId)?.name, item });

  let body = null;
  if (app) {
    const props = { items: itemsOf(app.id), ctx: ctxOf(app.id), sheet: sheetOpen, app };
    const skin = skins[app.id];
    if (app.id === "settings") body = renderSettings?.(close);
    else if (app.id === "chat") body = <MessagesApp {...props} />;
    else if (app.id === "call") body = <PhoneApp {...props} contactsCtx={{ ...ctxOf("contacts"), items: itemsOf("contacts") }} />;
    else if (app.id === "contacts") body = <ContactsApp {...props} />;
    else if (app.id === "shop") body = skin === "amazon" ? <AmazonApp {...props} /> : <TaobaoApp {...props} />;
    else if (app.id === "delivery") body = skin === "doordash" ? <DoorDashApp {...props} /> : <MeituanApp {...props} />;
    else if (app.id === "video") body = skin === "youtube" ? <YouTubeApp {...props} /> : <ShortVideoApp {...props} skinName={app.name} />;
    else if (app.id === "browser") body = <SafariApp {...props} privItems={itemsOf("incognito")} privCtx={ctxOf("incognito")} />;
    else if (app.id === "wallet") body = <WalletApp {...props} />;
    else if (app.id === "track") body = <MapsApp {...props} />;
    else if (app.id === "favorites") body = <FilesApp {...props} />;
    else body = <CustomApp {...props} />;
  }

  const darkApp = open === "video" && skins.video !== "youtube";
  const lightStatus = locked || !open || darkApp || screenDark;
  const grid = apps.filter((a) => !DOCK.includes(a.id) && !HIDDEN.has(a.id));
  const dock = DOCK.map((id) => apps.find((a) => a.id === id)).filter(Boolean);
  const iconProps = (a) => ({ image: icons[a.id], skin: skins[a.id] });

  return (
    <div
      className="relative h-full w-full rounded-[64px] p-[3px]"
      style={{
        background: "linear-gradient(145deg,#9c9ba1 0%,#45444a 18%,#2c2b30 50%,#5f5e64 82%,#a3a2a7 100%)",
        boxShadow: "0 30px 60px -20px rgba(0,0,0,.45), 0 10px 20px -10px rgba(0,0,0,.3)",
        fontFamily: SF,
      }}
    >
      <style>{`@keyframes uranusAppIn{from{transform:scale(.92);opacity:0}to{transform:none;opacity:1}}`}</style>
      <span className="absolute -left-[3px] top-[17%] h-[4%] w-[4px] rounded-l bg-[#4a494f]" />
      <span className="absolute -left-[3px] top-[24.5%] h-[7%] w-[4px] rounded-l bg-[#4a494f]" />
      <span className="absolute -left-[3px] top-[33%] h-[7%] w-[4px] rounded-l bg-[#4a494f]" />
      <span className="absolute -right-[3px] top-[28%] h-[11%] w-[4px] rounded-r bg-[#4a494f]" />
      <div className="h-full rounded-[61px] bg-black p-[9px]">
        <div className="relative flex h-full flex-col overflow-hidden rounded-[54px] bg-black">
          <StatusBar now={now} dark={!lightStatus} showTime={!locked} />

          {/* 桌面（一直垫在底下） */}
          <div className="absolute inset-0 flex flex-col" style={{ background: wp }}>
            <div className="h-[54px]" />
            <Widgets now={now} track={itemsOf("track")} roleName={roleName} />
            <div className="grid grid-cols-4 gap-y-[26px] px-[22px] pt-[26px]">
              {grid.map((a) => (
                <AppIcon key={a.id} app={a} onClick={() => go(a.id)} badge={newCount(a.id)} {...iconProps(a)} />
              ))}
            </div>
            <div className="flex-1" />
            <div className="mx-auto mb-4 flex h-[32px] items-center gap-1.5 rounded-full border border-white/20 bg-white/20 px-4 text-[14px] font-medium text-white backdrop-blur-md">
              <Search size={14} strokeWidth={2.6} />
              搜索
            </div>
            <div className="mx-[14px] mb-[24px] flex justify-around rounded-[38px] border border-white/25 bg-white/25 px-3 py-[16px] backdrop-blur-2xl">
              {dock.map((a) => (
                <AppIcon key={a.id} app={a} label={false} onClick={() => go(a.id)} badge={a.id === "settings" ? 0 : newCount(a.id)} {...iconProps(a)} />
              ))}
            </div>
          </div>

          {open && app && (
            <div
              key={open}
              // 状态栏那 54px 让每个页面自己的底色铺上去（深色名片页、黄色外卖页顶上不会剩一条白）
              className="absolute inset-0 z-20 flex flex-col [&>div:first-child]:pt-[54px]"
              style={{ animation: "uranusAppIn .22s ease-out", background: darkApp ? "#000" : "#fff" }}
            >
              {body}
              <ActionSheet
                item={sheet?.item}
                appName={sheet?.appName}
                onDelete={(id) => onDelete(sheet.appId, id)}
                onClose={() => setSheet(null)}
                dark={sheet?.appId === "incognito" || (sheet?.appId === "video" && skins.video !== "youtube")}
              />
            </div>
          )}

          {locked && <LockScreen now={now} wallpaper={wp} notes={notes} onUnlock={() => setLocked(false)} icons={icons} skins={skins} />}

          {/* Home 条：App 里点一下回桌面；桌面上点一下锁屏 */}
          <button
            type="button"
            aria-label={open ? "回到桌面" : "锁屏"}
            onClick={() => (open ? close() : setLocked(true))}
            className="absolute bottom-[8px] left-1/2 z-50 h-[5px] w-[140px] -translate-x-1/2 rounded-full"
            style={{ background: open && !darkApp && !screenDark && open !== "track" ? "#000" : "#fff" }}
          />
        </div>
      </div>
    </div>
  );
}
