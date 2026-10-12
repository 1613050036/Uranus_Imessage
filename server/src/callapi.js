/**
 * 通话节点那三个口子，以及控制台要看的通话状态。
 *
 * ── 为什么节点那几条路径不带 /api/ 前缀 ──
 *
 * `index.js:538` 那个鉴权中间件只管 `/api/` 开头的路径，别的一律放过。节点是
 * 一个**跑在别的机器上的程序**，没有浏览器的 cookie，走不了那套登录 —— 所以
 * 和共感娃娃的 `/doll/hug`（`index.js:1564`）、查岗的 `/phone/screenshot`
 * 一个路子：路径不带 `/api/`，改用预共享密钥。
 *
 * 控制台那两条照常在 `/api/` 下面，跟着登录走。
 *
 * ── 三个口子分别干什么 ──
 *
 *   GET  /facetime/stream     节点挂一条 SSE 上来，等 Uranus 下发指令
 *   POST /facetime/utterance  节点送一段话的 WAV，**响应是流式的**：
 *                             一句一句回「文本 + 合成好的音频」
 *   POST /facetime/event      节点报状态：入会成功、对方挂断、出错
 *
 * 主循环是中间那条。控制通道（SSE）只用来下发节点自己发起不了的事 ——
 * 入会、挂断、静默提醒那条主动开口。
 *
 * ── 为什么是 SSE 不是 WebSocket ──
 *
 * 这个仓库里一个 WebSocket 都没有，实时全靠 SSE（`index.js:1150` 那条日志流）。
 * 不为一个功能引一套新机制。而且 SSE 这边只下发寥寥几条指令，用不着双向。
 */

import { getCall, callStatus, endCall, touchNode } from "./callsession.js";
import { logDebug, logInfo, logWarn } from "./logs.js";

const SCOPE = "通话";

/** 节点那几条路径。不带 /api/ 前缀，故意的，见文件头。 */
export const NODE_PATHS = {
  stream: "/facetime/stream",
  utterance: "/facetime/utterance",
  event: "/facetime/event",
};

/** 一次最多收多大的音频。16kHz 单声道 WAV，30 秒约 1MB，给到 4MB 很宽裕。 */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** 挂在上面的那个节点。一次只有一个。 */
let node = null; // { res, at, ip }

/**
 * 给节点下发一条指令。
 *
 * @returns {boolean} 节点在不在线
 */
export function sendToNode(type, payload = {}) {
  if (!node) return false;
  try {
    node.res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    logDebug(SCOPE, `给节点发了「${type}」`);
    return true;
  } catch (e) {
    logWarn(SCOPE, "给节点发指令失败，当它掉线了", e);
    node = null;
    return false;
  }
}

/** 节点在线吗。 */
export function nodeOnline() {
  return Boolean(node);
}

/**
 * 挂上这几条路由。
 *
 * @param {import("express").Express} app
 * @param {() => object} loadConfig
 * @param {object} hooks 由 index.js 把 imessage.js 那边的函数传进来 ——
 *   这个文件不 import imessage.js（那边 8000 多行，而且会绕回来 import 配置）
 */
export function mountCall(app, loadConfig, hooks = {}) {
  /** 密钥对不对。对不上就把响应写好并返回 false。 */
  const checkSecret = (req, res) => {
    const cfg = loadConfig()?.callNode ?? {};
    const want = String(cfg.secret ?? "").trim();

    if (!cfg.enabled || !want) {
      /*
       * 回 404 而不是 403：别告诉扫端口的人这儿有东西。
       * 但**日志里要说明白** —— 节点那头只看得到一个 404，而 404 既可能是
       * 「地址填错了」也可能是「功能没开」，不说的话用户只能干瞪眼。
       * 这条和 doll 那边（index.js:1570 附近）是同一个处理。
       */
      logWarn(
        SCOPE,
        `有节点来连，但${!cfg.enabled ? "通话功能没开" : "还没设配对密钥"} —— 回了 404`
      );
      res.status(404).end();
      return false;
    }

    const got = String(req.query?.secret ?? req.get("x-call-secret") ?? "").trim();
    if (got !== want) {
      logWarn(SCOPE, "有节点来连，但配对密钥不对");
      res.status(403).json({ ok: false, error: "配对密钥不对" });
      return false;
    }
    return true;
  };

  /* ── 控制通道：节点挂一条 SSE 上来 ───────────────────────── */

  app.get(NODE_PATHS.stream, (req, res) => {
    if (!checkSecret(req, res)) return;

    // 已经有一个节点挂着的话，把旧的踢掉 —— 多半是它掉线了又重连
    if (node) {
      logInfo(SCOPE, "又来了一个节点，把旧的那条连接关掉");
      try {
        node.res.end();
      } catch {
        // 已经断了，无所谓
      }
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // 反代（Nginx）默认会缓冲 SSE，这个头让它别缓冲 —— 和日志流那条一样
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    node = { res, at: Date.now(), ip: req.ip };
    logInfo(SCOPE, `通话节点连上来了（${req.ip}）`);
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

    // 25 秒一次心跳，别让中间的代理掐掉这条长连接
    const beat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(beat);
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(beat);
      if (node?.res === res) {
        node = null;
        logInfo(SCOPE, "通话节点断开了");
        /*
         * 节点没了，正在进行的通话也就没了 —— 浏览器是它那边起的。
         * 不收尾的话这通电话会一直挂着，之后所有来电都被「一次只能一通」挡掉。
         */
        const call = getCall();
        if (call) {
          logWarn(SCOPE, "节点断开时还有一通电话在进行，按挂断处理");
          void hooks.onCallEnded?.(endCall("节点断开了"));
        }
      }
    });
  });

  /* ── 主循环：节点送一段话，流式拿回角色的回答 ─────────────── */

  app.post(
    NODE_PATHS.utterance,
    // 自收原始字节。全局那个 express.json 挂在 index.js:725，比这儿靠后，
    // 所以这里拿到的是未解析的流
    (req, res, next) => {
      if (!checkSecret(req, res)) return;
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_AUDIO_BYTES) {
          res.status(413).json({ ok: false, error: "这段音频太大了" });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        req.rawAudio = Buffer.concat(chunks);
        next();
      });
      req.on("error", () => res.status(400).end());
    },
    async (req, res) => {
      touchNode();
      const call = getCall();
      if (!call) {
        return res.status(409).json({ ok: false, error: "现在没有正在进行的通话" });
      }

      /*
       * 响应是**流式的**：一句一句往回写，节点收到一句就播一句。
       *
       * 格式和这个仓库里别的 SSE 一致（`client/src/store.jsx:73` 那个 apiStream
       * 解的就是这个），所以前端以后要复用也不用另写解析。
       */
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (type, data) => {
        try {
          res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        } catch (e) {
          logDebug(SCOPE, "往回写的时候断了", e);
        }
      };

      try {
        await hooks.onUtterance?.({
          audio: req.rawAudio,
          kind: String(req.query?.kind ?? "said"),
          seconds: Number(req.query?.seconds ?? 0),
          send,
        });
        send("done", {});
      } catch (e) {
        logWarn(SCOPE, "这一轮没答上来", e);
        send("error", { error: String(e?.message ?? e) });
      } finally {
        res.end();
      }
    }
  );

  /* ── 节点报状态 ──────────────────────────────────────────── */

  app.post(NODE_PATHS.event, async (req, res) => {
    if (!checkSecret(req, res)) return;
    touchNode();

    const body = req.body ?? {};
    const type = String(body.type ?? "");
    logInfo(SCOPE, `节点报告：${type}${body.reason ? `（${body.reason}）` : ""}`);

    try {
      await hooks.onEvent?.(type, body);
      res.json({ ok: true });
    } catch (e) {
      logWarn(SCOPE, `处理「${type}」时出错`, e);
      res.status(400).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  /* ── 控制台：看状态、手动挂断 ─────────────────────────────── */

  app.get("/api/call/status", (req, res) => {
    const cfg = loadConfig()?.callNode ?? {};
    res.json({
      ok: true,
      // 不回配对密钥。前端要显示「配好了没有」，给个布尔值就够了
      node: {
        enabled: Boolean(cfg.enabled),
        direction: cfg.direction ?? "node",
        hasSecret: Boolean(String(cfg.secret ?? "").trim()),
        url: cfg.direction === "uranus" ? String(cfg.url ?? "") : "",
        online: nodeOnline(),
      },
      call: callStatus(),
    });
  });

  app.post("/api/call/hangup", async (req, res) => {
    const call = getCall();
    if (!call) return res.json({ ok: true, call: { active: false } });

    sendToNode("hangup", { reason: "控制台挂断" });
    await hooks.onCallEnded?.(endCall("控制台挂断"));
    res.json({ ok: true, call: callStatus() });
  });
}

/** 测试用。 */
export function resetNodeForTest() {
  node = null;
}
