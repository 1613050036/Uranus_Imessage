/**
 * 麦当劳点单：把模型写的 `[麦当劳:巨无霸套餐+麦辣鸡翅×2@外送#不要辣]` 变成一张订单卡片。
 *
 * 和瑞幸（luckin.js）一个套路：模型只写吃什么，工具链由这里按固定顺序调麦当劳中国的
 * 官方 MCP（mcp.mcd.cn），最后发卡片，**对方给卡片贴回应才下单**。调用、解信封、断线
 * 重试都共用 luckin.js 那一套（callBrand）。
 *
 * ## 两种方式
 *
 *  - **外送**（默认）：用对方麦当劳账号里存好的收货地址（delivery-query-addresses），
 *    按地址查能送的门店（delivery-query-stores），送到那个地址。
 *  - **到店**：先查对方收藏的门店，没有收藏再按位置查附近的（query-nearby-stores）。
 *
 * 标记里写 `@外送` / `@到店`，不写按外送；`@` 后面写别的词就当门店名筛选（到店）。
 *
 * ## 字段
 *
 * 照麦当劳 MCP 的约定：orderType 整数 1=到店 / 2=外送；外送要 beCode + addressId；
 * 到店下单要 calculate-price 给的 takeWayCode；calculate-price 的金额单位是**分**，
 * query-meals 里的 currentPrice 是元。菜单里只有 categories 里出现过的 code 是这个
 * 时段能下单的（早餐 / 午餐 / 夜宵会换），meals 字典本身是全天的。
 *
 * 套餐里的子单品（可乐换雪碧）麦当劳的接口改不了，规格词一律不认，只记一句给模型。
 */

import { LuckinError, asList, callBrand, nameScore, num, remarkField } from "./luckin.js";
import { logInfo, logWarn } from "./logs.js";

const call = (config, tool, args, scope) => callBrand(config, "mcd", tool, args, scope);

const DELIVERY = 2;
const PICKUP = 1;

/** 金额：calculate-price 给的是分。 */
const yuanFromFen = (v) => {
  const n = num(v);
  return n === null ? null : n / 100;
};

/** `@` 后面那段 → 方式 + 门店词。 */
function modeOf(store) {
  const s = String(store ?? "").trim();
  if (!s || /外送|外卖|送到|配送|麦乐送/.test(s)) return { orderType: DELIVERY, storeHint: "" };
  if (/^(到店|自取|自提|堂食)$/.test(s)) return { orderType: PICKUP, storeHint: "" };
  return { orderType: PICKUP, storeHint: s.replace(/到店|自取|自提/g, "").trim() };
}

/** 外送：账号里的默认地址（没标默认就取第一个）+ 能送它的第一家店。 */
async function deliveryTarget(config, scope) {
  const raw = await call(config, "delivery-query-addresses", { beType: 2 }, scope);
  const addrs = asList(raw?.addresses ?? raw).filter((a) => a?.addressId);
  if (!addrs.length) throw new LuckinError("麦当劳账号里还没有收货地址，先去麦当劳 App 里加一个，或者写 @到店");
  const addr = addrs.find((a) => a.isDefault || a.defaultAddress || a.default) ?? addrs[0];
  const stores = asList(await call(config, "delivery-query-stores", { addressId: addr.addressId, beType: 2 }, scope))
    .filter((s) => s?.storeCode);
  if (!stores.length) throw new LuckinError(`这个地址（${addr.fullAddress ?? "账号里的地址"}）现在没有能送的麦当劳`);
  const st = stores[0];
  return {
    orderType: DELIVERY,
    storeCode: st.storeCode,
    beCode: st.beCode ?? "",
    beType: 2,
    addressId: addr.addressId,
    shopName: String(st.storeName ?? `门店 ${st.storeCode}`),
    shopAddress: String(addr.fullAddress ?? ""),
  };
}

/** 到店：收藏的门店优先，没有再按位置查附近；写了门店词按名字挑。 */
async function pickupTarget(config, loc, storeHint, scope) {
  let stores = asList(await call(config, "query-nearby-stores", { searchType: 1, beType: 1 }, scope));
  if (!stores.length && loc) {
    stores = asList(
      await call(config, "query-nearby-stores", { searchType: 2, beType: 1, latitude: loc.lat, longitude: loc.lon }, scope)
    );
  }
  stores = stores.filter((s) => s?.storeCode);
  if (!stores.length) throw new LuckinError("没查到能去的麦当劳门店（可以在麦当劳 App 里收藏一家常去的）");
  const st = storeHint
    ? [...stores].sort((a, b) => nameScore(storeHint, b.storeName) - nameScore(storeHint, a.storeName))[0]
    : stores[0];
  return {
    orderType: PICKUP,
    storeCode: st.storeCode,
    beCode: st.beCode ?? "",
    beType: 1,
    addressId: "",
    shopName: String(st.storeName ?? `门店 ${st.storeCode}`),
    shopAddress: String(st.address ?? ""),
  };
}

/** 这家店这个时段能点的：code → {name, price}。 */
async function orderableMeals(config, target, scope) {
  const args = { storeCode: target.storeCode, orderType: target.orderType, beType: target.beType };
  if (target.orderType === DELIVERY && target.beCode) args.beCode = target.beCode;
  const d = await call(config, "query-meals", args, scope);
  const dict = d?.meals && typeof d.meals === "object" ? d.meals : {};
  const live = new Set();
  for (const c of Array.isArray(d?.categories) ? d.categories : []) {
    for (const m of Array.isArray(c?.meals) ? c.meals : []) if (m?.code) live.add(String(m.code));
  }
  const out = new Map();
  for (const [code, m] of Object.entries(dict)) {
    if (live.size && !live.has(code)) continue;
    if (m?.name) out.set(code, { name: String(m.name), price: num(m.currentPrice) });
  }
  return out;
}

const targetOf = (config, spec, loc, scope) => {
  const { orderType, storeHint } = modeOf(spec.store);
  return orderType === DELIVERY ? deliveryTarget(config, scope) : pickupTarget(config, loc, storeHint, scope);
};

/**
 * 一整单走到算价：定方式和门店 → 菜单里对名字 → calculate-price。
 * 返回的形状和 luckin.js:draftOrder 一致，imessage.js 那边一套代码管两家的卡片。
 */
export async function draftMcdOrder(config, spec, loc, scope = "麦当劳") {
  const target = await targetOf(config, spec, loc, scope);
  const meals = await orderableMeals(config, target, scope);
  const lines = [];
  const missed = [];
  for (const item of spec.items) {
    let best = null;
    for (const [code, m] of meals) {
      const s = nameScore(item.name, m.name);
      if (!best || s > best.s) best = { code, m, s };
    }
    if (!best || best.s < 30) {
      missed.push(`现在没有「${item.name}」`);
      continue;
    }
    if (item.specs.length) missed.push(`「${item.name}」的 ${item.specs.join("、")} 改不了（麦当劳的接口不能换套餐里的单品）`);
    lines.push({ productCode: best.code, name: best.m.name, spec: "", qty: item.qty, unitPrice: best.m.price });
  }
  if (!lines.length) throw new LuckinError(missed.join("；") || "一样都没配出来");

  const args = {
    storeCode: target.storeCode,
    orderType: target.orderType,
    beType: target.beType,
    items: lines.map((l) => ({ productCode: l.productCode, quantity: l.qty })),
  };
  if (target.orderType === DELIVERY && target.beCode) args.beCode = target.beCode;
  const p = await call(config, "calculate-price", args, scope);
  const tw = Array.isArray(p?.takeWayList) ? p.takeWayList[0] : null;

  return {
    ...target,
    lines,
    total: yuanFromFen(p?.price) ?? lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0),
    original: yuanFromFen(p?.originalPrice),
    privilege: yuanFromFen(p?.discount),
    delivery: yuanFromFen(p?.deliveryPrice),
    takeWayCode: String(tw?.takeWayCode ?? tw?.code ?? ""),
    remark: spec.remark ?? "",
    missed,
  };
}

/** 按存下来的那份草稿真下单。麦当劳给的是 H5 付款页（https），发成链接卡片点开就能付。 */
export async function placeMcdOrder(config, draft, scope = "麦当劳") {
  const args = {
    storeCode: draft.storeCode,
    orderType: draft.orderType,
    beType: draft.beType,
    items: draft.lines.map((l) => ({ productCode: l.productCode, quantity: l.qty })),
  };
  if (draft.orderType === DELIVERY) {
    if (draft.beCode) args.beCode = draft.beCode;
    args.addressId = draft.addressId;
  } else if (draft.takeWayCode) {
    args.takeWayCode = draft.takeWayCode;
  }
  const field = draft.remark ? await remarkField(config, "mcd", "create-order", scope) : "";
  if (field) args[field] = draft.remark;
  else if (draft.remark) logInfo(scope, `麦当劳的下单接口没有备注这一项，「${draft.remark}」只写在卡片上`);

  const r = await call(config, "create-order", args, scope);
  const orderId = String(r?.orderId ?? r?.orderDetail?.orderId ?? "");
  logInfo(scope, `麦当劳下单成功，订单号 ${orderId || "（没给）"}`);
  return { orderId, remarkSent: Boolean(field), payUrl: String(r?.payH5Url ?? ""), qrUrl: "" };
}

/** 「自动带上菜单」：这家店这个时段能点的，最多列 60 样。缓存 30 分钟。 */
const menuCache = new Map();
export async function autoMcdMenuText(config, loc, mode, scope = "麦当劳") {
  const target = await targetOf(config, { store: mode }, loc, scope);
  const key = `${target.storeCode}|${target.orderType}`;
  const hit = menuCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.text;
  const meals = await orderableMeals(config, target, scope);
  const rows = [...meals.values()].slice(0, 60).map((m) => `- ${m.name}${m.price !== null ? ` ¥${m.price.toFixed(2)}` : ""}`);
  const how = target.orderType === DELIVERY ? `外送到账号里的地址，由 ${target.shopName} 配送` : `到店：${target.shopName}`;
  const text = rows.length ? `${how}。现在能点的：\n${rows.join("\n")}` : `${how}，这个时段没查到能点的。`;
  menuCache.set(key, { at: Date.now(), text });
  if (!rows.length) logWarn(scope, `${target.shopName} 这个时段没查到能点的`);
  else logInfo(scope, `查好了 ${target.shopName} 的菜单（${rows.length} 样），缓存 30 分钟`);
  return text;
}

/** 平时只注入这一句，聊到吃的才换成完整说明（同 luckin.js:LUCKIN_SHORT_HINT）。 */
export const MCD_SHORT_HINT = "你能帮对方点麦当劳（对方聊到饿了、想吃东西时，完整的写法会告诉你）。";

/** 聊到吃的那些词。宽一点无所谓：判错的代价只是这一轮多带几百字。 */
const WANT_RE = /麦当劳|麦记|金拱门|汉堡|巨无霸|麦辣|薯条|鸡块|麦乐鸡|麦旋风|板烧|麦满分|鸡翅|饿了|好饿|饿死|吃点|吃啥|吃什么|外卖|夜宵|宵夜/i;

/** 这一轮要不要换上完整说明：最近三句聊到吃的，或者最近几条里刚点过一单。 */
export function mcdWanted(sent) {
  const list = Array.isArray(sent) ? sent : [];
  const text = (m) => (typeof m?.content === "string" ? m.content : "");
  const users = list.filter((m) => m?.role === "user").slice(-3);
  if (users.some((m) => WANT_RE.test(text(m)))) return true;
  return list.slice(-6).some((m) => /[[［]\s*(?:麦当劳|mcd)|麦当劳订单/i.test(text(m)));
}
