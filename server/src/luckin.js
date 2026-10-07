/**
 * 瑞幸点单：把模型写的 `[瑞幸:生椰拿铁|大杯|少冰]` 变成一张真的订单卡片。
 *
 * ## 为什么不让模型直接调瑞幸的工具
 *
 * 瑞幸开放平台（open.lkcoffee.com）给的是一台 MCP 服务器。最省事的接法是把它登记
 * 进「自定义 MCP」让角色自己调 —— 但那条路有三个毛病：
 *
 *  1. 工具链长（查门店 → 搜商品 → 切规格 → 算价），每一步都是一整轮模型调用，
 *     又慢又贵，弱一点的模型还会把 productId / skuCode 配错对；
 *  2. 下单工具也在清单里，模型**真能自己下单**；
 *  3. 结果只是一段文字，出不了卡片。
 *
 * 所以和点歌（music.js）一个模式：模型只写它知道的东西（喝什么、什么规格），
 * 工具链由这里按固定顺序调，最后发一张订单卡片。**下单只在对方给卡片贴了
 * emoji 之后才发生**，模型自始至终碰不到下单那一步。
 *
 * ## 标记长什么样
 *
 *   [瑞幸:生椰拿铁|大杯|少冰]
 *   [瑞幸:生椰拿铁|大杯|少冰+美式×2|热]       ← 多杯用 + 连，数量写在名字后面
 *   [瑞幸:生椰拿铁|大杯@XX广场]               ← @ 后面是门店名里的词，用来挑店
 *
 * ## 位置
 *
 * 瑞幸查门店要经纬度。按这个顺序取：对方在这段对话里最近发来的位置（runner 内存
 * 里记着，见 notePeerLocation）→ 「你」设置里填的地址。地址可以直接贴坐标或者
 * 苹果地图的链接（最准），也可以写一句文字地址，那时候去 OpenStreetMap 的
 * Nominatim 查一次再换成国测局坐标（GCJ-02）—— 国内的地图和门店坐标都是这套。
 *
 * ## 返回格式
 *
 * 瑞幸的工具返回在 content 的 text 里，正文是一个 `{code, msg, data, success}`
 * 的信封，有时前面还带一段说明文字。unwrapResult 负责从里面抠出 data。
 * 字段名（deptId / productId / skuCode / productAttrs / discountPrice /
 * payOrderUrl …）以瑞幸开放平台的文档为准，读的时候都留了兜底。
 */

import { callServerTool, listServerTools } from "./mcp.js";
import { logDebug, logInfo, logWarn } from "./logs.js";
import { netCodes, whyNetwork } from "./net.js";

/** 瑞幸官方的点单 MCP 服务器。 */
export const LUCKIN_MCP_URL = "https://gwmcp.lkcoffee.com/order/user/mcp";

/** 麦当劳中国官方的点单 MCP 服务器。点单链路还没接，角色配置「点单」那栏的「测试连接」先用它。 */
export const MCD_MCP_URL = "https://mcp.mcd.cn";

/** 单次工具调用最多等多久（秒）。发消息那条路在等它。 */
const CALL_TIMEOUT_S = 20;

/** 地址查坐标最多等多久。 */
const GEOCODE_TIMEOUT_MS = 8000;

/** 一单最多几杯、一杯最多几份。模型写离谱了按这个收口。 */
const MAX_ITEMS = 6;
const MAX_QTY = 9;

export class LuckinError extends Error {}

/* ================= 调用 ================= */

/** 有没有配瑞幸的 token。 */
export function luckinReady(config) {
  return brandReady(config, "luckin");
}

/**
 * 在一段文字里找第一个能解析的 JSON 对象。
 *
 * 瑞幸的返回有时是「一段说明 + JSON」，直接 JSON.parse 会失败。从每个 `{` 开始
 * 按括号配平截一段试，取第一段能解析的。
 */
function findJson(text) {
  const s = String(text ?? "").trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* 往下找 */
  }
  for (let start = s.indexOf("{"); start >= 0; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = !inStr;
      else if (!inStr && ch === "{") depth++;
      else if (!inStr && ch === "}" && --depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** 信封里的 data 也可能是一段 JSON 字符串，再剥一层。 */
function deepParse(v) {
  if (typeof v === "string" && /^\s*[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * tools/call 的原始 result → data。业务失败（isError、success:false、code 非 0）抛 LuckinError，
 * 带上瑞幸自己的那句 msg —— 「门店已打烊」「商品已售罄」这种话原样给用户看最有用。
 */
export function unwrapResult(result, tool) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
  const body = result?.structuredContent ?? findJson(text);
  if (result?.isError) throw new LuckinError(`${tool} 失败：${text.slice(0, 200) || "瑞幸没说原因"}`);
  if (body === undefined) throw new LuckinError(`${tool} 回的不是 JSON：${text.slice(0, 200)}`);
  if (body && typeof body === "object" && !Array.isArray(body) && "data" in body) {
    const failed =
      body.success === false || (body.code !== undefined && String(body.code) !== "0" && body.code !== 200);
    if (failed) throw new LuckinError(`${tool} 失败：${body.msg ?? body.message ?? JSON.stringify(body).slice(0, 200)}`);
    return deepParse(body.data);
  }
  return body;
}

/** 两家的连接信息。麦当劳的点单链路在 mcd.js，调用和解信封共用这里这一套。 */
const BRANDS = {
  luckin: { label: "瑞幸", url: LUCKIN_MCP_URL, key: "luckinApi", expiry: "（token 可能过期了，瑞幸的 token 大约一个月失效）" },
  mcd: { label: "麦当劳", url: MCD_MCP_URL, key: "mcdApi", expiry: "（token 可能失效了，去 open.mcd.cn/mcp 重新申请）" },
};

/** 这家有没有配 token。 */
export function brandReady(config, brand) {
  return Boolean(String(config?.[BRANDS[brand].key]?.token ?? "").trim());
}

function serverOf(config, brand = "luckin") {
  const b = BRANDS[brand];
  const token = String(config?.[b.key]?.token ?? "").trim();
  if (!token) throw new LuckinError(`还没填${b.label}的 token（角色配置 → 点单）`);
  return {
    // 连接池按 id 认连接、按签名判要不要重连 —— token 换了签名就变，自动重连
    id: `__${brand}__`,
    transport: "http",
    url: b.url,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    timeout: CALL_TIMEOUT_S,
  };
}

/** 调一个瑞幸工具，返回剥好的 data。 */
export function callLuckin(config, tool, args, scope = "瑞幸") {
  return callBrand(config, "luckin", tool, args, scope);
}

/** 调某一家的某个工具，返回剥好的 data。 */
export async function callBrand(config, brand, tool, args, scope) {
  const startedAt = Date.now();
  const server = serverOf(config, brand);
  const fail = (e) => {
    // 网络层的错只有一句 fetch failed，真原因在 cause 里；服务器回的错（带 HTTP 码）原样用
    const msg = netCodes(e).length ? whyNetwork(e) : String(e?.message ?? e);
    const hint = /401|403|鉴权/.test(msg) ? BRANDS[brand].expiry : "";
    return new LuckinError(`${tool} 调不通：${msg}${hint}`);
  };
  let result;
  try {
    result = await callServerTool(server, tool, args);
  } catch (first) {
    /*
     * 网络层没连上（连接被重置、连不上）就再试一次 —— 实测这台机器到瑞幸的第一个
     * 连接偶尔会被重置，紧接着再连就好。**下单那一步不重试**：连接断在半路时
     * 对方那边可能已经下了，再调一次就是两单。服务器明确回了错（没有网络错误码）也不重试。
     */
    if (/create[-_]?order/i.test(tool) || !netCodes(first).length) throw fail(first);
    logDebug(scope, `${tool} 第一次没连上（${netCodes(first)[0]}），再试一次`);
    try {
      result = await callServerTool(server, tool, args);
    } catch (e) {
      throw fail(e);
    }
  }
  const data = unwrapResult(result, tool);
  logDebug(
    scope,
    `${tool} ${Date.now() - startedAt}ms`,
    `参数：${JSON.stringify(args)}\n\n${JSON.stringify(data).slice(0, 3000)}`
  );
  return data;
}

/**
 * 下单工具的入参里有没有「备注」这一项，有的话叫什么。
 *
 * 两家的文档里都没写死备注字段（SullyOS 那边也没用过），所以按下单工具自己报的
 * inputSchema 找：名字像 remark / note / comment / memo，或者描述里写着「备注」的
 * 那个字符串字段。找不到返回空串 —— 备注就只写在卡片上，不进订单。
 */
export async function remarkField(config, brand, tool, scope) {
  try {
    const tools = await listServerTools(serverOf(config, brand));
    const props = tools.find((t) => t?.name === tool)?.inputSchema?.properties ?? {};
    for (const [k, v] of Object.entries(props)) {
      if (v?.type && v.type !== "string") continue;
      if (/remark|note|comment|memo|message|备注/i.test(k) || /备注|留言/.test(String(v?.description ?? ""))) return k;
    }
  } catch (e) {
    logDebug(scope, `查不到 ${tool} 的参数表，备注只写在卡片上：${String(e?.message ?? e)}`);
  }
  return "";
}

/** 返回里的列表可能直接是数组，也可能包在 list / data / records 里。 */
export function asList(data) {
  if (Array.isArray(data)) return data;
  for (const k of ["list", "data", "records", "shopList", "productList", "items"]) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return [];
}

export const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

export const money = (v) => {
  const n = num(v);
  return n === null ? "" : `¥${n.toFixed(2)}`;
};

/* ================= 标记 ================= */

/**
 * `生椰拿铁|大杯|少冰+美式×2|热@XX广场` → {items, store}。
 *
 * 数量认 `×2` `x2` `*2` 三种写法，写在名字后面。认不出名字的那一杯丢掉。
 *
 * @returns {{items: {name:string, qty:number, specs:string[]}[], store:string, remark:string}}
 */
export function parseOrderSpec(text) {
  let body = String(text ?? "").trim();
  let store = "";
  let remark = "";
  // `#` 后面是备注，写在最后：`生椰拿铁|大杯@万象城#不要吸管`
  const hash = body.search(/[#＃]/);
  if (hash >= 0) {
    remark = body.slice(hash + 1).trim().slice(0, 50);
    body = body.slice(0, hash);
  }
  const at = body.search(/[@＠]/);
  if (at >= 0) {
    store = body.slice(at + 1).trim();
    body = body.slice(0, at);
  }
  const items = [];
  for (const chunk of body.split(/[+＋]/)) {
    const [head, ...specs] = chunk.split(/[|｜]/).map((s) => s.trim());
    if (!head) continue;
    const m = /^(.*?)\s*[×xX*＊]\s*(\d+)$/.exec(head);
    const name = (m ? m[1] : head).trim();
    if (!name) continue;
    const qty = Math.min(MAX_QTY, Math.max(1, m ? Number(m[2]) : 1));
    items.push({ name, qty, specs: specs.filter(Boolean) });
    if (items.length >= MAX_ITEMS) break;
  }
  return { items, store, remark };
}

/* ================= 位置 ================= */

/** 国测局坐标的转换只在国内做，境外的 WGS-84 原样用。粗框，够用。 */
function outOfChina(lat, lon) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

/**
 * WGS-84 → GCJ-02。OpenStreetMap 给的是前者，国内门店坐标是后者，差几百米 ——
 * 不换的话「最近的店」可能是隔一条街的另一家。公开的标准算法。
 */
export function wgsToGcj(lat, lon) {
  if (outOfChina(lat, lon)) return { lat, lon };
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  const x = lon - 105.0;
  const y = lat - 35.0;
  let dLat =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) +
    ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0 +
    ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0 +
    ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  let dLon =
    300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) +
    ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0 +
    ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0 +
    ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

/**
 * 地址栏里直接写了坐标就认出来：`22.8170,108.3665`，或者苹果地图的链接
 * （`coordinate=` / `ll=` / `q=纬,经`）。苹果地图在国内给的本来就是 GCJ-02，不用换。
 */
export function parseCoords(text) {
  const s = String(text ?? "");
  const m =
    /(?:coordinate|ll|sll|q)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i.exec(s) ??
    /^\s*(-?\d{1,3}\.\d+)\s*[,，]\s*(-?\d{1,3}\.\d+)\s*$/.exec(s);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** 文字地址 → 坐标的缓存。同一个地址不用每单都去问一次。 */
const geoCache = new Map();

/** 用 Nominatim 查文字地址。查不到返回 null，不抛错。 */
async function geocode(address, scope) {
  const key = address.trim();
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=zh-CN&q=" +
      encodeURIComponent(key);
    const res = await fetch(url, {
      // Nominatim 的使用条款要求带一个能认出是谁的 User-Agent
      headers: { "User-Agent": "Uranus-iMessage/1.0 (luckin store lookup)" },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    const list = res.ok ? await res.json() : [];
    const hit = Array.isArray(list) && list[0] ? wgsToGcj(Number(list[0].lat), Number(list[0].lon)) : null;
    geoCache.set(key, hit);
    if (!hit) logWarn(scope, `地址「${key}」查不到坐标，换个写法或者直接贴坐标/苹果地图链接`);
    return hit;
  } catch (e) {
    logWarn(scope, `地址「${key}」查坐标失败`, e);
    return null;
  }
}

/**
 * 这一单按哪儿找店。
 *
 * @param {{lat:number, lon:number}|null} shared 对方在对话里最近发来的位置
 * @param {string} address 「你」设置里填的地址
 * @returns {Promise<{lat:number, lon:number, from:string}|null>}
 */
export async function resolveLocation(shared, address, scope = "瑞幸") {
  if (shared) return { ...shared, from: "你发来的位置" };
  const addr = String(address ?? "").trim();
  if (!addr) return null;
  const direct = parseCoords(addr);
  if (direct) return { ...direct, from: "设置里的坐标" };
  const hit = await geocode(addr, scope);
  return hit ? { ...hit, from: `设置里的地址（${addr}）` } : null;
}

/* ================= 门店 / 商品 ================= */

/** 名字像不像：完全一样 > 包含 > 共用字数。 */
export function nameScore(want, got) {
  const a = String(want ?? "").replace(/\s+/g, "").toLowerCase();
  const b = String(got ?? "").replace(/\s+/g, "").toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a)) return 80 - Math.min(20, b.length - a.length);
  if (a.includes(b)) return 60;
  let common = 0;
  for (const ch of new Set(a)) if (b.includes(ch)) common++;
  return Math.round((common / a.length) * 50);
}

/** 挑一家店。写了门店词先按词查，查不到再退回「离这儿最近的」。 */
export async function findShop(config, loc, storeHint, scope) {
  const base = { longitude: loc.lon, latitude: loc.lat };
  let list = [];
  if (storeHint) list = asList(await callLuckin(config, "queryShopList", { ...base, deptName: storeHint }, scope));
  if (!list.length) list = asList(await callLuckin(config, "queryShopList", base, scope));
  const shop = list.find((s) => s?.deptId != null);
  if (!shop) throw new LuckinError("附近没查到营业中的瑞幸门店");
  return {
    deptId: shop.deptId,
    name: String(shop.deptName ?? shop.shopName ?? `门店 ${shop.deptId}`),
    address: String(shop.address ?? shop.deptAddress ?? ""),
  };
}

/** 搜一个关键词，返回商品列表（原样，字段见文件头）。 */
export async function searchProducts(config, deptId, query, scope) {
  return asList(await callLuckin(config, "searchProductForMcp", { deptId, query }, scope));
}

/** 已选规格拼成一串（「冰 / 大杯 / 少甜」）。 */
export function specDesc(product) {
  const parts = [];
  for (const g of Array.isArray(product?.productAttrs) ? product.productAttrs : []) {
    const sub = (Array.isArray(g?.productSubAttrs) ? g.productSubAttrs : []).find((s) => s?.selected);
    if (sub?.attributeName) parts.push(sub.attributeName);
  }
  return parts.join(" / ");
}

/**
 * 把模型写的规格词一个个对到商品的可选规格上，没选中的就切过去。
 *
 * 规格词和选项名互相包含就算对上（「大杯」对「大杯16oz」、「少冰」对「少冰」）。
 * 对不上的词记下来告诉模型，但不拦这一单 —— 少一个「少甜」不至于不让喝。
 *
 * @returns {Promise<{product: object, missed: string[]}>}
 */
async function applySpecs(config, deptId, product, specs, qty, scope) {
  let cur = product;
  const missed = [];
  for (const word of specs) {
    const w = word.replace(/\s+/g, "");
    let hit = null;
    for (const g of Array.isArray(cur?.productAttrs) ? cur.productAttrs : []) {
      for (const sub of Array.isArray(g?.productSubAttrs) ? g.productSubAttrs : []) {
        const n = String(sub?.attributeName ?? "").replace(/\s+/g, "");
        if (n && (n === w || n.includes(w) || w.includes(n))) {
          hit = { group: g, sub };
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) {
      missed.push(word);
      continue;
    }
    if (hit.sub.selected) continue;
    const next = await callLuckin(
      config,
      "switchProduct",
      {
        deptId,
        productId: cur.productId,
        skuCode: cur.skuCode,
        attrOperationParam: {
          attributeId: hit.group.attributeId,
          subAttr: { attributeId: hit.sub.attributeId, operation: 3 },
        },
        amount: qty,
      },
      scope
    );
    // 切完 skuCode 会变；返回里没商品就当这一项没切成
    if (next?.skuCode) cur = { ...cur, ...next };
    else missed.push(word);
  }
  return { product: cur, missed };
}

/**
 * 一整单从头走到算价：找店 → 每杯搜商品、切规格 → previewOrder。
 *
 * @returns {Promise<object>} 存进 luckinstore 的那份订单草稿（还没下单）
 */
export async function draftOrder(config, spec, loc, scope = "瑞幸") {
  const shop = await findShop(config, loc, spec.store, scope);
  const lines = [];
  const missed = [];
  for (const item of spec.items) {
    const found = await searchProducts(config, shop.deptId, item.name, scope);
    const best = found
      .filter((p) => p?.productId != null && p?.skuCode)
      .map((p) => ({ p, s: nameScore(item.name, p.productName ?? p.name) }))
      .sort((x, y) => y.s - x.s)[0];
    // 一个字都对不上就当没有 —— 宁可说没找到，也不给人点一杯别的
    if (!best || best.s < 20) {
      missed.push(`没找到「${item.name}」`);
      continue;
    }
    const { product, missed: m } = await applySpecs(config, shop.deptId, best.p, item.specs, item.qty, scope);
    if (m.length) missed.push(`「${item.name}」没有 ${m.join("、")} 这个选项`);
    lines.push({
      productId: product.productId,
      skuCode: product.skuCode,
      name: String(product.productName ?? product.name ?? item.name),
      spec: specDesc(product),
      qty: item.qty,
      unitPrice: num(product.estimatePrice ?? product.initialPrice),
    });
  }
  if (!lines.length) throw new LuckinError(missed.join("；") || "一杯都没配出来");

  const productList = lines.map((l) => ({ amount: l.qty, productId: l.productId, skuCode: l.skuCode }));
  const preview = await callLuckin(config, "previewOrder", { deptId: shop.deptId, productList }, scope);

  // previewOrder 回显的商品名和规格更准（到手价也在里面），有就用它的
  const info = Array.isArray(preview?.productInfoList) ? preview.productInfoList : [];
  for (const l of lines) {
    const p = info.find((x) => String(x?.skuCode) === String(l.skuCode));
    if (!p) continue;
    if (p.name) l.name = String(p.name);
    if (p.additionDesc) l.spec = String(p.additionDesc);
    if (num(p.estimatePrice) !== null) l.unitPrice = num(p.estimatePrice);
  }
  const shopInfo = preview?.shopInfo ?? {};
  const total = num(preview?.discountPrice) ?? lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0);

  return {
    deptId: shop.deptId,
    shopName: String(shopInfo.deptName ?? shop.name),
    shopAddress: String(shopInfo.address ?? shop.address),
    lon: loc.lon,
    lat: loc.lat,
    lines,
    total,
    original: num(preview?.totalInitialPrice),
    privilege: num(preview?.privilegeMoney),
    coupons: Array.isArray(preview?.couponCodeList) ? preview.couponCodeList : [],
    remark: spec.remark ?? "",
    missed,
  };
}

/** 按存下来的那份草稿真下单。返回付款链接、二维码图地址和订单号。 */
export async function placeOrder(config, draft, scope = "瑞幸") {
  const args = {
    deptId: draft.deptId,
    productList: draft.lines.map((l) => ({ amount: l.qty, productId: l.productId, skuCode: l.skuCode })),
    longitude: draft.lon,
    latitude: draft.lat,
    ...(draft.coupons?.length ? { couponCodeList: draft.coupons } : {}),
  };
  const field = draft.remark ? await remarkField(config, "luckin", "createOrder", scope) : "";
  if (field) args[field] = draft.remark;
  else if (draft.remark) logInfo(scope, `瑞幸的下单接口没有备注这一项，「${draft.remark}」只写在卡片上`);
  const r = await callLuckin(config, "createOrder", args, scope);
  const orderId = String(r?.orderIdStr ?? r?.orderId ?? "");
  logInfo(scope, `瑞幸下单成功，订单号 ${orderId || "（没给）"}`);
  return {
    orderId,
    remarkSent: Boolean(field),
    payUrl: String(r?.payOrderUrl ?? ""),
    qrUrl: String(r?.payOrderQrCodeUrl ?? ""),
  };
}

/**
 * 在订单详情里找取餐码。字段名文档里没写死，按名字认：takeMealCode / pickupCode /
 * takeCode 这一类，递归找第一个。
 *
 * @returns {Promise<{code:string, status:string}>}
 */
export async function orderStatus(config, orderId, scope = "瑞幸") {
  const d = await callLuckin(config, "queryOrderDetailInfo", { orderId: String(orderId) }, scope);
  let code = "";
  let status = "";
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 5) return;
    for (const [k, v] of Object.entries(o)) {
      if (!code && /(take|pick|meal).*code|取餐/i.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()) {
        code = String(v).trim();
      }
      if (!status && /^(orderStatusName|statusName|orderStatusDesc|statusDesc)$/i.test(k) && typeof v === "string") {
        status = v;
      }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(d, 0);
  return { code, status };
}

/**
 * 「先看菜单」：搜几个词，把商品和价格拼成一段给模型看的文字。
 *
 * 每个词最多列 8 款，规格只列名字不列全部选项 —— 选项太多会把提示词撑爆，
 * 而模型写标记时只要写规格词，切规格是这边的事。
 */
export async function menuText(config, loc, queries, storeHint, scope = "瑞幸") {
  const shop = await findShop(config, loc, storeHint, scope);
  const blocks = [];
  for (const q of queries) {
    let list = [];
    try {
      list = await searchProducts(config, shop.deptId, q, scope);
    } catch (e) {
      blocks.push(`「${q}」：查不到（${e.message}）`);
      continue;
    }
    const rows = list
      .filter((p) => p?.productName ?? p?.name)
      .slice(0, 8)
      .map((p) => {
        const price = money(p.estimatePrice ?? p.initialPrice);
        const groups = (Array.isArray(p.productAttrs) ? p.productAttrs : [])
          .map((g) =>
            (Array.isArray(g?.productSubAttrs) ? g.productSubAttrs : [])
              .map((s) => s?.attributeName)
              .filter(Boolean)
              .join("/")
          )
          .filter(Boolean)
          .join("；");
        return `- ${p.productName ?? p.name} ${price}${groups ? `（可选：${groups}）` : ""}`;
      });
    blocks.push(rows.length ? `「${q}」：\n${rows.join("\n")}` : `「${q}」：没有这类商品`);
  }
  return `门店：${shop.name}${shop.address ? `（${shop.address}）` : ""}\n${blocks.join("\n")}`;
}

/** 自动带上菜单时搜哪些词。瑞幸没有「整张菜单」接口，只能按词搜再合并。 */
const MENU_KEYWORDS = ["拿铁", "美式", "生椰", "厚乳", "茶", "果咖", "冰萃", "新品"];

/** 一家店的菜单缓存多久。连续几轮聊咖啡不用每轮都去查。 */
const MENU_TTL_MS = 30 * 60_000;

/** 最多列几款。再多提示词就太长了。 */
const MENU_MAX = 40;

/** deptId → { at, text } */
const menuCache = new Map();

/**
 * 「自动带上菜单」：找到最近的店，按 MENU_KEYWORDS 搜一遍、按 skuCode 去重，
 * 拼成一段给模型看的菜单。同一家店 30 分钟内直接用缓存。
 *
 * 一个词搜失败不影响别的词；全部失败才抛错（调用方当这轮没菜单）。
 */
export async function autoMenuText(config, loc, scope = "瑞幸") {
  const shop = await findShop(config, loc, "", scope);
  const hit = menuCache.get(String(shop.deptId));
  if (hit && Date.now() - hit.at < MENU_TTL_MS) return hit.text;

  const results = await Promise.allSettled(
    MENU_KEYWORDS.map((q) => searchProducts(config, shop.deptId, q, scope))
  );
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  const seen = new Set();
  const rows = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value) {
      const name = p?.productName ?? p?.name;
      const key = String(p?.skuCode ?? name ?? "");
      if (!name || seen.has(key) || rows.length >= MENU_MAX) continue;
      seen.add(key);
      const groups = (Array.isArray(p.productAttrs) ? p.productAttrs : [])
        .map((g) =>
          (Array.isArray(g?.productSubAttrs) ? g.productSubAttrs : [])
            .map((x) => x?.attributeName)
            .filter(Boolean)
            .join("/")
        )
        .filter(Boolean)
        .join("；");
      rows.push(`- ${name} ${money(p.estimatePrice ?? p.initialPrice)}${groups ? `（${groups}）` : ""}`);
    }
  }
  const text = rows.length
    ? `离对方最近的门店：${shop.name}。这家现在能点的（名字 价格（可选规格））：\n${rows.join("\n")}`
    : `离对方最近的门店：${shop.name}，没查到在售商品。`;
  menuCache.set(String(shop.deptId), { at: Date.now(), text });
  logInfo(scope, `查好了 ${shop.name} 的菜单（${rows.length} 款），缓存 30 分钟`);
  return text;
}

/** 订单里那几杯写成一行（「生椰拿铁 大杯/少冰 ×1、美式 ×2」）。 */
export function linesText(lines) {
  return (lines ?? [])
    .map((l) => `${l.name}${l.spec ? ` ${l.spec}` : ""} ×${l.qty}`)
    .join("、");
}

/* ================= 提示词 ================= */

/**
 * 平时只注入这一句。完整说明（预设里那条 luckin 子条目）只在 luckinWanted 判成
 * 「这几句在聊咖啡」时才换上去 —— 完整那段两百来字，每轮都带纯属白烧。
 */
export const LUCKIN_SHORT_HINT =
  "你能帮对方点瑞幸咖啡（对方聊到想喝咖啡时，完整的写法会告诉你）。";

/** 聊到咖啡的那些词。宽一点无所谓：判错的代价只是这一轮多带两百字。 */
const WANT_RE = /瑞幸|luckin|咖啡|拿铁|美式|生椰|厚乳|橙c|摩卡|卡布|澳白|冷萃|奶咖|点(?:一)?杯|来(?:一)?杯|喝点|下午茶|提神|犯困/i;

/**
 * 这一轮要不要换上完整说明：对方最近三句里聊到了咖啡，或者最近几条里刚点过一单
 * （对方接着说「换成热的」「再加一杯」时也得会写标记）。
 *
 * @param {{role:string, content:any}[]} sent 这一轮发给模型的上文
 */
export function luckinWanted(sent) {
  const list = Array.isArray(sent) ? sent : [];
  const text = (m) => (typeof m?.content === "string" ? m.content : "");
  const users = list.filter((m) => m?.role === "user").slice(-3);
  if (users.some((m) => WANT_RE.test(text(m)))) return true;
  return list.slice(-6).some((m) => /[[［]\s*(?:瑞幸|luckin)|瑞幸订单/i.test(text(m)));
}
