/**
 * 界面上所有的「几点几分」都按**服务端的时区**算，不按浏览器的。
 *
 * 服务跑在 VPS 上，记忆的日期、日记流水的时间、角色消息里的时间前缀全是服务端
 * 按它自己的时区写的。界面要是按浏览器的时区显示，手机在 CST、VPS 在 PDT 的时候
 * 同一个时刻就会差出十几个小时，「手加一条记忆」默认的那个「今天」也会是 CST 的今天。
 *
 * 时区由 AuthGate 进门时从 /api/auth/state 拿到后设进来（setServerZone），
 * 在那之前界面一个面板都不画，所以用到这里的地方拿到的一定是服务端的时区。
 * 拿不到（老后端没有这个字段）就退回浏览器时区，跟以前一样。
 */

let zone = "";
const formatters = new Map();

export function setServerZone(tz) {
  const name = String(tz ?? "").trim();
  if (!name) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(0);
    zone = name;
    formatters.clear();
  } catch {
    // 时区名浏览器不认：保持浏览器时区
  }
}

export function serverZone() {
  return zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatter() {
  const key = zone || "";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      ...(zone ? { timeZone: zone } : {}),
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(key, f);
  }
  return f;
}

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 某个时刻在服务端时区里的年月日时分秒。month 从 1 开始，dow 周日是 0。 */
export function zoned(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = Object.fromEntries(formatter().formatToParts(d).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    // 个别引擎在午夜给 "24"
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
    ms: d.getMilliseconds(),
    dow: WEEK.indexOf(p.weekday),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** 服务端时区的今天，`YYYY-MM-DD`。 */
export function todayKey(ts = Date.now()) {
  const z = zoned(ts);
  return `${z.y}-${pad(z.m)}-${pad(z.d)}`;
}

/** `14:03:27` */
export function fmtClock(ts) {
  const z = zoned(ts);
  return `${pad(z.h)}:${pad(z.mi)}:${pad(z.s)}`;
}

/** `2026-09-27 14:03:27` */
export function fmtDateTime(ts) {
  const z = zoned(ts);
  return `${z.y}-${pad(z.m)}-${pad(z.d)} ${pad(z.h)}:${pad(z.mi)}:${pad(z.s)}`;
}
