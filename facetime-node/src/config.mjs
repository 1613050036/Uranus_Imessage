/**
 * 节点自己的配置。
 *
 * 只有三样东西：Uranus 在哪、配对密钥、头像。**没有任何模型或 TTS 的密钥** ——
 * 转写和合成都在 Uranus 那边做（见 设计.md 第 2 节），节点连它们是谁都不知道。
 *
 * 这是刻意的：部署的人只在 Uranus 控制台配一次，节点这头粘一串配对码就完事。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FILE = join(ROOT, "config.json");

/** 头像放哪。换头像就覆盖这个文件。 */
export const AVATAR_PATH = join(ROOT, "avatar.png");

const DEFAULTS = {
  /** Uranus 的地址。同机部署就是 http://127.0.0.1:8787 */
  uranus: "http://127.0.0.1:8787",
  /** 配对密钥，和 Uranus 控制台里那个必须一样。 */
  secret: "",
  /** Chrome 的调试端口。被占了才需要改。 */
  debugPort: 9333,
};

export function loadConfig() {
  let saved = {};
  if (existsSync(FILE)) {
    try {
      saved = JSON.parse(readFileSync(FILE, "utf8"));
    } catch (e) {
      throw new Error(`config.json 读不出来（是不是改坏了？）：${e.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...saved };
  // 环境变量优先 —— 容器里跑的时候不用改文件
  if (process.env.FT_URANUS) cfg.uranus = process.env.FT_URANUS;
  if (process.env.FT_SECRET) cfg.secret = process.env.FT_SECRET;
  if (process.env.FT_DEBUG_PORT) cfg.debugPort = Number(process.env.FT_DEBUG_PORT);

  cfg.uranus = String(cfg.uranus).replace(/\/+$/, "");
  return cfg;
}

export function saveConfig(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return out;
}

/**
 * 解一串配对码。
 *
 * 配对码就是「地址 + 密钥」用 base64 打包的一行字符串 —— Uranus 控制台生成，
 * 用户复制粘贴到节点上。比让他在两处分别填地址和密钥少一半出错机会。
 *
 * @param {string} code
 * @returns {{uranus: string, secret: string}}
 */
export function parsePairCode(code) {
  const raw = String(code ?? "").trim().replace(/\s+/g, "");
  if (!raw) throw new Error("配对码是空的");

  let json;
  try {
    json = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new Error("这串配对码不对（base64 解不开）");
  }

  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("这串配对码不对（解出来不是一段 JSON）");
  }

  const uranus = String(obj.u ?? obj.uranus ?? "").trim();
  const secret = String(obj.s ?? obj.secret ?? "").trim();
  if (!uranus || !secret) throw new Error("这串配对码里缺地址或密钥");
  if (!/^https?:\/\//i.test(uranus)) throw new Error(`地址看着不对：${uranus}`);

  return { uranus: uranus.replace(/\/+$/, ""), secret };
}

/** 生成一串配对码。Uranus 那边也要用同一套编码，所以放在这里共享实现。 */
export function makePairCode(uranus, secret) {
  return Buffer.from(JSON.stringify({ u: uranus, s: secret }), "utf8").toString("base64");
}

export { FILE as CONFIG_PATH, ROOT };
