/*
 * 在浏览器里把 .zip 拆成一张张图片，交给图库那个上传按钮照常压缩、上传。
 *
 * 为什么在前端拆：后端不管是桌面版还是小手机（Worker）都不用多一条路由，
 * 也不用把整个压缩包塞进一次请求 —— 拆开之后还是一张一张传，和多选图片一模一样。
 *
 * 不引解压库：zip 的结构很简单，解压用浏览器自带的 DecompressionStream("deflate-raw")。
 * 只认「不压缩」和「deflate」两种（几乎所有打包工具默认就是这两种），加密的包不支持。
 *
 * 文件名编码：Windows 上不少打包方式（资源管理器「发送到压缩文件夹」、系统自带的
 * tar -a）写的中文名是 GBK，而且不打 UTF-8 标记。光「UTF-8 解不开再换 GBK」不够：
 * 有的 GBK 字节恰好也是合法 UTF-8（「小猫」会解成「Сè」）。所以两种都解一遍，
 * 看哪种解出来全是正常文件名里会有的字（见 decodeName）。
 */

const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const isZip = (file) =>
  /\.zip$/i.test(file?.name ?? "") || file?.type === "application/zip" || file?.type === "application/x-zip-compressed";

/** 文件名里正常会出现的字：ASCII、中日文、全角标点、emoji。 */
const PLAUSIBLE = /^[\x20-\x7e\u2000-\u206f\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef\u{1f000}-\u{1faff}]*$/u;

function tryDecode(label, bytes) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 没打 UTF-8 标记的名字：UTF-8 解出来像样就用它（该打标记没打的 UTF-8 包很常见），
 * 不像样但 GBK 像样就用 GBK，两边都不像样的话能解开哪个用哪个。
 */
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  const utf8 = tryDecode("utf-8", bytes);
  if (utf8 !== null && PLAUSIBLE.test(utf8)) return utf8;
  const gbk = tryDecode("gbk", bytes);
  if (gbk !== null && PLAUSIBLE.test(gbk)) return gbk;
  return utf8 ?? gbk ?? new TextDecoder("gbk").decode(bytes);
}

/** Info-ZIP 的 Unicode Path 扩展字段（0x7075）：有的工具名字用本地编码，另外附一份 UTF-8。 */
function unicodePath(view, buf, at, len) {
  for (let i = at; i + 4 <= at + len; ) {
    const id = view.getUint16(i, true);
    const size = view.getUint16(i + 2, true);
    if (id === 0x7075 && size > 5) return new TextDecoder().decode(buf.subarray(i + 9, i + 4 + size));
    i += 4 + size;
  }
  return null;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 拆一个 zip，返回里面的图片。每张是 `{ name, open() }`，`open` 才真去解压出
 * File（名字是去掉文件夹的那一段）—— 一次全解开的话几百张图同时躺在内存里，
 * 和「一张一张来」那条规矩（见 imagefile.js）对着干。
 *
 * 系统垃圾（__MACOSX、.DS_Store、Thumbs.db）和不是图片的文件直接跳过，
 * 跳过了几个会放在 `skipped` 里，方便界面上说一声。
 *
 * @param {File} file
 * @returns {Promise<{images: {name: string, open: () => Promise<File>}[], skipped: string[]}>}
 */
export async function unzipImages(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 从尾巴往前找「中央目录结束」记录（后面可能跟着最长 64KB 的注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`「${file.name}」不是 zip，或者文件不完整`);

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff) throw new Error(`「${file.name}」是 zip64 格式（超过 4GB），不支持`);

  const images = [];
  const skipped = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`「${file.name}」的目录区坏了`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    // Windows PowerShell 的 Compress-Archive 用反斜杠当分隔符
    const path = (
      unicodePath(view, buf, at + 46 + nameLen, extraLen) ??
      decodeName(buf.subarray(at + 46, at + 46 + nameLen), flags & 0x800)
    ).replace(/\\/g, "/");
    at += 46 + nameLen + extraLen + commentLen;

    if (path.endsWith("/")) continue; // 文件夹本身
    const base = path.split("/").pop();
    if (path.startsWith("__MACOSX/") || base.startsWith(".") || /^thumbs\.db$/i.test(base)) continue;
    const type = IMAGE_TYPES[base.split(".").pop()?.toLowerCase()];
    if (!type) {
      skipped.push(base);
      continue;
    }
    if (flags & 0x1) {
      skipped.push(`${base}（加密了）`);
      continue;
    }

    // 本地文件头里的名字和扩展字段长度可能和目录区不一样，得按本地的算数据起点
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (method !== 0 && method !== 8) {
      skipped.push(`${base}（压缩方式不支持）`);
      continue;
    }
    const raw = buf.subarray(start, start + packed);
    images.push({
      name: base,
      open: async () => new File([method === 8 ? await inflate(raw) : raw.slice()], base, { type }),
    });
  }
  return { images, skipped };
}
