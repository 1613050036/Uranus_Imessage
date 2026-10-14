/**
 * 离线自测：HEIC / HEIF / AVIF 这条路。
 *
 * **修的是一个实机 bug**：用户发 iPhone 直出的 HEIC，角色说「看到灰蒙蒙的
 * 一片」。链路是 sniffImageType 认不出 HEIC → shrinkForVision 当 png 丢给
 * ffmpeg → 打包的 ffmpeg 6.1 解不了图块网格、只解出一小条、其余填平色、
 * **退出码 0** → 一张 1.1MB 的照片「压」成 12KB 的灰图送去识别。
 *
 * 这里验三件事：
 *   1. sniffImageType 认得出这几种（且不把 mp4/mov 误认成图）
 *   2. shrinkForVision 对它们绕开 ffmpeg、原样退回，mimeType 按字节纠正
 *   3. imageLooksComplete 能靠 ISOBMFF 的 box 链抓住截断的 HEIC
 *
 * 不打任何上游、不碰 data/。跑：node scripts/test-heic.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { imageLooksComplete, shrinkForVision, sniffImageType } from "../server/src/media.js";

/**
 * 拼一个 ISOBMFF box：`[4 字节 size][4 字节 type][内容]`，size 含头。
 */
function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 4, "ascii");
  return Buffer.concat([head, payload]);
}

/**
 * 拼一份最小但结构合法的 HEIC：ftyp + mdat。
 *
 * 真 HEIC 里还有 meta/iinf/iloc 那一堆，但这几个函数只看 ftyp 的 brand 和
 * 顶层 box 链收不收得住 —— 多拼出来的部分不参与判断。
 */
function isobmff(brand, payloadSize = 2048) {
  const ftyp = box("ftyp", Buffer.concat([
    Buffer.from(brand, "ascii"),
    Buffer.from("\0\0\0\0", "ascii"), // minor version
    Buffer.from(brand, "ascii"), // compatible brands
  ]));
  return Buffer.concat([ftyp, box("mdat", Buffer.alloc(payloadSize, 0x5a))]);
}

test("sniffImageType 认得出 HEIC / HEIF / AVIF", () => {
  // iPhone 直出的就是 heic；heix 是 10bit 的那种
  for (const brand of ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]) {
    const hit = sniffImageType(isobmff(brand));
    assert.equal(hit?.mimeType, "image/heic", `brand=${brand}`);
    assert.equal(hit?.ext, ".heic", `brand=${brand}`);
  }
  // 安卓机和修图软件存出来的通用 HEIF brand
  for (const brand of ["mif1", "msf1"]) {
    assert.equal(sniffImageType(isobmff(brand))?.mimeType, "image/heif", `brand=${brand}`);
  }
  for (const brand of ["avif", "avis"]) {
    assert.equal(sniffImageType(isobmff(brand))?.mimeType, "image/avif", `brand=${brand}`);
  }
});

test("sniffImageType 不把视频误认成图片", () => {
  /*
   * 这是加 HEIC 之后最该担心的回归：mp4 / mov 和 HEIC 是同一个容器，
   * 全靠 brand 区分。认宽了的话视频附件会被当成图片送去识图模型。
   */
  for (const brand of ["isom", "mp42", "mp41", "qt  ", "M4V ", "3gp4", "dash"]) {
    assert.equal(sniffImageType(isobmff(brand)), null, `brand=${brand}`);
  }
});

test("sniffImageType 原来那四种没受影响", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  assert.equal(sniffImageType(png)?.mimeType, "image/png");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mimeType, "image/jpeg");

  const webp = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "ascii"),
  ]);
  assert.equal(sniffImageType(webp)?.mimeType, "image/webp");
  assert.equal(sniffImageType(Buffer.from("GIF89a", "ascii"))?.mimeType, "image/gif");

  // 认不出的还是 null（调用方自己兜底）
  assert.equal(sniffImageType(Buffer.from("不是图片不是图片", "utf8")), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test("shrinkForVision 对 HEIC 原样退回、不进 ffmpeg", async () => {
  /*
   * 2MB —— **故意放在 700KB 阈值之上**。实机那张 1.1MB 的 HEIC 就是因为
   * 越过了阈值才被交给 ffmpeg；阈值以下的从来没出过问题。
   */
  const heic = isobmff("heic", 2 * 1024 * 1024);
  const out = await shrinkForVision(heic, {
    // iMessage 报的 mimeType 和内容对不上（实机报的就是 image/jpeg）
    mimeType: "image/jpeg",
    name: "IMG_8480.HEIC",
    scope: "测试",
  });

  // 字节一个都没动
  assert.equal(out.buffer.length, heic.length, "HEIC 不该被压");
  assert.ok(out.buffer.equals(heic), "HEIC 的字节该原样退回");
  // mimeType 按字节纠正，不信调用方给的那个 —— 带着 image/jpeg 上去，
  // Gemini 按 JPEG 解一份 HEIC 只会报个看不懂的错
  assert.equal(out.mimeType, "image/heic", "mimeType 该按字节纠正");
});

test("shrinkForVision 对 AVIF / HEIF 一样绕开", async () => {
  for (const [brand, mime] of [["avif", "image/avif"], ["mif1", "image/heif"]]) {
    const buf = isobmff(brand, 2 * 1024 * 1024);
    const out = await shrinkForVision(buf, { mimeType: "", name: "", scope: "测试" });
    assert.ok(out.buffer.equals(buf), `${brand} 的字节该原样退回`);
    assert.equal(out.mimeType, mime, `${brand} 的 mimeType`);
  }
});

test("shrinkForVision 对认不出的字节仍然按调用方给的 mimeType 兜底", async () => {
  // 阈值以下，压根不进 ffmpeg 那条路
  const junk = Buffer.alloc(1024, 0x41);
  const out = await shrinkForVision(junk, {
    mimeType: "image/png",
    name: "",
    scope: "测试",
  });
  assert.ok(out.buffer.equals(junk));
  assert.equal(out.mimeType, "image/png", "认不出格式时用调用方给的");
});

test("imageLooksComplete 抓得住截断的 HEIC", () => {
  const full = isobmff("heic", 4096);
  assert.equal(imageLooksComplete(full), true, "完整的该判完整");

  /*
   * 这是这次修复里最要紧的一条：HEIC 压根不进 ffmpeg 了，这道校验是唯一
   * 能拦住半份 HEIC 的闸。按比例截几刀，每一刀都该被认出来 —— mdat 声明的
   * 末尾落在文件外面。
   */
  for (const ratio of [0.15, 0.45, 0.6, 0.9, 0.99]) {
    const cut = full.subarray(0, Math.floor(full.length * ratio));
    assert.equal(imageLooksComplete(cut), false, `截到 ${ratio * 100}% 该判残缺`);
  }

  /*
   * 截到只剩 ftyp 那个 box、mdat 的头一个字节都没有 —— 这是能认出格式的
   * 最短残缺，该判残缺。
   *
   * 再短就认不出格式了（sniffImageType 要 12 个字节才看得到 brand），那时候
   * 一份 6 字节的 HEIC 和一份 6 字节的 JPEG 没有区别，都走「认不出不表态」
   * 那条分支 —— 那是这个函数一贯的口径，不是 HEIC 特有的洞。
   */
  assert.equal(imageLooksComplete(full.subarray(0, 20)), true, "正好剩一个完整 box");
  assert.equal(imageLooksComplete(full.subarray(0, 24)), false, "mdat 头不全该判残缺");
});

test("imageLooksComplete 不误杀尾部有填充的 HEIC", () => {
  /*
   * 真 HEIC 的顶层 box 不只两个（meta、iref、iprp…），而且相机厂商会在后面
   * 追自己的 box。只要每个 box 都收得住，就该判完整。
   */
  const buf = Buffer.concat([
    isobmff("heic", 1024),
    box("meta", Buffer.alloc(256)),
    box("free", Buffer.alloc(64)),
  ]);
  assert.equal(imageLooksComplete(buf), true);
});

test("imageLooksComplete 对两个特殊 size 按规范处理", () => {
  const ftyp = box("ftyp", Buffer.from("heic\0\0\0\0heic", "ascii"));

  // size === 0：「一直到文件结尾」，合法
  const zero = Buffer.concat([ftyp, Buffer.alloc(4), Buffer.from("mdat", "ascii"), Buffer.alloc(99)]);
  assert.equal(imageLooksComplete(zero), true, "size=0 该判完整");

  // size === 1：真长度在后面 8 个字节里（64 位）
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write("mdat", 4, 4, "ascii");
  head.writeBigUInt64BE(BigInt(16 + 32), 8);
  assert.equal(
    imageLooksComplete(Buffer.concat([ftyp, head, Buffer.alloc(32)])),
    true,
    "64 位 size 收得住该判完整"
  );
  // 同一个 64 位 box，内容少给一半 —— 该判残缺
  assert.equal(
    imageLooksComplete(Buffer.concat([ftyp, head, Buffer.alloc(16)])),
    false,
    "64 位 size 收不住该判残缺"
  );
});

test("imageLooksComplete 对畸形结构不表态（宁可漏不可误杀）", () => {
  const ftyp = box("ftyp", Buffer.from("heic\0\0\0\0heic", "ascii"));

  /*
   * size 比 box 头还小是不合规的。这时候返回 true 交给下游，而不是判残缺
   * —— 这几种都可能是我们对格式的理解不够，而误杀一张好图的代价是角色
   * 看不见对方发的图。顺带这也防着 0 长度 box 把遍历钉在原地。
   */
  const bad = Buffer.alloc(8);
  bad.writeUInt32BE(3, 0);
  bad.write("mdat", 4, 4, "ascii");
  assert.equal(imageLooksComplete(Buffer.concat([ftyp, bad])), true);
});

test("imageLooksComplete 原来 JPEG / PNG 那两条没受影响", () => {
  const jpegOk = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(128),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.equal(imageLooksComplete(jpegOk), true);
  assert.equal(
    imageLooksComplete(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128)])),
    false,
    "没有 EOI 该判残缺"
  );

  const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iend = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from("IEND", "ascii"),
    Buffer.alloc(4),
  ]);
  assert.equal(imageLooksComplete(Buffer.concat([pngHead, Buffer.alloc(64), iend])), true);
  assert.equal(imageLooksComplete(Buffer.concat([pngHead, Buffer.alloc(64)])), false);

  // 认不出格式的一律不表态
  assert.equal(imageLooksComplete(Buffer.from("随便一段字节", "utf8")), true);
  assert.equal(imageLooksComplete(Buffer.alloc(0)), false, "空的就是没有");
});
