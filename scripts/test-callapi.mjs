/**
 * 通话节点那几个口子的门禁（callapi.js:checkSecret）+ 通话记录（calllog.js）。
 *
 * 跑法：`node scripts/test-callapi.mjs`（或者 `npm test` 一起跑）
 *
 * ── 为什么门禁非测不可 ──
 *
 * 「本机的节点不用配对码」是一个**放行**规则：从回环地址来的节点不校验密钥。放行规则
 * 写错的代价不对称 —— 拒多了用户会来报「连不上」，放多了谁都能往通话里
 * 塞话，而且不会有任何人来报。
 *
 * 最要命的一种是**反代**：VPS 上常见 nginx 在前、Uranus 在 127.0.0.1 后面，
 * 这时外网来的每个请求在 Uranus 眼里都是 127.0.0.1。只看 socket 地址的话，
 * 本机免密等于对整个公网敞开。下面专门有一组钉这个，另一组钉本机浏览器里的网页。
 *
 * 不起真的 HTTP 服务：拿一个假 app 把路由登记下来，直接调处理函数。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 通话记录要写盘 —— 指到一个临时目录，别碰真的 data/
const TMP = mkdtempSync(join(tmpdir(), "uranus-callapi-"));
process.env.URANUS_DATA_DIR = TMP;

const { mountCall, NODE_PATHS, resetNodeForTest } = await import("../server/src/callapi.js");
const { clearCallLog, noteCall, readCallLog } = await import("../server/src/calllog.js");

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

/* ───────────────────────── 假 app / req / res ───────────────────────── */

/** 把 mountCall 登记的路由收下来，按「方法 路径」查。 */
function mount(callNode) {
  const routes = new Map();
  const reg = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers);
  const app = { get: reg("GET"), post: reg("POST") };
  const events = [];
  mountCall(app, () => ({ callNode, roles: [] }), {
    onEvent: async (type) => events.push(type),
  });
  return { routes, events };
}

function fakeReq({ ip = "127.0.0.1", headers = {}, secret } = {}) {
  // 真实请求都带 Host（节点连的是 127.0.0.1:8787），测 Host 的那几条自己覆盖
  const lower = Object.fromEntries(
    Object.entries({ Host: "127.0.0.1:8787", ...headers }).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    socket: { remoteAddress: ip },
    headers: lower,
    query: secret === undefined ? {} : { secret },
    body: { type: "ping" },
    get: (h) => lower[String(h).toLowerCase()],
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined, ended: false };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    res.ended = true;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

/**
 * 打一下 /facetime/event —— 这个口子处理完就返回，最好拿来测门禁
 * （stream 那个会挂着不放，utterance 那个要先有一通电话）。
 *
 * @returns {Promise<number>} 状态码；放行了且处理成功是 200
 */
async function hit(callNode, reqOpts) {
  resetNodeForTest();
  const { routes } = mount(callNode);
  const handlers = routes.get(`POST ${NODE_PATHS.event}`);
  if (!handlers) throw new Error("event 路由没登记上");
  const req = fakeReq(reqOpts);
  const res = fakeRes();
  // 可能挂着 body 解析之类的中间件：一个个过，最后那个才是业务处理
  for (const h of handlers) {
    let nexted = false;
    await h(req, res, () => {
      nexted = true;
    });
    if (res.ended && !nexted) break;
  }
  return res.statusCode;
}

/* ───────────────────────── 门禁 ───────────────────────── */

group("功能没开：一律 404（别告诉扫端口的人这儿有东西）");
{
  check("本机来的也 404", await hit({ enabled: false, trustLocal: true }, {}), 404);
  check("带对了密钥也 404", await hit({ enabled: false, secret: "abc" }, { secret: "abc" }), 404);
}

group("本机的节点（默认）：不要密钥");
{
  const cfg = { enabled: true, trustLocal: true, secret: "" };
  check("127.0.0.1 放行", await hit(cfg, { ip: "127.0.0.1" }), 200);
  check("127.x 整段都算回环", await hit(cfg, { ip: "127.0.0.2" }), 200);
  check("::1 放行", await hit(cfg, { ip: "::1", headers: { Host: "[::1]:8787" } }), 200);
  /*
   * Node 双栈监听时 IPv4 回环是这个写法，而且**最常见的就是它** ——
   * 用户的日志里那些「::ffff:…」就是它。漏认这一种，本机免密在大多数
   * 机器上等于没开。
   */
  check("::ffff:127.0.0.1（IPv4 映射）放行", await hit(cfg, { ip: "::ffff:127.0.0.1" }), 200);
  check("Host 写 localhost 也算", await hit(cfg, { headers: { Host: "localhost:8787" } }), 200);
  // 缺字段（老配置）也按开着算
  check("trustLocal 缺字段算开着", await hit({ enabled: true }, { ip: "127.0.0.1" }), 200);
}

group("别的机器上的节点：照旧要密钥（这是多一条路，不是换一条路）");
{
  /*
   * 第一版写成了「开着就只收本机、外面来的密钥对了也拒」—— 那会把已经用
   * 配对码连着的节点一更新就踢掉。这一组钉住「开着本机免密，远程照旧能用」。
   */
  const cfg = { enabled: true, trustLocal: true, secret: "abc" };
  check("外部 + 密钥正确放行", await hit(cfg, { ip: "203.0.113.9", secret: "abc" }), 200);
  check("局域网 + 密钥正确放行", await hit(cfg, { ip: "192.168.1.5", secret: "abc" }), 200);
  check("外部不带密钥拒", await hit(cfg, { ip: "203.0.113.9" }), 403);
  check("外部密钥错拒", await hit(cfg, { ip: "203.0.113.9", secret: "xyz" }), 403);
  check("::ffff: 映射的外部地址不算本机", await hit(cfg, { ip: "::ffff:203.0.113.9" }), 403);
  check("没有来源地址的当外部", await hit(cfg, { ip: "" }), 403);
  check("长得像 127 的不算", await hit(cfg, { ip: "1270.0.0.1" }), 403);
  // 没设密钥时外面来的一律进不来
  check(
    "没设密钥时外部 404",
    await hit({ enabled: true, trustLocal: true, secret: "" }, { ip: "203.0.113.9" }),
    404
  );
}

/** 放没放进来。下面两组只关心「进没进得来」，不关心是 403 还是 404。 */
const letIn = async (cfg, req) => (await hit(cfg, req)) === 200;

group("经过反代的不算本机（最要命的那种）");
{
  /*
   * nginx 在前、Uranus 在 127.0.0.1 后面：外网每个请求到 Uranus 这儿，
   * socket 地址都是 127.0.0.1。只看地址就等于对公网敞开。
   * 反代一定带转发头，本机节点直连一个都不带 —— 拿它当信号。
   */
  const cfg = { enabled: true, trustLocal: true, secret: "" };
  const loop = "127.0.0.1";
  check("带 X-Forwarded-For 进不来", await letIn(cfg, { ip: loop, headers: { "X-Forwarded-For": "203.0.113.9" } }), false);
  check("带 X-Real-IP 进不来", await letIn(cfg, { ip: loop, headers: { "X-Real-IP": "203.0.113.9" } }), false);
  check("带 Forwarded 进不来", await letIn(cfg, { ip: loop, headers: { Forwarded: "for=203.0.113.9" } }), false);
  check("带 X-Forwarded-Host 进不来", await letIn(cfg, { ip: loop, headers: { "X-Forwarded-Host": "chat.example.com" } }), false);
  // 转发头里**自称**本机也没用 —— 只拿它当「经过了反代」的信号，不信内容
  check("转发头里自称 127.0.0.1 也进不来", await letIn(cfg, { ip: loop, headers: { "X-Forwarded-For": "127.0.0.1" } }), false);
  // 经过反代、但带着正确密钥的：照常放行（远程节点走反代是正常用法）
  check(
    "反代 + 密钥正确放行",
    await hit({ enabled: true, trustLocal: true, secret: "abc" }, { ip: loop, secret: "abc", headers: { "X-Forwarded-For": "203.0.113.9" } }),
    200
  );
}

group("本机浏览器里网页发的不算本机（CSRF / DNS 重绑定）");
{
  /*
   * 这台机器上开着的任何网页都能往 127.0.0.1:8787 发请求，来源地址照样是
   * 回环。节点用的 Node fetch 实测不带 Origin、也不带 Sec-Fetch-Site
   * （只带 sec-fetch-mode），浏览器一定带 —— 拿它们区分。
   */
  const cfg = { enabled: true, trustLocal: true, secret: "" };
  check("带 Origin 进不来", await letIn(cfg, { headers: { Origin: "https://evil.example" } }), false);
  check("带 Sec-Fetch-Site 进不来", await letIn(cfg, { headers: { "Sec-Fetch-Site": "cross-site" } }), false);
  // DNS 重绑定：浏览器当它同源（可能不带 Origin），但 Host 是攻击者的域名
  check("Host 不是本机进不来", await letIn(cfg, { headers: { Host: "rebind.evil.example:8787" } }), false);
  /*
   * 最阴的一种：域名本身以 127.0.0.1 开头。只看「127.」前缀的判断会放它进来
   * —— 节点那边的 isLocalUranus 测试先抓到了同一个写法，这里补上。
   */
  check(
    "Host 是 127.0.0.1.evil.example 进不来",
    await letIn(cfg, { headers: { Host: "127.0.0.1.evil.example:8787" } }),
    false
  );
  // Node fetch 会带 sec-fetch-mode —— 这个不能误伤，不然本机节点自己都进不来
  check("只带 sec-fetch-mode 的照样放行（Node fetch 就这样）", await letIn(cfg, { headers: { "sec-fetch-mode": "cors" } }), true);
}

group("「本机的节点不用配对码」关掉：本机也要密钥");
{
  const cfg = { enabled: true, trustLocal: false, secret: "abc" };
  check("密钥对，外部放行", await hit(cfg, { ip: "203.0.113.9", secret: "abc" }), 200);
  check("密钥对，本机放行", await hit(cfg, { ip: "127.0.0.1", secret: "abc" }), 200);
  check("密钥错拒", await hit(cfg, { ip: "203.0.113.9", secret: "xyz" }), 403);
  // 关掉它就是要本机也走密钥 —— 不然这个开关没意义
  check("本机不带密钥拒", await hit(cfg, { ip: "127.0.0.1" }), 403);
  check(
    "关着又没设密钥：404",
    await hit({ enabled: true, trustLocal: false, secret: "" }, { ip: "127.0.0.1" }),
    404
  );
}

/* ───────────────────────── 通话记录 ───────────────────────── */

/** endCall 交出来的那个形状。 */
function endedCall(over = {}) {
  const startedAt = Date.parse("2026-10-13T01:00:00Z");
  return {
    id: `call-${Math.random().toString(36).slice(2, 8)}`,
    roleId: "r1",
    roleName: "Ken",
    peer: "+10000000000",
    sessionId: "s1",
    startedAt,
    endedAt: startedAt + 226_000,
    durationMs: 226_000,
    turns: 8,
    reason: "对方挂断",
    ...over,
  };
}

group("通话记录：只记接通了的");
{
  clearCallLog();
  const e = noteCall(endedCall());
  check("记下来了", readCallLog().length, 1);
  check("时长", e.durationMs, 226_000);
  check("轮数", e.turns, 8);
  check("怎么结束的", e.reason, "对方挂断");
  check("时间存成 ISO", e.startedAt, "2026-10-13T01:00:00.000Z");
  /*
   * 只存元信息、不存说了什么 —— 说的话在会话存档里，再存一份就会各自漂移。
   * 这条钉住「别有人顺手把 call.log 塞进来」。
   */
  check("不存对话内容", "log" in e || "messages" in e || "text" in e, false);
}
{
  /*
   * 没接通的（state 从来没到过 live，startedAt 是 0）不算一次通话 ——
   * 手机上也不会把拨号失败记成「最近通话」里的一条。
   */
  clearCallLog();
  check("没接通的不记", noteCall(endedCall({ startedAt: 0, durationMs: 0 })), null);
  check("列表还是空的", readCallLog().length, 0);
  check("null 也不炸", noteCall(null), null);
}

group("通话记录：最新的在前，最多留 100 条");
{
  clearCallLog();
  noteCall(endedCall({ id: "old" }));
  noteCall(endedCall({ id: "new" }));
  check("最新的在前", readCallLog().map((c) => c.id), ["new", "old"]);

  clearCallLog();
  for (let i = 0; i < 105; i += 1) noteCall(endedCall({ id: `c${i}` }));
  const list = readCallLog();
  check("截到 100 条", list.length, 100);
  check("丢的是最老的", list.at(-1).id, "c5");
  check("留着最新的", list[0].id, "c104");
}

group("通话记录：清空");
{
  noteCall(endedCall());
  check("清空成功", clearCallLog(), true);
  check("清完是空的", readCallLog(), []);
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
