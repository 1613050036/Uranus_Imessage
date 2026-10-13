/**
 * 「Uranus 去连节点」那条隧道，两头一起测（不起浏览器、不打真的 Uranus）。
 *
 * 跑法：node scripts/test-calltunnel.mjs（或者 npm test 一起跑）
 *
 * 节点那头是真的 TunnelServer（facetime-node/src/tunnel.mjs，真的开端口、
 * 真的 WebSocket 握手），Uranus 那头是真的 calltunnel.js，中间只把「交给
 * 自己的路由」那一步换成一个假的 dispatch —— 于是测到的就是线上的那套协议：
 * 握手、密钥、请求原样转过去、流式响应一块块送回来、断线重连、路径白名单。
 */

const { TunnelServer, parseFrame } = await import("../facetime-node/src/tunnel.mjs");
const { syncCallTunnel, stopCallTunnel, callTunnelStatus, tunnelUrl, resetCallTunnelForTest } =
  await import("../server/src/calltunnel.js");

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
const group = (n) => console.log(`\n${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到条件成立，最多 ms 毫秒。 */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}

/** Uranus 那头「自己的路由」：记下收到的请求，按路径回不同的东西。 */
const seen = [];
async function fakeDispatch(req) {
  const url = new URL(req.url);
  const body = req.method === "GET" ? "" : Buffer.from(await req.arrayBuffer()).toString("utf8");
  seen.push({ method: req.method, path: url.pathname + url.search, body, type: req.headers.get("content-type"), fwd: req.headers.get("x-forwarded-for") });

  if (url.pathname === "/facetime/event") {
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/facetime/utterance") {
    // 流式：分三块回，中间隔一下，模拟一句一句合成
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode('data: {"type":"say","text":"喂"}\n\n'));
        await sleep(30);
        c.enqueue(enc.encode('data: {"type":"say","text":"怎么了"}\n\n'));
        await sleep(30);
        c.enqueue(enc.encode('data: {"type":"done"}\n\n'));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }
  return new Response("not found", { status: 404 });
}

const SECRET = "0123456789abcdef01234567";

group("地址换算");
{
  check("http → ws", tunnelUrl("http://node.example.com:8788", "k"), "ws://node.example.com:8788/tunnel?secret=k");
  check("https → wss，末尾斜杠吃掉", tunnelUrl("https://node.example.com/", "k"), "wss://node.example.com/tunnel?secret=k");
}

const node = new TunnelServer({ port: 0, secret: SECRET, host: "127.0.0.1" });
const port = await node.start();
const base = `http://127.0.0.1:${port}`;
const config = { callNode: { enabled: true, direction: "uranus", url: base, secret: SECRET } };

group("连上");
{
  syncCallTunnel({ loadConfig: () => config, dispatch: fakeDispatch });
  check("Uranus 连上节点了", await until(() => node.connected), true);
  check("Uranus 那头报告已连上", await until(() => callTunnelStatus().connected), true);
}

group("普通请求原样转过去");
{
  const res = await node.fetch("http://uranus.tunnel/facetime/event?secret=" + SECRET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "connected" }),
  });
  check("状态码", res.status, 200);
  check("响应体", await res.json(), { ok: true });
  const r = seen.at(-1);
  check("路径和查询串原样", r.path, "/facetime/event?secret=" + SECRET);
  check("方法", r.method, "POST");
  check("请求体原样", r.body, '{"type":"connected"}');
  check("Content-Type 带过去了", r.type, "application/json");
  // 不打这个记号的话，本机免密那条会让隧道里的请求不看密钥就进去
  check("打上了转发记号（不会被当成本机）", r.fwd, "call-tunnel");
}

group("流式响应一块一块送回来");
{
  const res = await node.fetch("http://uranus.tunnel/facetime/utterance?kind=said", {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: Buffer.from("RIFF-fake-wav"),
  });
  check("是 SSE", res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = res.body.getReader();
  const got = [];
  let first = null;
  const t0 = Date.now();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (first === null) first = Date.now() - t0;
    got.push(Buffer.from(value).toString("utf8"));
  }
  const text = got.join("");
  check("三条都到了", (text.match(/data:/g) || []).length, 3);
  check("顺序对", text.indexOf("喂") < text.indexOf("怎么了"), true);
  // 第一块要在整段完成之前就到 —— 这是「说一句播一句」的前提
  check("第一块先到（不是攒完才发）", first !== null && first < 50, true);
  check("音频字节原样到了 Uranus", seen.at(-1).body, "RIFF-fake-wav");
}

group("只通节点那几个口子");
{
  const res = await node.fetch("http://uranus.tunnel/api/config", { method: "GET" });
  check("/api/ 下面的进不去", res.status, 403);
  const before = seen.length;
  await node.fetch("http://uranus.tunnel/../api/config", { method: "GET" }).catch(() => null);
  check("拦下的请求根本没进 Uranus 的路由", seen.length, before);
}

group("密钥不对连不上");
{
  const bad = new TunnelServer({ port: 0, secret: "another-secret-xxxxxxxxx", host: "127.0.0.1" });
  const p2 = await bad.start();
  const ws = new WebSocket(`ws://127.0.0.1:${p2}/tunnel?secret=wrong`);
  const outcome = await new Promise((r) => {
    ws.addEventListener("open", () => r("open"));
    ws.addEventListener("error", () => r("error"));
    ws.addEventListener("close", () => r("close"));
  });
  check("被拒掉", outcome === "open", false);
  check("节点那头没把它当成 Uranus", bad.connected, false);
  await bad.stop();
}

group("断了会自己重连");
{
  // 节点那头把连接踢掉（模拟 VPS 网络抖了一下）
  node.ws.close();
  check("先断了", await until(() => !callTunnelStatus().connected, 2000), true);
  check("几秒内自己连回来", await until(() => node.connected && callTunnelStatus().connected, 6000), true);
  const res = await node.fetch("http://uranus.tunnel/facetime/event", { method: "POST", body: "{}" });
  check("连回来之后照常能用", res.status, 200);
}

group("Uranus 不在时，节点的请求先等它");
{
  stopCallTunnel();
  check("断开了", await until(() => !node.connected, 2000), true);
  // 断着的时候发一个请求，然后再把隧道打开 —— 请求应该接着走，而不是立刻失败
  const pending = node.fetch("http://uranus.tunnel/facetime/event", { method: "POST", body: "{}" });
  await sleep(150);
  syncCallTunnel({ loadConfig: () => config, dispatch: fakeDispatch });
  const res = await pending;
  check("Uranus 连上来之后那个请求照常完成", res.status, 200);
}

group("配置关掉就断开，不再重连");
{
  syncCallTunnel({ loadConfig: () => ({ callNode: { ...config.callNode, direction: "node" } }) });
  check("断开了", await until(() => !node.connected, 2000), true);
  await sleep(2500);
  check("过一会儿也没连回来", node.connected, false);
  check("状态里不再算在用", callTunnelStatus().active, false);
}

group("帧解析：不够一帧就等");
{
  check("只有一个字节", parseFrame(Buffer.from([0x81])), null);
  // 带掩码的短文本帧「hi」
  const mask = [1, 2, 3, 4];
  const payload = Buffer.from("hi").map((b, i) => b ^ mask[i & 3]);
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | 2, ...mask]), payload]);
  const f = parseFrame(frame);
  check("解掩码", f.payload.toString(), "hi");
  check("长度对", f.size, frame.length);
  check("半帧不解", parseFrame(frame.subarray(0, frame.length - 1)), null);
}

resetCallTunnelForTest();
await node.stop();

/* ───────────── 接真的路由：隧道 → express → callapi.js ───────────── */

group("接真的 callapi 路由（线上就是这条路）");
{
  const express = (await import("express")).default;
  const { mountCall, nodeOnline, sendToNode, resetNodeForTest } = await import("../server/src/callapi.js");
  resetNodeForTest();

  const realNode = new TunnelServer({ port: 0, secret: SECRET, host: "127.0.0.1" });
  const nodePort = await realNode.start();
  const cfg = {
    callNode: {
      enabled: true,
      direction: "uranus",
      url: `http://127.0.0.1:${nodePort}`,
      secret: SECRET,
      // 本机免密开着 —— 正好验证隧道里的请求**不会**借它绕过密钥
      trustLocal: true,
    },
    roles: [],
  };

  const app = express();
  mountCall(app, () => cfg, {});
  const srv = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const uranusPort = srv.address().port;

  // 不传 dispatch：走默认那条（fetch 本机端口），和线上一样
  syncCallTunnel({ loadConfig: () => cfg, port: uranusPort });
  check("Uranus 连上了节点", await until(() => realNode.connected), true);

  // 节点挂控制通道（brain.listen 做的就是这个），不带密钥
  const noKey = await realNode.fetch("http://uranus.tunnel/facetime/stream");
  check("不带密钥进不去（本机免密没被借用）", noKey.status, 403);

  // 带密钥
  const ctl = new AbortController();
  const stream = await realNode.fetch(`http://uranus.tunnel/facetime/stream?secret=${SECRET}`, {
    signal: ctl.signal,
  });
  check("带密钥的控制通道进去了", stream.status, 200);
  check("Uranus 那边认为节点在线", await until(() => nodeOnline()), true);

  // Uranus 往节点下发一条指令（来电时 beginCall 做的就是这个），节点要收得到
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let got = "";
  sendToNode("join", { link: "https://facetime.apple.com/join#x", name: "Charlie" });
  const deadline = Date.now() + 3000;
  while (!got.includes("\"join\"") && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      sleep(500).then(() => ({ value: undefined, done: false })),
    ]);
    if (done) break;
    if (value) got += dec.decode(value, { stream: true });
  }
  check("节点收到了 join 指令", got.includes("\"join\""), true);
  check("指令里带着链接", got.includes("facetime.apple.com"), true);

  // 隧道断了：Uranus 那边要把节点标成离线（不然来电会发给一个不在的节点）
  stopCallTunnel();
  check("隧道一断，节点算离线", await until(() => !nodeOnline(), 3000), true);

  try { ctl.abort(); } catch {}
  resetCallTunnelForTest();
  resetNodeForTest();
  await realNode.stop();
  await new Promise((r) => srv.close(() => r()));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
