/**
 * 不装虚拟声卡、不装虚拟摄像头，直接给 FaceTime 一个我们自己造的媒体流。
 *
 * ── 想法 ──
 *
 * 我们已经能在页面加载之前改写 `getUserMedia`（见 facetime.mjs 的 GUM_SHIM）。
 * 既然能改写，就不一定要把真实设备交给它 —— 可以交一个自己造的：
 *
 *   声音 ← WebAudio 的 MediaStreamDestination（角色的 TTS 往里灌）
 *   画面 ← 一块画着头像的 canvas 的 captureStream()
 *
 * 两者都是货真价实的 MediaStreamTrack，WebRTC 那边看不出区别。
 *
 * ── 为什么值得这么干 ──
 *
 * 原来的方案要在每台节点机器上装虚拟声卡和虚拟摄像头：Linux 上是 PulseAudio
 * 的 null-sink 加 v4l2loopback，Windows 上是 VB-CABLE 加某个虚拟摄像头软件。
 * 这是整个部署里最麻烦、最容易出问题的一步 —— 而且 Windows 上那个虚拟声卡
 * 还会抢系统默认设备，影响用户平时打游戏听声音。
 *
 * 走这条路的话，**一样都不用装**，只要有 Chrome。对「给别人部署」来说差别很大。
 *
 * 还有几个顺带的好处：
 *  - 不经过系统混音，不会混进机器上别的程序的声音；
 *  - 同一台机器上跑多路通话时互不串台（虚拟声卡只有一套）；
 *  - 没有「机器上插着别的摄像头、选错设备」这类问题。
 *
 * ── 风险 ──
 *
 * 没验证过。FaceTime 可能对设备有额外要求（比如检查 track 的 settings、
 * 或者在设备切换时重新申请）。所以先用 `--fake` 跑一次实测：对方能不能
 * 看到头像、听得到声音。不行就退回虚拟设备那条路，那条是验证过的。
 */

import { readFileSync } from "node:fs";

/**
 * 造一段注入脚本：让 `getUserMedia` 返回我们自己的流。
 *
 * @param {object} opts
 * @param {string} [opts.avatarPath] 头像图片，没有就画一块纯色加文字
 * @param {string} [opts.label] 画在占位图上的字
 * @param {boolean} [opts.beep] 每隔几秒响一声 —— 测试时用来确认对方听得到
 * @returns {string} 注入脚本
 */
export function buildFakeMediaShim({ avatarPath = "", label = "Uranus", beep = false } = {}) {
  let avatarDataUrl = "";
  if (avatarPath) {
    try {
      avatarDataUrl = `data:image/png;base64,${readFileSync(avatarPath).toString("base64")}`;
    } catch {
      // 读不到就用占位图，不值得为此中断一通电话
    }
  }

  return `
(() => {
  const md = navigator.mediaDevices;
  if (!md || md.__ftFaked) return;

  const AVATAR = ${JSON.stringify(avatarDataUrl)};
  const LABEL = ${JSON.stringify(label)};
  const BEEP = ${beep ? "true" : "false"};
  const W = 960, H = 540, FPS = 10;

  /* ── 画面：一块 canvas ──────────────────────────────────────────
   * 必须**一直在画**，不能画一帧就停：
   *  1. captureStream(FPS) 只有在 canvas 内容变化时才产出新帧；
   *  2. 完全静止的画面会被 WebRTC 判成卡死，对方看到一个三角感叹号
   *     （这个坑在虚拟摄像头那条路上已经踩过一次了）。
   * 所以每帧都叠一层几乎看不见的噪点。
   */
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  /*
   * 把 canvas 挂进 DOM。
   *
   * 游离在文档之外的 canvas，Chrome 的合成器可能根本不去处理它 —— 画是画了，
   * captureStream 那边却拿不到新帧。挂进去最保险。
   *
   * 不能用 display:none 或 visibility:hidden（那样一样不合成），所以放成一小块
   * 几乎透明的、不挡事的东西：鼠标穿透、压在最上层但看不见。反正这个页面
   * 没有人在看。
   */
  canvas.style.cssText =
    "position:fixed;right:0;bottom:0;width:160px;height:90px;opacity:0.02;" +
    "pointer-events:none;z-index:2147483647";
  const attach = () => {
    if (document.body && !canvas.isConnected) document.body.appendChild(canvas);
  };
  attach();
  document.addEventListener("DOMContentLoaded", attach);

  let img = null;
  if (AVATAR) {
    img = new Image();
    img.src = AVATAR;
  }

  const drawPlaceholder = () => {
    ctx.fillStyle = "#1c1c1e";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.font = "72px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(LABEL, W / 2, H / 2);
  };

  const drawFrame = () => {
    if (img && img.complete && img.naturalWidth) {
      // contain：整张图都在，留黑边，不变形
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      drawPlaceholder();
    }
    /*
     * 让每一帧都和上一帧不同。
     *
     * 完全静止的画面会被编码器当成「没有变化」，一路优化到不发包，对方那边
     * 就变成三角感叹号。噪点要**够明显**才扛得住编码器的降噪 —— 之前用
     * rgba(...,0.02) 太淡，压缩完和纯静止没区别。
     *
     * 右下角那个走动的小方块是第二道保险：它每帧都换位置，而且是实心的，
     * 编码器不可能把它当成噪声抹掉。
     */
    const n = 80;
    for (let i = 0; i < n; i += 1) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(Math.random() * W, Math.random() * H, 3, 3);
    }
    const t = (window.__ftFrames ? window.__ftFrames.drawn : 0) % 40;
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(W - 8 - t * 2, H - 6, 6, 4);
  };

  /*
   * 帧的产出方式：captureStream(0) + 手动 requestFrame()。
   *
   * 传 FPS 的话，由 Chrome 自己判断「canvas 变了没有」再决定抓不抓帧 —— 这个
   * 判断什么时候生效、受不受页面可见性影响，都不在我们手里。传 0 则是
   * **我们说抓才抓**，每画完一帧就显式要一帧，链路短得多也好排查。
   */
  const videoStream = canvas.captureStream(0);
  const videoTrack = videoStream.getVideoTracks()[0];

  /** 画了多少帧、推了多少帧。从外面读它就知道这条链路活着没有。 */
  window.__ftFrames = { drawn: 0, pushed: 0, lastAt: 0, errors: 0, lastError: "" };

  const tick = () => {
    try {
      attach();
      drawFrame();
      window.__ftFrames.drawn += 1;
      if (videoTrack && videoTrack.requestFrame) {
        videoTrack.requestFrame();
        window.__ftFrames.pushed += 1;
      }
      window.__ftFrames.lastAt = Date.now();
    } catch (e) {
      window.__ftFrames.errors += 1;
      window.__ftFrames.lastError = String((e && e.message) || e);
    }
  };

  tick();
  setInterval(tick, Math.round(1000 / FPS));

  /* ── 声音：WebAudio 的 MediaStreamDestination ──────────────────
   * 角色的 TTS 之后往这里灌（window.__ftSay）。平时是静音的 ——
   * 但**不能什么都不接**：有些实现会把一条完全没有源的轨当成已经结束。
   * 所以挂一个振幅为 0 的振荡器让它一直活着。
   */
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ac.createMediaStreamDestination();

  const keepAlive = ac.createOscillator();
  const keepGain = ac.createGain();
  keepGain.gain.value = 0.0001; // 不是 0 —— 有的实现会把纯静音判成没信号
  keepAlive.connect(keepGain).connect(dest);
  keepAlive.start();

  if (BEEP) {
    // 测试用：每 3 秒「嘀」一声，对方听得到就说明上行通了
    setInterval(() => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
      o.connect(g).connect(dest);
      o.start();
      o.stop(ac.currentTime + 0.4);
    }, 3000);
  }

  /* ── 角色说话 ───────────────────────────────────────────────
   * 一句一句排队播。节点那边 TTS 合成好一句就送一句过来，不用等整段说完 ——
   * 这是把「模型想完整段 + 合成完整段」那几秒藏起来的关键。
   */
  const queue = [];
  let playing = null;
  let seq = 0;

  const playNext = () => {
    if (playing || !queue.length) return;
    const item = queue.shift();
    const src = ac.createBufferSource();
    src.buffer = item.buffer;
    src.connect(dest);
    src.onended = () => {
      if (playing === src) playing = null;
      window.__ftSpeech.spoken.push(item.id);
      playNext();
    };
    playing = src;
    window.__ftSpeech.current = item.id;
    src.start();
  };

  /**
   * 排一句话进去。立刻返回，不等它播完。
   *
   * @param base64 音频字节
   * @param id     这句话的编号（被打断时要告诉模型说到第几句）
   * @returns {Promise<{queued:number, duration:number}>}
   */
  window.__ftSay = async (base64, id) => {
    const bin = atob(base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    const buffer = await ac.decodeAudioData(buf.buffer);
    queue.push({ buffer, id: id == null ? seq++ : id });
    playNext();
    return { queued: queue.length, duration: buffer.duration };
  };

  /**
   * 立刻闭嘴（被打断时用）。
   *
   * 队列里没播的一并丢掉 —— 对方已经插话了，再把剩下的说完就是答非所问。
   *
   * @returns {{spoken:number[], dropped:number}} 说出口的是哪几句、丢了几句
   */
  window.__ftShutUp = () => {
    const dropped = queue.length;
    queue.length = 0;
    try { playing && playing.stop(); } catch {}
    playing = null;
    const spoken = window.__ftSpeech.spoken.slice();
    window.__ftSpeech.current = null;
    return { spoken, dropped };
  };

  /** 角色还在说吗。静默检测要用它 —— 自己说话的时候不能算对方在沉默。 */
  window.__ftSpeaking = () => Boolean(playing) || queue.length > 0;

  window.__ftSpeech = { spoken: [], current: null };

  /* ── 把这两条轨交给 FaceTime ──────────────────────────────── */
  const orig = md.getUserMedia.bind(md);
  window.__ftStreams = [];

  md.getUserMedia = async (constraints) => {
    const want = constraints || {};
    const tracks = [];
    if (want.audio) tracks.push(...dest.stream.getAudioTracks());
    if (want.video) tracks.push(...videoStream.getVideoTracks());

    // 一条都没要（不该发生）就退回真实设备，别把通话搞死
    if (!tracks.length) return orig(constraints);

    // AudioContext 可能被自动播放策略挂起，必须唤醒，否则这条轨是哑的
    if (ac.state === "suspended") { try { await ac.resume(); } catch {} }

    const stream = new MediaStream(tracks);
    window.__ftStreams.push(stream);
    return stream;
  };

  md.__ftFaked = true;

  /* ── 接对方的声音 ──────────────────────────────────────────
   *
   * FaceTime 把对方的音频挂在页面的 <audio>/<video> 元素上。我们从那儿接出来
   * 一路分支，重采样到 16kHz 单声道，攒在一个环形缓冲里，节点定期来取。
   *
   * 为什么是「攒着等人来取」而不是「一有数据就往外推」：CDP 的
   * Runtime.evaluate 是一问一答的，页面没法主动推送。节点每 200ms 来取一次，
   * 取走的是这期间攒下的 PCM —— 比按帧推省得多，延迟也只多 200ms。
   *
   * 为什么不在页面里做 VAD：VAD 的参数要能调、要能单元测试，放在页面里既
   * 没法写断言也不好改。页面只负责搬运原始采样。
   */
  const RATE = 16000;
  const ring = [];           // 一段段 Float32Array，等节点来取
  let ringSamples = 0;
  const RING_MAX = RATE * 30; // 最多攒 30 秒，再多就丢最老的（节点挂了也不会把内存吃光）
  let capturing = false;

  const attachCapture = (el) => {
    if (!el || el.__ftTapped) return false;
    const s = el.srcObject;
    if (!s || !s.getAudioTracks || !s.getAudioTracks().length) return false;

    try {
      const src = ac.createMediaStreamSource(s);
      /*
       * ScriptProcessor 是废弃 API，但这里是对的选择：
       *  - AudioWorklet 要单独的 .js 文件，而我们这段是注进页面的字符串，
       *    没有文件可引（blob: URL 又会撞上页面的 CSP）；
       *  - 它只搬运采样、不做运算，废弃 API 那点性能问题在这个量级无所谓。
       */
      const node = ac.createScriptProcessor(4096, 1, 1);
      const ratio = ac.sampleRate / RATE;

      node.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        // 最近邻重采样。语音识别这个用途上够了，不值得为它引一个重采样器
        const outLen = Math.floor(input.length / ratio);
        const out = new Float32Array(outLen);
        for (let i = 0; i < outLen; i += 1) out[i] = input[Math.floor(i * ratio)];
        ring.push(out);
        ringSamples += outLen;
        while (ringSamples > RING_MAX) {
          ringSamples -= ring.shift().length;
        }
      };

      /*
       * 必须接到 destination，否则 ScriptProcessor 不会被调用（规范如此）。
       * 但增益设成 0 —— 不然对方的声音会从节点这台机器的喇叭里放出来，
       * 而且会被我们自己的麦克风绕回去。
       */
      const mute = ac.createGain();
      mute.gain.value = 0;
      src.connect(node);
      node.connect(mute).connect(ac.destination);

      el.__ftTapped = true;
      capturing = true;
      return true;
    } catch (e) {
      window.__ftCapture.errors.push(String((e && e.message) || e));
      return false;
    }
  };

  window.__ftCapture = { errors: [], tapped: 0 };

  /** 盯着页面，一有带声音的媒体元素就接上去。FaceTime 的元素是动态加的。 */
  const scan = () => {
    let n = 0;
    for (const el of document.querySelectorAll("video, audio")) {
      if (attachCapture(el)) n += 1;
    }
    if (n) window.__ftCapture.tapped += n;
  };
  setInterval(scan, 1000);

  /**
   * 把攒着的采样取走。取走就清空。
   *
   * 转成 Int16 再 base64 —— Float32 过 JSON 体积是它的好几倍，而 16 位
   * 对语音识别来说绰绰有余。
   *
   * @returns {{pcm:string, samples:number, capturing:boolean}}
   */
  window.__ftTake = () => {
    if (!ring.length) {
      return { pcm: "", samples: 0, capturing };
    }
    const total = ringSamples;
    const pcm = new Int16Array(total);
    let at = 0;
    for (const chunk of ring) {
      for (let i = 0; i < chunk.length; i += 1) {
        const v = Math.max(-1, Math.min(1, chunk[i]));
        pcm[at++] = v < 0 ? v * 32768 : v * 32767;
      }
    }
    ring.length = 0;
    ringSamples = 0;

    // Uint8Array → base64。分块是因为一次 apply 太多参数会爆栈
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return { pcm: btoa(bin), samples: total, capturing };
  };

  window.__ftFakeReady = true;
})()
`;
}
