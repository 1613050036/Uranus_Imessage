/**
 * 离线自测：位置这一摊 —— iPhone「平安确认」卡片（card.js）、位置推送的纯逻辑
 * （friendloc.js）、定时器（watchFriendLocations）、配置规整（config.js），
 * 以及 imessage.js 里把位置送进会话的那一段（handleFriendLocations）。
 *
 * **不打真的 Photon。** `server/src/photongrpc.js` 用 node:test 的 mock.module
 * 换成假的（所以这个文件必须带 `--experimental-test-module-mocks` 跑）：
 * 假客户端的 `locations.list()` 还什么、抛不抛错，由测试自己说了算。
 * card.js 那几条不传 projectId，本来就不会去联网。
 *
 * handleFriendLocations 不是导出的，而且它身后挂着整个桥接。按 test-queue.mjs
 * 的办法把那几个函数从源码里抠出来，放进一个喂了假依赖的作用域里重建 ——
 * 测的是**真的那段代码**，改了源码这里就跟着变。
 *
 * URANUS_DATA_DIR 指向临时目录，绝不碰真实的 data/。必须在 import 之前设好，
 * 所以这个文件用动态 import。
 *
 * 跑：node --experimental-test-module-mocks scripts/test-location.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-location-"));
process.env.URANUS_DATA_DIR = tmp;

let passed = 0;
function okWith(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个条件成立，最多等 ms 毫秒 —— 定时器在后台跑，不能靠固定睡眠。 */
async function waitFor(what, fn, ms = 1500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error(`等不到：${what}`);
}

/** 临时把 Date.now 拨到某个时刻（验 30 秒窗口，不能真等 30 秒）。 */
async function atTime(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/* ================= 假的 photongrpc ================= */

const photon = {
  /** 每次 createLineClients 开几条线路；每条线路的 list 行为 */
  lines: [{ id: "L1" }],
  /** instanceId -> () => Promise<list>；没给就还 photon.result */
  listImpl: {},
  result: [],
  /** createLineClients 自己抛 */
  createThrows: false,
  created: 0,
  listCalls: 0,
  closed: 0,
  /** address -> (lineId) => 位置；没有的号码 get 抛 NotFoundError */
  getImpl: {},
  getCalls: [],
  /** messageGuid -> 原始消息（card.js:fetchCardDetail 会问）；给 Error 就抛 */
  messages: {},
};

mock.module(new URL("../server/src/photongrpc.js", import.meta.url).href, {
  namedExports: {
    CLOUD_URL: "http://127.0.0.1:9",
    SHARED_ADDRESS: "127.0.0.1:9",
    mintLines: async () => ({ lines: [] }),
    createLineClients: async () => {
      photon.created += 1;
      if (photon.createThrows) throw new Error("铸不出 token");
      return photon.lines.map((l) => ({
        address: "127.0.0.1:9",
        instanceId: l.id,
        client: {
          locations: {
            list: async () => {
              photon.listCalls += 1;
              const impl = photon.listImpl[l.id];
              return impl ? impl() : photon.result;
            },
            // 同真接口：没共享的号码抛 NotFoundError
            get: async (address) => {
              photon.getCalls.push(address);
              const impl = photon.getImpl[address];
              if (impl) return impl(l.id);
              const e = new Error("[upstream] Address is not currently sharing a location");
              e.name = "NotFoundError";
              throw e;
            },
          },
          messages: {
            get: async (guid) => {
              const hit = photon.messages[guid];
              if (hit instanceof Error) throw hit;
              if (!hit) throw new Error("没有这条消息");
              return hit;
            },
          },
          close: async () => {
            photon.closed += 1;
          },
        },
      }));
    },
    closeClients: async (list) => {
      for (const item of list ?? []) await item?.client?.close?.();
    },
  },
});

const LOGS = [];
const LOGMOD = await import("../server/src/logs.js");
LOGMOD.subscribe((e) => LOGS.push(e));

const CARD = await import("../server/src/card.js");
const FL = await import("../server/src/friendloc.js");
const C = await import("../server/src/config.js");

const CHECK_IN_BALLOON =
  "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.SafetyMonitorApp.SafetyMonitorMessages";
const START_TEXT =
  "[{{user}}发送了平安到达计时，如果到了时间用户还未确认，那么将会在15分钟后向你推送消息与共享{{user}}的位置。]";

/** 一张假的平安确认卡片。 */
const checkIn = (nativeText = "", extra = {}) => ({
  id: `msg-${Math.random().toString(36).slice(2)}`,
  balloonBundleId: CHECK_IN_BALLOON,
  nativeText,
  ...extra,
});

/* ================= 1. 平安确认卡片 ================= */

section("平安确认（card.js）");

await okAsync("卡片没字 → 发起文案一字不差", async () => {
  const hint = await CARD.cardHintFor(checkIn(), { chatGuid: "any;-;+18005550101" });
  assert.equal(hint, START_TEXT);
});

await okAsync("繁中「報平安：尚未按預期報平安，已共享位置」→ 超时，带原文", async () => {
  const text = "報平安：尚未按預期報平安，已共享位置";
  const hint = await CARD.cardHintFor(checkIn(text), { chatGuid: "any;-;+18005550102" });
  assert.match(hint, /「平安确认」超时了/);
  assert.match(hint, /具体在哪这边看不到/);
  assert.ok(hint.includes(`（原文：${text}）`), hint);
});

await okAsync("超时后紧跟着同一会话的空白件 → 吞掉（返回空串）", async () => {
  const chat = "any;-;+18005550103";
  const first = await CARD.cardHintFor(checkIn("報平安：尚未按預期報平安，已共享位置"), { chatGuid: chat });
  assert.match(first, /超时/);
  assert.equal(await CARD.cardHintFor(checkIn(), { chatGuid: chat }), "");
});

await okAsync("别的会话的空白件不吞", async () => {
  const a = "any;-;+18005550104";
  const b = "any;-;+18005550105";
  await CARD.cardHintFor(checkIn("報平安：尚未按預期報平安，已共享位置"), { chatGuid: a });
  assert.equal(await CARD.cardHintFor(checkIn(), { chatGuid: b }), START_TEXT);
});

await okAsync("过了 30 秒的空白件不吞，当新的发起", async () => {
  const chat = "any;-;+18005550106";
  const t0 = Date.now();
  await atTime(t0, () => CARD.cardHintFor(checkIn("報平安：尚未按預期報平安，已共享位置"), { chatGuid: chat }));
  const late = await atTime(t0 + 31_000, () => CARD.cardHintFor(checkIn(), { chatGuid: chat }));
  assert.equal(late, START_TEXT);
});

await okAsync("29 秒的空白件照样吞", async () => {
  const chat = "any;-;+18005550107";
  const t0 = Date.now();
  await atTime(t0, () => CARD.cardHintFor(checkIn("Check In: hasn't responded as expected"), { chatGuid: chat }));
  assert.equal(await atTime(t0 + 29_000, () => CARD.cardHintFor(checkIn(), { chatGuid: chat })), "");
});

await okAsync("带字的第二张不吞（只吞空白件）", async () => {
  const chat = "any;-;+18005550108";
  await CARD.cardHintFor(checkIn(), { chatGuid: chat });
  const hint = await CARD.cardHintFor(checkIn("報平安：已抵達"), { chatGuid: chat });
  assert.match(hint, /已经平安到达/);
});

await okAsync("用户实测那一串：超时 → 5 分钟后新发起 → 7 分钟后无字的结束件 → 有变化，不是又发起", async () => {
  const chat = "any;-;+18005550109";
  const t0 = Date.now();
  const at = (min, text) => atTime(t0 + min * 60_000, () => CARD.cardHintFor(checkIn(text), { chatGuid: chat }));
  assert.equal(await at(-17, ""), START_TEXT);
  assert.match(await at(0, "報平安：尚未按預期報平安，已共享位置"), /超时/);
  assert.equal(await at(5, ""), START_TEXT);
  const end = await at(12, "");
  assert.match(end, /「平安确认」有变化/);
  assert.match(end, /以\{\{user\}\}手机上的为准/);
  // 变化过一次就当这次收尾了：再来一张没字的是新的发起
  assert.equal(await at(20, ""), START_TEXT);
});

await okAsync("发起超过 12 小时再来的无字件 → 当新的发起", async () => {
  const chat = "any;-;+18005550110";
  const t0 = Date.now();
  await atTime(t0, () => CARD.cardHintFor(checkIn(), { chatGuid: chat }));
  const late = await atTime(t0 + 12 * 3600_000 + 1000, () => CARD.cardHintFor(checkIn(), { chatGuid: chat }));
  assert.equal(late, START_TEXT);
});

await okAsync("「報平安：上海市 示例路1号 (…)」→ 抵达时模式，读出目的地", async () => {
  const addr = "上海市 示例路1号 (某某地铁站A口步行100米)";
  const hint = await CARD.cardHintFor(checkIn(`報平安：${addr}`), { chatGuid: "any;-;+18005550111" });
  assert.ok(hint.includes(`到达「${addr}」时会自动通知你`), hint);
  assert.ok(!hint.includes("系统提示"), hint);
  const en = await CARD.cardHintFor(checkIn("Check In: 1 Infinite Loop"), { chatGuid: "any;-;+18005550112" });
  assert.ok(en.includes("到达「1 Infinite Loop」时"), en);
});

await okAsync("抵达时模式发起之后的无字件 → 有变化", async () => {
  const chat = "any;-;+18005550113";
  const t0 = Date.now();
  await atTime(t0, () => CARD.cardHintFor(checkIn("報平安：上海市 示例路1号"), { chatGuid: chat }));
  const next = await atTime(t0 + 60_000, () => CARD.cardHintFor(checkIn(), { chatGuid: chat }));
  assert.match(next, /「平安确认」有变化/);
});

await okAsync("没有 chatGuid 也没有 sessionId：不去重（不会误吞）", async () => {
  await CARD.cardHintFor(checkIn("報平安：尚未按預期報平安，已共享位置"));
  assert.equal(await CARD.cardHintFor(checkIn()), START_TEXT);
});

await okAsync("各状态：到达 / 结束 / 认不出", async () => {
  const g = (t, i) => CARD.cardHintFor(checkIn(t), { chatGuid: `any;-;+1800555020${i}` });
  assert.match(await g("報平安：已抵達", 1), /已经平安到达/);
  assert.match(await g("Check In: Arrived safely", 2), /已经平安到达/);
  assert.match(await g("報平安已結束", 3), /结束了这次「平安确认」/);
  assert.match(await g("Check In ended", 4), /结束了这次「平安确认」/);
  assert.match(await g("報平安", 5), /「平安确认」有更新（原文：報平安）/);
});

await okAsync("超时优先于到达（「尚未按預期到達」不能判成已到达）", async () => {
  const hint = await CARD.cardHintFor(checkIn("報平安：尚未按預期到達"), { chatGuid: "any;-;+18005550301" });
  assert.match(hint, /超时/);
});

await okAsync("英文超时 / 简中超时也认", async () => {
  assert.match(
    await CARD.cardHintFor(checkIn("Check In: Not responding as expected"), { chatGuid: "any;-;+18005550302" }),
    /超时/
  );
  assert.match(await CARD.cardHintFor(checkIn("平安确认：已超时"), { chatGuid: "any;-;+18005550303" }), /超时/);
});

await okAsync("原文超过 80 字会截断", async () => {
  const hint = await CARD.cardHintFor(checkIn("報".repeat(120)), { chatGuid: "any;-;+18005550304" });
  assert.ok(hint.includes(`${"報".repeat(80)}…`), hint);
  assert.ok(!hint.includes("報".repeat(81)));
});

await okAsync("bundleId 大小写不敏感；只有前缀不行", async () => {
  const upper = CHECK_IN_BALLOON.replace("SafetyMonitorApp", "SAFETYMONITORAPP");
  assert.equal(await CARD.cardHintFor({ balloonBundleId: upper }, { chatGuid: "any;-;+18005550305" }), START_TEXT);
  const other = await CARD.cardHintFor(
    { balloonBundleId: CHECK_IN_BALLOON.replace("SafetyMonitorApp", "SafetyMonitorAppX") },
    { chatGuid: "any;-;+18005550306" }
  );
  assert.ok(!other.includes("平安"), other);
});

okWith("checkInTrip：空 / 非 URL / 没参数 → null", () => {
  assert.equal(CARD.checkInTrip(""), null);
  assert.equal(CARD.checkInTrip(null), null);
  assert.equal(CARD.checkInTrip("不是网址"), null);
  assert.equal(CARD.checkInTrip("data:?x=1"), null);
  assert.equal(CARD.checkInTrip("https://example.com/checkin"), null);
  assert.equal(CARD.checkInTrip("https://example.com/?destination="), null);
});

okWith("checkInTrip：目的地 + ISO 时间", () => {
  const eta = "2026-09-29T16:45:00";
  const r = CARD.checkInTrip(`https://example.com/?destination=${encodeURIComponent("公司")}&eta=${eta}`);
  const d = new Date(eta);
  assert.deepEqual(r, {
    destination: "公司",
    eta: `${d.getMonth() + 1}月${d.getDate()}日 16:45`,
  });
});

okWith("checkInTrip：只有目的地 / 只有时间也算", () => {
  assert.deepEqual(CARD.checkInTrip("https://x.test/?placeName=Home"), { destination: "Home", eta: "" });
  const sec = 1790000000;
  const r = CARD.checkInTrip(`https://x.test/?expectedArrival=${sec}`);
  assert.equal(r.destination, "");
  const d = new Date(sec * 1000);
  assert.ok(r.eta.startsWith(`${d.getMonth() + 1}月${d.getDate()}日 `), r.eta);
});

okWith("checkInTrip：毫秒时间戳也认；认不出的时间原样给", () => {
  const ms = 1790000000123;
  const d = new Date(ms);
  assert.ok(CARD.checkInTrip(`https://x.test/?deadline=${ms}`).eta.startsWith(`${d.getMonth() + 1}月`));
  assert.equal(CARD.checkInTrip("https://x.test/?eta=soon").eta, "soon");
});

okWith("checkInTrip：坐标参数不当目的地", () => {
  assert.equal(CARD.checkInTrip("https://x.test/?destinationLat=31.2&destinationLng=121.4"), null);
  assert.deepEqual(CARD.checkInTrip("https://x.test/?destLat=31.2&destination=%E5%AE%B6"), {
    destination: "家",
    eta: "",
  });
});

okWith("checkInTrip：目的地超过 60 字截断", () => {
  const long = "路".repeat(70);
  assert.equal(CARD.checkInTrip(`https://x.test/?address=${encodeURIComponent(long)}`).destination, `${"路".repeat(60)}…`);
});

/*
 * 名字里「碰巧含着」关键字的参数不能当成目的地 / 预计到达：
 *  - metadata 里有 eta，sender 里有 end，appName / senderName 里有 name。
 * 平安确认的 url 长什么样还没见过实物，但 Apple 扩展的 url 里带 appName、
 * 发件人之类的字段很常见 —— 把发件人名字念成「到达『某某』时会自动通知你」
 * 就是给模型喂了一个编出来的目的地。
 */
okWith("checkInTrip：metadata / sender / appName 这类不误认", () => {
  assert.equal(CARD.checkInTrip("https://x.test/?metadata=abc&sender=%2B18005550100&appName=Check%20In"), null);
  assert.equal(CARD.checkInTrip("https://x.test/?senderName=Alex&theme=dark"), null);
});

/** 云端模式：假装 Photon 那边能读到这条消息的 miniApp。 */
const CLOUD = { projectId: "p", projectSecret: "s" };
const nativeCard = (mini) => ({ content: { miniApp: { appName: "", url: "", layout: null, live: true, ...mini } } });

await okAsync("云端：发起卡片 url 里读得出目的地 → 换成「抵达时」文案", async () => {
  const msg = checkIn();
  photon.messages[msg.id] = nativeCard({
    sessionId: "S-trip",
    url: `https://x.test/?destination=${encodeURIComponent("公司")}`,
  });
  const hint = await CARD.cardHintFor(msg, { ...CLOUD, chatGuid: "any;-;+18005550401" });
  assert.equal(
    hint,
    "[{{user}}发送了平安确认：到达「公司」时会自动通知你。如果{{user}}没按时到、也没回应，15分钟后会向你推送消息与共享{{user}}的位置。]"
  );
});

await okAsync("云端：排版里有字就用排版的字；读不到详情退回 nativeText", async () => {
  const a = checkIn("");
  photon.messages[a.id] = nativeCard({ sessionId: "S-a", layout: { caption: "報平安：已抵達" } });
  assert.match(await CARD.cardHintFor(a, { ...CLOUD, chatGuid: "any;-;+18005550402" }), /已经平安到达/);
  const b = checkIn("報平安：尚未按預期報平安，已共享位置");
  photon.messages[b.id] = new Error("读不到");
  assert.match(await CARD.cardHintFor(b, { ...CLOUD, chatGuid: "any;-;+18005550403" }), /超时/);
});

await okAsync("云端：同一个 sessionId 的空白件跨会话也吞", async () => {
  const a = checkIn("報平安：尚未按預期報平安，已共享位置");
  const b = checkIn();
  photon.messages[a.id] = nativeCard({ sessionId: "S-same" });
  photon.messages[b.id] = nativeCard({ sessionId: "S-same" });
  await CARD.cardHintFor(a, { ...CLOUD, chatGuid: "any;-;+18005550404" });
  assert.equal(await CARD.cardHintFor(b, { ...CLOUD, chatGuid: "any;-;+18005550405" }), "");
});

/*
 * 超时那条读得到详情（带 sessionId），紧跟着的空白件恰好没读到（best-effort，
 * 6 秒超时、线路抖一下都会）。两张一张记在 `s:` 下、一张查 `c:`，对不上 ——
 * 于是空白件被当成「对方又发起了一次平安确认」。
 */
await okAsync("云端：前一张有 sessionId、空白件没读到详情 —— 同会话照样吞", async () => {
  const chat = "any;-;+18005550406";
  const a = checkIn("報平安：尚未按預期報平安，已共享位置");
  const b = checkIn();
  photon.messages[a.id] = nativeCard({ sessionId: "S-mixed" });
  photon.messages[b.id] = new Error("这次没读到");
  assert.match(await CARD.cardHintFor(a, { ...CLOUD, chatGuid: chat }), /超时/);
  assert.equal(await CARD.cardHintFor(b, { ...CLOUD, chatGuid: chat }), "");
});

/* ================= 2. friendloc 纯逻辑 ================= */

/*
 * 实测（2026-09-30）：推过来的平安确认 text 永远是空的，字只在单独 messages.get
 * 那条消息的 content.text 里，而且有时要过一会儿才有。
 */
const SM = { projectId: "p", projectSecret: "s" };
const smMsg = (text) => ({
  guid: "x",
  content: { balloonBundleId: CHECK_IN_BALLOON, ...(text === undefined ? {} : { text }) },
});
CARD._setCheckInRetryMs([1, 1]);

await okAsync("事件里没字、get 出「報平安：地址」→ 抵达时模式带目的地", async () => {
  const m = checkIn();
  photon.messages[m.id] = smMsg("報平安：上海市 示例路1号(某某地铁站A口步行100米)");
  const hint = await CARD.cardHintFor(m, { ...SM, chatGuid: "any;-;+18005550301" });
  assert.ok(hint.includes("到达「上海市 示例路1号(某某地铁站A口步行100米)」时会自动通知你"), hint);
});

await okAsync("get 出「報平安：計時已開始」→ 计时发起，不当成目的地", async () => {
  const m = checkIn();
  photon.messages[m.id] = smMsg("報平安：計時已開始");
  assert.equal(await CARD.cardHintFor(m, { ...SM, chatGuid: "any;-;+18005550302" }), START_TEXT);
});

await okAsync("第一次 get 没字、重试时有了 → 用重试读到的", async () => {
  const m = checkIn();
  let n = 0;
  Object.defineProperty(photon.messages, m.id, {
    get: () => (n++ ? smMsg("報平安：計時已開始") : smMsg()),
    configurable: true,
  });
  assert.equal(await CARD.cardHintFor(m, { ...SM, chatGuid: "any;-;+18005550303" }), START_TEXT);
  assert.ok(n >= 2);
});

await okAsync("实测顺序：地址 → 10 秒后空白件吞掉 → 过一阵空白件说去「地址」的有变化", async () => {
  const chat = "any;-;+18005550304";
  const t0 = Date.now();
  const card = (text) => {
    const m = checkIn();
    photon.messages[m.id] = smMsg(text);
    return m;
  };
  await atTime(t0, () => CARD.cardHintFor(card("報平安：示例路1号"), { ...SM, chatGuid: chat }));
  assert.equal(await atTime(t0 + 10_000, () => CARD.cardHintFor(card(), { ...SM, chatGuid: chat })), "");
  const later = await atTime(t0 + 20 * 60_000, () => CARD.cardHintFor(card(), { ...SM, chatGuid: chat }));
  assert.ok(later.includes("去「示例路1号」的「平安确认」有变化"), later);
});

await okAsync("实测顺序：计时 → 超时 → 3 秒后空白件吞掉 → 再来空白件是有变化", async () => {
  const chat = "any;-;+18005550305";
  const t0 = Date.now();
  const card = (text) => {
    const m = checkIn();
    photon.messages[m.id] = smMsg(text);
    return m;
  };
  assert.equal(await atTime(t0, () => CARD.cardHintFor(card("報平安：計時已開始"), { ...SM, chatGuid: chat })), START_TEXT);
  const over = await atTime(t0 + 20 * 60_000, () =>
    CARD.cardHintFor(card("報平安：尚未按預期報平安，已共享位置"), { ...SM, chatGuid: chat })
  );
  assert.match(over, /超时了/);
  assert.equal(await atTime(t0 + 20 * 60_000 + 3000, () => CARD.cardHintFor(card(), { ...SM, chatGuid: chat })), "");
  const after = await atTime(t0 + 40 * 60_000, () => CARD.cardHintFor(card(), { ...SM, chatGuid: chat }));
  assert.match(after, /「平安确认」有变化/);
});

await okAsync("发起时读不到字 → 先当计时发起；下一张到了时补读出目的地", async () => {
  const chat = "any;-;+18005550306";
  const t0 = Date.now();
  const first = checkIn();
  let ready = false;
  Object.defineProperty(photon.messages, first.id, {
    get: () => smMsg(ready ? "報平安：上海市 示例路1号" : undefined),
    configurable: true,
  });
  assert.equal(await atTime(t0, () => CARD.cardHintFor(first, { ...SM, chatGuid: chat })), START_TEXT);
  ready = true;
  const end = checkIn();
  photon.messages[end.id] = smMsg();
  const hint = await atTime(t0 + 20 * 60_000, () => CARD.cardHintFor(end, { ...SM, chatGuid: chat }));
  assert.ok(hint.includes("去「上海市 示例路1号」的「平安确认」有变化"), hint);
});

const PENDING = /暂时无法识别具体位置.*禁止瞎编目的地/;

await okAsync("发起时读不到字 → 先发不带位置的那句，读到目的地再补", async () => {
  CARD._setCheckInLaterMs([5, 5, 5]);
  const first = checkIn();
  let n = 0;
  Object.defineProperty(photon.messages, first.id, {
    get: () => smMsg(++n > 5 ? "報平安：上海市 示例路2号" : undefined),
    configurable: true,
  });
  const later = [];
  const hint = await CARD.cardHintFor(first, { ...SM, chatGuid: "any;-;+18005550307", onLater: (h) => later.push(h) });
  assert.match(hint, PENDING);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(later.length, 1);
  assert.ok(later[0].includes("要去「上海市 示例路2号」"), later[0]);
});

await okAsync("后台读到的是「計時已開始」→ 补一句更正", async () => {
  CARD._setCheckInLaterMs([5, 5]);
  const first = checkIn();
  let n = 0;
  Object.defineProperty(photon.messages, first.id, {
    get: () => smMsg(++n > 3 ? "報平安：計時已開始" : undefined),
    configurable: true,
  });
  const later = [];
  await CARD.cardHintFor(first, { ...SM, chatGuid: "any;-;+18005550308", onLater: (h) => later.push(h) });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(later.length, 1);
  assert.match(later[0], /更正.*计时模式/);
});

await okAsync("一直读不到字 → 只有开头那句，不再补", async () => {
  CARD._setCheckInLaterMs([5, 5]);
  const first = checkIn();
  photon.messages[first.id] = smMsg();
  const later = [];
  assert.match(await CARD.cardHintFor(first, { ...SM, chatGuid: "any;-;+18005550309", onLater: (h) => later.push(h) }), PENDING);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(later, []);
});

section("位置的纯逻辑（friendloc.js）");

const HOME = { latitude: 31.23, longitude: 121.47 };
/** 往北挪 m 米（纬度 1 度 ≈ 111.195 km） */
const north = (p, m) => ({ ...p, latitude: p.latitude + m / 111_195 });

okWith("distanceM：同一点是 0，纬度一度约 111 km", () => {
  assert.equal(FL.distanceM(HOME, HOME), 0);
  const d = FL.distanceM({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
  assert.ok(Math.abs(d - 111_195) < 50, String(d));
  assert.ok(Math.abs(FL.distanceM(HOME, north(HOME, 150)) - 150) < 1);
});

okWith("distanceM：对称、跨日期变更线不绕地球一圈", () => {
  const a = { latitude: 10, longitude: 179.999 };
  const b = { latitude: 10, longitude: -179.999 };
  assert.ok(FL.distanceM(a, b) < 300, String(FL.distanceM(a, b)));
  assert.equal(FL.distanceM(a, HOME), FL.distanceM(HOME, a));
});

okWith("hasFix：0,0 是合法坐标；缺一个、NaN、字符串都不算", () => {
  assert.equal(FL.hasFix({ latitude: 0, longitude: 0 }), true);
  assert.equal(FL.hasFix({ latitude: 1 }), false);
  assert.equal(FL.hasFix({ latitude: NaN, longitude: 1 }), false);
  assert.equal(FL.hasFix({ latitude: "31", longitude: "121" }), false);
  assert.equal(FL.hasFix(null), false);
  assert.equal(FL.hasFix(undefined), false);
});

okWith("hasMoved：没推过 / 上次没坐标 → 算动了；这次没坐标 → 不算", () => {
  assert.equal(FL.hasMoved(undefined, HOME), true);
  assert.equal(FL.hasMoved({ latitude: null }, HOME), true);
  assert.equal(FL.hasMoved(HOME, { latitude: undefined, longitude: undefined }), false);
});

okWith("hasMoved：阈值 100 米（50 不算、150 算、正好 100 算），阈值可调", () => {
  assert.equal(FL.LOCATION_MOVE_M, 100);
  assert.equal(FL.hasMoved(HOME, north(HOME, 50)), false);
  assert.equal(FL.hasMoved(HOME, north(HOME, 150)), true);
  assert.equal(FL.hasMoved(HOME, north(HOME, 100.5)), true);
  assert.equal(FL.hasMoved(HOME, north(HOME, 50), 30), true);
});

okWith("hasMoved：坐标差不多但地址换了 → 算动了；地址一样 → 不算", () => {
  assert.equal(FL.hasMoved({ ...HOME, shortAddress: "某某路" }, { ...north(HOME, 20), shortAddress: "某某机场" }), true);
  assert.equal(FL.hasMoved({ ...HOME, shortAddress: "某某路" }, { ...north(HOME, 20), shortAddress: " 某某路 " }), false);
  // 一边没地址：不据此判断
  assert.equal(FL.hasMoved({ ...HOME, shortAddress: "某某路" }, north(HOME, 20)), false);
});

/*
 * 反向地理编码时有时无：上次只给了 shortAddress，这次只给了 longAddress
 * （或反过来）。拿 short 去比 long 永远不相等，于是人躺着没动也被判成
 * 「动了」，onlyWhenMoved 形同虚设。
 */
okWith("hasMoved：一次只有短地址、一次只有长地址，不能当成换了地方", () => {
  const prev = { ...HOME, shortAddress: "某某路" };
  const next = { ...north(HOME, 10), longAddress: "上海市某某区某某路 1 号" };
  assert.equal(FL.hasMoved(prev, next), false);
  assert.equal(FL.hasMoved(next, prev), false);
  // 两边都有长地址、长地址变了：还是算动了
  assert.equal(
    FL.hasMoved({ ...HOME, longAddress: "A 路 1 号" }, { ...north(HOME, 10), longAddress: "B 机场 T2" }),
    true
  );
});

const NOW = Date.UTC(2026, 8, 29, 8, 0, 0);

okWith("locationHint：没坐标 → 空串", () => {
  assert.equal(FL.locationHint({ shortAddress: "某某路" }, NOW), "");
});

okWith("locationHint：没地址只给坐标（5 位小数），没时间就不说定位时间", () => {
  assert.equal(
    FL.locationHint({ latitude: 31.2304567, longitude: 121.4737 }, NOW),
    "[系统提示:「查找」里{{user}}现在的位置：31.23046, 121.47370]"
  );
});

okWith("locationHint：没地址 + 有精度 → 精度放括号里", () => {
  assert.equal(
    FL.locationHint({ latitude: 31.23, longitude: 121.47, accuracy: 12.4 }, NOW),
    "[系统提示:「查找」里{{user}}现在的位置：31.23000, 121.47000（误差约 12 米）]"
  );
});

okWith("locationHint：有地址（长的优先）+ 精度 + 相对时间（Date）", () => {
  const hint = FL.locationHint(
    {
      latitude: 31.23,
      longitude: 121.47,
      accuracy: 35,
      shortAddress: "某某路",
      longAddress: "上海市某某区某某路 1 号",
      locationTimestamp: new Date(NOW - 3 * 60_000),
    },
    NOW
  );
  assert.equal(
    hint,
    "[系统提示:「查找」里{{user}}现在的位置：上海市某某区某某路 1 号（31.23000, 121.47000，误差约 35 米），3 分钟前定位]"
  );
});

okWith("locationHint：只有短地址也用；精度 0 / 负数不写", () => {
  const hint = FL.locationHint({ latitude: 1, longitude: 2, accuracy: 0, shortAddress: "某某路" }, NOW);
  assert.equal(hint, "[系统提示:「查找」里{{user}}现在的位置：某某路（1.00000, 2.00000）]");
  assert.ok(!FL.locationHint({ latitude: 1, longitude: 2, accuracy: -5 }, NOW).includes("误差"));
});

okWith("locationHint：相对时间 刚刚 / 分钟 / 小时 / 天；未来时间当刚刚；ISO 字符串也认", () => {
  const at = (ms) => FL.locationHint({ ...HOME, locationTimestamp: new Date(NOW - ms) }, NOW);
  assert.match(at(20_000), /，刚刚定位\]$/);
  assert.match(at(59 * 60_000), /，59 分钟前定位\]$/);
  assert.match(at(2 * 3600_000 + 5 * 60_000), /，2 小时前定位\]$/);
  assert.match(at(3 * 86400_000), /，3 天前定位\]$/);
  assert.match(at(-5 * 60_000), /，刚刚定位\]$/);
  assert.match(
    FL.locationHint({ ...HOME, locationTimestamp: new Date(NOW - 10 * 60_000).toISOString() }, NOW),
    /，10 分钟前定位\]$/
  );
  assert.ok(!FL.locationHint({ ...HOME, locationTimestamp: new Date(NaN) }, NOW).includes("定位]"));
});

okWith("locationHint：{{user}} 留字面量，默认 now 是当前时间", () => {
  const hint = FL.locationHint({ ...HOME, locationTimestamp: new Date() });
  assert.ok(hint.includes("{{user}}"));
  assert.match(hint, /刚刚定位/);
});

/* ================= 3. watchFriendLocations ================= */

section("定时问位置（watchFriendLocations）");

function resetPhoton() {
  photon.lines = [{ id: "L1" }];
  photon.listImpl = {};
  photon.result = [];
  photon.createThrows = false;
  photon.created = 0;
  photon.listCalls = 0;
  photon.closed = 0;
  photon.getImpl = {};
  photon.getCalls = [];
}
const warnsOf = (label) => LOGS.filter((e) => e.level === "warn" && e.scope === `位置推送·${label}`);

await okAsync("按间隔调用、每次把结果交出去、每次都关客户端", async () => {
  resetPhoton();
  photon.result = [{ address: "+18005550100", latitude: 1, longitude: 2 }];
  const got = [];
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "间隔",
    intervalMs: 30,
    onLocations: (list) => got.push(list),
  });
  assert.equal(w.intervalMs, 30);
  await waitFor("问满三次", () => got.length >= 3);
  w.stop();
  assert.deepEqual(got[0], photon.result);
  await waitFor("客户端都关了", () => photon.closed === photon.created);
  assert.ok(photon.listCalls >= 3);
});

await okAsync("第一次不会立刻问（间隔大时最多等 20 秒，这里验不是 0 秒就问）", async () => {
  resetPhoton();
  const w = FL.watchFriendLocations({ projectId: "p", projectSecret: "s", label: "首次", intervalMs: 60_000, onLocations: () => {} });
  await sleep(40);
  w.stop();
  assert.equal(photon.created, 0);
});

await okAsync("连着失败只 warn 一次，恢复了记一句 info", async () => {
  resetPhoton();
  let fail = true;
  photon.listImpl.L1 = async () => {
    if (fail) throw new Error("定位服务挂了");
    return [];
  };
  const before = warnsOf("失败").length;
  const got = [];
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "失败",
    intervalMs: 20,
    onLocations: (l) => got.push(l),
  });
  await waitFor("失败三次", () => photon.listCalls >= 3);
  assert.equal(warnsOf("失败").length - before, 1);
  assert.equal(got.length, 0, "失败的那几次不该回调");
  fail = false;
  await waitFor("恢复后回调", () => got.length >= 1);
  w.stop();
  assert.ok(LOGS.some((e) => e.scope === "位置推送·失败" && e.level === "info" && /恢复/.test(e.message)));
  assert.equal(warnsOf("失败").length - before, 1);
  await waitFor("客户端都关了", () => photon.closed === photon.created);
});

await okAsync("铸 token / 开客户端就失败：也只 warn 一次", async () => {
  resetPhoton();
  photon.createThrows = true;
  const before = warnsOf("开不了").length;
  const w = FL.watchFriendLocations({ projectId: "p", projectSecret: "s", label: "开不了", intervalMs: 15, onLocations: () => {} });
  await waitFor("试了三次", () => photon.created >= 3);
  w.stop();
  assert.equal(warnsOf("开不了").length - before, 1);
});

await okAsync("stop 之后不再调用", async () => {
  resetPhoton();
  const w = FL.watchFriendLocations({ projectId: "p", projectSecret: "s", label: "停", intervalMs: 15, onLocations: () => {} });
  await waitFor("至少问一次", () => photon.listCalls >= 1);
  w.stop();
  await sleep(30);
  const n = photon.created;
  await sleep(80);
  assert.equal(photon.created, n);
});

await okAsync("问到一半 stop：结果不再交出去，客户端照关", async () => {
  resetPhoton();
  let release;
  photon.listImpl.L1 = () => new Promise((r) => (release = () => r([{ address: "x" }])));
  const got = [];
  const w = FL.watchFriendLocations({ projectId: "p", projectSecret: "s", label: "半路", intervalMs: 10, onLocations: (l) => got.push(l) });
  await waitFor("问出去了", () => typeof release === "function");
  w.stop();
  release();
  await waitFor("关了", () => photon.closed === 1);
  await sleep(40);
  assert.equal(got.length, 0);
  assert.equal(photon.created, 1);
});

await okAsync("onLocations 抛错不把定时器搞死", async () => {
  resetPhoton();
  let n = 0;
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "回调炸",
    intervalMs: 15,
    onLocations: () => {
      n += 1;
      throw new Error("下游炸了");
    },
  });
  await waitFor("炸了还接着问", () => n >= 3);
  w.stop();
});

await okAsync("多条线路：一条问不到不耽误别的，结果合在一起", async () => {
  resetPhoton();
  photon.lines = [{ id: "L1" }, { id: "L2" }];
  photon.listImpl.L1 = async () => {
    throw new Error("这条问不到");
  };
  photon.listImpl.L2 = async () => [{ address: "b@example.com", latitude: 1, longitude: 1 }];
  const before = warnsOf("多线").length;
  const got = [];
  const w = FL.watchFriendLocations({ projectId: "p", projectSecret: "s", label: "多线", intervalMs: 20, onLocations: (l) => got.push(l) });
  await waitFor("回调一次", () => got.length >= 1);
  w.stop();
  assert.deepEqual(got[0], [{ address: "b@example.com", latitude: 1, longitude: 1 }]);
  assert.equal(warnsOf("多线").length - before, 0);
});

/*
 * 注释写的是「全都问不到才算这次失败」。多条线路全挂的时候，要是照样当成
 * 「问到了、谁都没共享」交出一个空数组，控制台里一句 warn 都没有 —— 用户
 * 只会看到位置推送永远不来。
 */
await okAsync("多条线路全都问不到：算失败（warn、不回调空数组）", async () => {
  resetPhoton();
  photon.lines = [{ id: "L1" }, { id: "L2" }];
  photon.listImpl.L1 = async () => {
    throw new Error("L1 挂了");
  };
  photon.listImpl.L2 = async () => {
    throw new Error("L2 挂了");
  };
  const before = warnsOf("全挂").length;
  const got = [];
  const w = FL.watchFriendLocations({ projectId: "p", projectSecret: "s", label: "全挂", intervalMs: 20, onLocations: (l) => got.push(l) });
  await waitFor("问了两轮", () => photon.created >= 2);
  w.stop();
  assert.equal(got.length, 0);
  assert.equal(warnsOf("全挂").length - before, 1);
});

/*
 * 共享线路上 list() 回「No instance routed」（实测），所以给了号码就只按号码 get。
 */
await okAsync("给了号码：按号码 get、不碰 list；没共享的（NotFoundError）不算失败", async () => {
  resetPhoton();
  photon.listImpl.L1 = async () => {
    throw new Error("No instance routed for this request");
  };
  photon.getImpl["+18005550100"] = async () => ({ address: "+18005550100", latitude: 1, longitude: 2 });
  const before = warnsOf("按号").length;
  const got = [];
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "按号",
    intervalMs: 20,
    addresses: () => ["+18005550100", "+18005550199", "+18005550100"],
    onLocations: (l) => got.push(l),
  });
  await waitFor("回调一次", () => got.length >= 1);
  w.stop();
  assert.deepEqual(got[0], [{ address: "+18005550100", latitude: 1, longitude: 2 }]);
  assert.equal(photon.listCalls, 0);
  assert.deepEqual(photon.getCalls.slice(0, 2), ["+18005550100", "+18005550199"], "重复的号码只问一次");
  assert.equal(warnsOf("按号").length - before, 0);
});

await okAsync("给了号码但都没共享：交空数组、不 warn", async () => {
  resetPhoton();
  const before = warnsOf("没共享").length;
  const got = [];
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "没共享",
    intervalMs: 20,
    addresses: () => ["+18005550199"],
    onLocations: (l) => got.push(l),
  });
  await waitFor("回调一次", () => got.length >= 1);
  w.stop();
  assert.deepEqual(got[0], []);
  assert.equal(warnsOf("没共享").length - before, 0);
});

await okAsync("号码列表是空的：不连 Photon、照样到点再看", async () => {
  resetPhoton();
  let peers = [];
  const got = [];
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "没人",
    intervalMs: 15,
    addresses: () => peers,
    onLocations: (l) => got.push(l),
  });
  await waitFor("空跑两次", () => got.length >= 2);
  assert.equal(photon.created, 0);
  // 后来有人说话了，下一轮就该去问
  photon.getImpl["+18005550100"] = async () => ({ address: "+18005550100", latitude: 3, longitude: 4 });
  peers = ["+18005550100"];
  await waitFor("问到了", () => got.some((l) => l.length === 1));
  w.stop();
  assert.ok(photon.created >= 1);
});

await okAsync("get 抛的不是 NotFoundError：算这次失败，warn 一次", async () => {
  resetPhoton();
  photon.getImpl["+18005550100"] = async () => {
    throw new Error("Unknown server error");
  };
  const before = warnsOf("get炸").length;
  const got = [];
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "get炸",
    intervalMs: 15,
    addresses: () => ["+18005550100"],
    onLocations: (l) => got.push(l),
  });
  await waitFor("问了三轮", () => photon.created >= 3);
  w.stop();
  assert.equal(got.length, 0);
  assert.equal(warnsOf("get炸").length - before, 1);
});

await okAsync("两条线路都问到同一个人：只留一份", async () => {
  resetPhoton();
  photon.lines = [{ id: "L1" }, { id: "L2" }];
  photon.getImpl["+18005550100"] = async (line) => ({ address: "+18005550100", latitude: 1, longitude: 1, line });
  const got = [];
  const w = FL.watchFriendLocations({
    projectId: "p",
    projectSecret: "s",
    label: "去重",
    intervalMs: 20,
    addresses: () => ["+18005550100"],
    onLocations: (l) => got.push(l),
  });
  await waitFor("回调一次", () => got.length >= 1);
  w.stop();
  assert.equal(got[0].length, 1);
  assert.equal(got[0][0].line, "L1");
});

/* ================= 4. 配置规整 ================= */

section("配置：locationPush（config.js）");

const lpOf = (locationPush) =>
  C.normalizeConfig({ roles: [{ id: "r-loc", name: "L", ...(locationPush === undefined ? {} : { locationPush }) }] }).roles[0]
    .locationPush;

okWith("默认：关、600 秒、动了才推", () => {
  assert.deepEqual(lpOf(undefined), { enabled: false, intervalSec: 600, onlyWhenMoved: true });
  assert.deepEqual(lpOf({}), { enabled: false, intervalSec: 600, onlyWhenMoved: true });
  assert.deepEqual(lpOf("乱填"), { enabled: false, intervalSec: 600, onlyWhenMoved: true });
});

okWith("间隔夹在 60–86400 秒、取整、字符串数字也认、乱填回默认", () => {
  assert.equal(lpOf({ intervalSec: 10 }).intervalSec, 60);
  assert.equal(lpOf({ intervalSec: 999_999 }).intervalSec, 86400);
  assert.equal(lpOf({ intervalSec: "120" }).intervalSec, 120);
  assert.equal(lpOf({ intervalSec: 90.6 }).intervalSec, 91);
  assert.equal(lpOf({ intervalSec: "abc" }).intervalSec, 600);
  assert.equal(lpOf({ intervalSec: -5 }).intervalSec, 60);
});

okWith("enabled / onlyWhenMoved 照填的来", () => {
  assert.deepEqual(lpOf({ enabled: true, onlyWhenMoved: false, intervalSec: 300 }), {
    enabled: true,
    intervalSec: 300,
    onlyWhenMoved: false,
  });
  assert.equal(lpOf({ onlyWhenMoved: 0 }).onlyWhenMoved, false);
});

okWith("规整两遍结果不变", () => {
  const once = C.normalizeConfig({ roles: [{ id: "r-loc", name: "L", locationPush: { enabled: true, intervalSec: 45 } }] });
  const twice = C.normalizeConfig(once);
  assert.deepEqual(twice.roles[0].locationPush, once.roles[0].locationPush);
  assert.deepEqual(once.roles[0].locationPush, { enabled: true, intervalSec: 60, onlyWhenMoved: true });
});

/* ================= 5. imessage.js：handleFriendLocations ================= */

section("把位置送进会话（imessage.js:handleFriendLocations）");

const IM_SRC = fs.readFileSync(path.join(ROOT, "server/src/imessage.js"), "utf-8");

/** 从 imessage.js 里抠出一个函数的源码（同 test-queue.mjs）。 */
function extractFn(name, kind = "function") {
  const head = `${kind} ${name}(`;
  const at = IM_SRC.indexOf(head);
  assert.ok(at >= 0, `在 imessage.js 里找不到 ${name}`);
  let depth = 0;
  let i = IM_SRC.indexOf("{", at);
  for (; i < IM_SRC.length; i += 1) {
    if (IM_SRC[i] === "{") depth += 1;
    else if (IM_SRC[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return IM_SRC.slice(at, i + 1);
}

const ME = "+18005550100";
const OTHER = "+18005550199";
const DM = `any;-;${ME}`;
const GROUP = "any;+;chat000000000000";

/** 每次测都要一副干净的：假 runner + 记下来的推送。 */
function harness({ role, stored = "", assist = new Set(), offline = false, spaceOk = true } = {}) {
  const logs = [];
  const pushed = [];
  const asked = [];
  const deps = {
    logDebug: (scope, msg) => logs.push({ level: "debug", scope, msg }),
    logInfo: (scope, msg) => logs.push({ level: "info", scope, msg }),
    logWarn: (scope, msg) => logs.push({ level: "warn", scope, msg }),
    logError: (scope, msg, err) => logs.push({ level: "error", scope, msg, err }),
    scopeOf: (_r, what) => what,
    currentRole: () => role,
    readSession: () => ({ peer: stored }),
    sessionIdOf: () => "sess",
    isAssistOn: (_p, spaceId) => assist.has(spaceId),
    isOfflineOn: () => offline,
    memoryKeyFor: () => "mk",
    hasFix: FL.hasFix,
    hasMoved: FL.hasMoved,
    locationHint: FL.locationHint,
    spaceForChat: async (_runner, id) => {
      asked.push(id);
      return spaceOk ? { id } : null;
    },
    enqueue: (_g, _r, space, spaceId, item, peer) => pushed.push({ space, spaceId, text: item.text, peer }),
  };
  const names = Object.keys(deps);
  // 抠出来的几个函数互相按名字调用，所以放进同一个作用域；假依赖当参数传进去
  const wrap = new Function(
    ...names,
    `
    ${extractFn("peerKeyOf")}
    ${extractFn("locPeersOf")}
    ${extractFn("stopLocWatcher")}
    ${extractFn("chain")}
    ${extractFn("handleFriendLocations", "async function")}
    return { peerKeyOf, locPeersOf, stopLocWatcher, chain, handleFriendLocations };
  `
  );
  const fns = wrap(...names.map((n) => deps[n]));
  const runner = {
    projectRefId: "proj",
    label: "测",
    stopped: false,
    chains: new Map(),
    locLast: new Map(),
    locWatcher: null,
    lastSpace: null,
  };
  const getConfig = () => ({});
  const run = (list) => fns.handleFriendLocations(getConfig, runner, list);
  return { ...fns, runner, logs, pushed, asked, run, deps };
}

const roleOn = (extra = {}) => ({ id: "r1", name: "测", locationPush: { enabled: true, intervalSec: 600, onlyWhenMoved: true, ...extra } });
const at = (address, p = HOME, extra = {}) => ({ address, ...p, isLocatingInProgress: false, ...extra });

await okAsync("只推给这个角色的聊天对象：别人的位置一个字都不送", async () => {
  const H = harness({ role: roleOn() });
  H.runner.lastSpace = { space: { id: DM }, spaceId: DM, peer: ME };
  await H.run([at(OTHER, north(HOME, 5000)), at(ME)]);
  assert.equal(H.pushed.length, 1);
  assert.equal(H.pushed[0].spaceId, DM);
  assert.equal(H.pushed[0].peer, ME);
  assert.ok(!H.pushed.some((p) => p.text.includes("31.27")), "别人的坐标漏进去了");
});

await okAsync("谁都不是聊天对象：不推，也不去要会话", async () => {
  const H = harness({ role: roleOn() });
  await H.run([at(OTHER)]);
  assert.equal(H.pushed.length, 0);
  assert.equal(H.asked.length, 0);
});

await okAsync("号码格式不同也对得上（peerKey 归一）", async () => {
  const H = harness({ role: roleOn() });
  H.runner.lastSpace = { space: { id: DM }, spaceId: DM, peer: "+1 (800) 555-0100" };
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 1);
  assert.equal(H.pushed[0].spaceId, DM, "最近那条会话对得上就用它");
});

await okAsync("邮箱大小写不同也对得上", async () => {
  const H = harness({ role: roleOn(), stored: "Alex@Example.com" });
  await H.run([at("alex@example.com")]);
  assert.equal(H.pushed.length, 1);
  assert.equal(H.pushed[0].spaceId, "any;-;alex@example.com");
});

await okAsync("重启后没人说过话：靠存档里的对方地址认人，现拼单聊 GUID 要会话", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  await H.run([at(ME)]);
  assert.deepEqual(H.asked, [DM]);
  assert.equal(H.pushed.length, 1);
  assert.equal(H.pushed[0].spaceId, DM);
  assert.equal(H.pushed[0].peer, ME);
});

/*
 * 最近一条消息是这个人在**群里**说的：位置绝不能送进群聊 —— 模型会在群里
 * 回一句「你到某某路了啊」，等于把对方的位置念给全群听。
 */
await okAsync("最近那条是群聊：不往群里推位置", async () => {
  const H = harness({ role: roleOn() });
  H.runner.lastSpace = { space: { id: GROUP }, spaceId: GROUP, peer: ME };
  await H.run([at(ME)]);
  assert.ok(!H.pushed.some((p) => p.spaceId === GROUP), "位置被推进群聊了");
  assert.ok(!H.asked.includes(GROUP));
});

await okAsync("最近那条是群聊、但存档里记着单聊对象：推到单聊", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  H.runner.lastSpace = { space: { id: GROUP }, spaceId: GROUP, peer: ME };
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 1);
  assert.equal(H.pushed[0].spaceId, DM);
});

await okAsync("onlyWhenMoved：没动不推，动了再推；locLast 记的是推出去的那份", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  await H.run([at(ME)]);
  await H.run([at(ME, north(HOME, 60))]);
  assert.equal(H.pushed.length, 1, "挪了 60 米不该推");
  // 慢慢挪：每次 60 米，跟**上次推出去**的比，第二次累计 120 米就该推
  await H.run([at(ME, north(HOME, 120))]);
  assert.equal(H.pushed.length, 2);
  assert.equal(H.runner.locLast.get(ME).latitude, north(HOME, 120).latitude);
});

await okAsync("onlyWhenMoved 关掉：没动也按时推", async () => {
  const H = harness({ role: roleOn({ onlyWhenMoved: false }), stored: ME });
  await H.run([at(ME)]);
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 2);
});

await okAsync("共享过期（expiresAt 是 Date）→ 跳过；没过期照推", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  await H.run([at(ME, HOME, { expiresAt: new Date(Date.now() - 1000) })]);
  assert.equal(H.pushed.length, 0);
  await H.run([at(ME, HOME, { expiresAt: new Date(Date.now() + 3600_000) })]);
  assert.equal(H.pushed.length, 1);
});

await okAsync("还在定位 / 没坐标 → 跳过，不记 locLast", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  await H.run([{ address: ME, isLocatingInProgress: true }]);
  assert.equal(H.pushed.length, 0);
  assert.equal(H.runner.locLast.size, 0);
});

await okAsync("协助模式开着 → 不推、不记 locLast；关了下次照推", async () => {
  const assist = new Set([DM]);
  const H = harness({ role: roleOn(), stored: ME, assist });
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 0);
  assert.equal(H.runner.locLast.size, 0);
  assist.clear();
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 1);
});

await okAsync("线下模式开着 → 不推", async () => {
  const H = harness({ role: roleOn(), stored: ME, offline: true });
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 0);
});

await okAsync("要不到会话 → warn、不记 locLast（下次还会再试）", async () => {
  const H = harness({ role: roleOn(), stored: ME, spaceOk: false });
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 0);
  assert.equal(H.runner.locLast.size, 0);
  assert.ok(H.logs.some((l) => l.level === "warn" && /拿不到会话/.test(l.msg)));
});

await okAsync("角色把开关关了 / runner 停了 → 什么都不做", async () => {
  const off = harness({ role: { id: "r", name: "x", locationPush: { enabled: false } }, stored: ME });
  await off.run([at(ME)]);
  assert.equal(off.pushed.length, 0);
  const stopped = harness({ role: roleOn(), stored: ME });
  stopped.runner.stopped = true;
  await stopped.run([at(ME)]);
  assert.equal(stopped.pushed.length, 0);
});

await okAsync("排在会话链上：等前一轮跑完再推，不死锁", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  let release;
  const order = [];
  H.chain(H.runner, DM, () => new Promise((r) => (release = () => (order.push("前一轮"), r()))), "x");
  const p = H.run([at(ME)]).then(() => order.push("位置"));
  await sleep(20);
  assert.equal(H.pushed.length, 0, "前一轮还没完就插队了");
  release();
  await p;
  assert.deepEqual(order, ["前一轮", "位置"]);
  assert.equal(H.pushed.length, 1);
});

await okAsync("推出去的文案就是 locationHint 那句", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  const loc = at(ME, HOME, { shortAddress: "某某路", locationTimestamp: new Date() });
  await H.run([loc]);
  assert.equal(H.pushed[0].text, FL.locationHint(loc));
});

/*
 * 用户关掉开关再打开，是想「马上看到效果」（friendloc.js 的 FIRST_DELAY_MS 也是
 * 为这个）。locLast 要是跨过这次关开关还留着，人没动的话重新打开之后永远等不来
 * 第一条。
 */
await okAsync("停掉定时器时清掉 locLast（重新打开开关会先报一次）", async () => {
  const H = harness({ role: roleOn(), stored: ME });
  await H.run([at(ME)]);
  assert.equal(H.runner.locLast.size, 1);
  let stoppedCalls = 0;
  H.runner.locWatcher = { stop: () => (stoppedCalls += 1), intervalMs: 1 };
  H.stopLocWatcher(H.runner);
  assert.equal(stoppedCalls, 1);
  assert.equal(H.runner.locWatcher, null);
  assert.equal(H.runner.locLast.size, 0);
  await H.run([at(ME)]);
  assert.equal(H.pushed.length, 2);
});

/* ================= 收尾 ================= */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${process.exitCode ? "有失败" : "全部通过"}：${passed} 条通过`);
