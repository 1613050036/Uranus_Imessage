#!/usr/bin/env node
/**
 * 「发消息过去没反应、控制台一行都没有」的一次性诊断。
 *
 * **只读**，不改任何配置、不发任何消息、不打印 projectSecret。
 *
 * 查的是这一件事：配置里存的那个线路号码，**现在**在 Photon 那边还归不归你。
 *
 * 为什么非得单独查一次 —— `linePhone` 是 enroll 成功那一刻写进
 * data.config.json 的（index.js 的 /photon/enroll），之后再没有任何一处拿它
 * 跟 Photon 核对过。而唯一那道启动预检（delivery.js:checkLineRegistered）
 * 拿线路号去 `addresses.isIMessageAvailable`，共享线路对这个调用**永远**回
 * 「Target is a Photon-managed shared line, not a valid recipient」，于是它
 * 只落一条 debug 就跳过了 —— 共享线路上那道预检等于没有。
 *
 * 结果是：线路被回收/重分配、或者 enroll 失效之后，配置里那个号就成了死号。
 * 对方发过去石沉大海，我们这边连一条日志都不会有（消息压根没进程序），
 * 桥接还一直显示「已连接，等消息中」。重启解决不了，因为坏的是落盘的那个号。
 *
 * 跑法（在项目根目录）：
 *   node scripts/diag-line.mjs
 *
 * 换过数据目录的（URANUS_DATA_DIR）会自动跟着走。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://spectrum.photon.codes";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.URANUS_DATA_DIR
  ? path.resolve(process.env.URANUS_DATA_DIR)
  : path.join(ROOT, "data");
const SECRET_PATH = path.join(DATA_DIR, "data.config.json");

/** 号码只留头尾，中间打码 —— 这份输出是要发给别人看的。 */
const mask = (s) => {
  const t = String(s ?? "");
  return t.length <= 7 ? t : `${t.slice(0, 4)}****${t.slice(-3)}`;
};

/** projectId 不是秘密（它在 URL 里），但也只给前 8 位，够定位是哪个项目。 */
const shortId = (s) => String(s ?? "").slice(0, 8);

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

let secrets;
try {
  secrets = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
} catch (e) {
  die(
    `读不到配置文件：${SECRET_PATH}\n` +
      `  （${e.message}）\n` +
      `  请在「小手机」那个文件夹里跑这条命令，不要在别的地方跑。`
  );
}

const projects = (secrets?.projects ?? []).filter((p) => (p.mode ?? "cloud") !== "local");
if (!projects.length) die("配置里没有云端（Photon）项目，这个脚本只查云端模式。");

console.log(`\n数据目录：${DATA_DIR}`);
console.log(`云端项目：${projects.length} 个\n`);

let anyBad = false;

for (const p of projects) {
  const tag = `项目 ${shortId(p.projectId) || "(没填 id)"}…`;
  console.log(`──── ${tag} ────`);
  console.log(`  配置里存的我的号码 myPhone   ：${p.myPhone || "（空）"}`);
  console.log(`  配置里存的线路号码 linePhone ：${p.linePhone || "（空）"}`);

  if (!p.projectId || !p.projectSecret) {
    anyBad = true;
    console.log(`  ✗ 凭据不全（Project ID / Secret 有一个是空的），这条线路起不来。\n`);
    continue;
  }

  const auth = "Basic " + Buffer.from(`${p.projectId}:${p.projectSecret}`).toString("base64");
  let res;
  let body;
  try {
    res = await fetch(`${BASE}/projects/${p.projectId}/users/`, {
      headers: { Authorization: auth },
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    anyBad = true;
    console.log(`  ✗ 连不上 Photon：${e.message}`);
    console.log(`    这台机器出不了网，或者被墙/代理挡了。先解决网络再看别的。\n`);
    continue;
  }

  if (res.status === 401 || res.status === 403) {
    anyBad = true;
    console.log(`  ✗ 凭据被 Photon 拒了（HTTP ${res.status}）。`);
    console.log(`    Project Secret 多半被轮换过了。去 Photon 后台重新取一份，`);
    console.log(`    填回「iMessage → 项目」里保存。\n`);
    continue;
  }
  if (!res.ok) {
    anyBad = true;
    console.log(`  ✗ 查用户列表失败：HTTP ${res.status}\n`);
    continue;
  }

  const users = body?.data?.users ?? body?.data ?? [];
  if (!Array.isArray(users)) {
    anyBad = true;
    console.log(`  ✗ 返回里没有用户列表，Photon 的接口可能变了。\n`);
    continue;
  }

  console.log(`  Photon 那边登记着 ${users.length} 个号码：`);
  for (const u of users) {
    console.log(
      `    ${mask(u.phoneNumber)} → 线路 ${u.assignedPhoneNumber || "（没分配）"}` +
        `${u.createdAt ? `（登记于 ${String(u.createdAt).slice(0, 10)}）` : ""}`
    );
  }

  // ── 判定 ──
  const mine = p.myPhone ? users.find((u) => u.phoneNumber === p.myPhone) : null;

  if (!p.myPhone) {
    anyBad = true;
    console.log(`\n  ✗ 配置里 myPhone 是空的 —— 没法判断哪条登记是你的。`);
    console.log(`    去「iMessage → 项目」里把自己的手机号填上，点一次「开通线路」。`);
  } else if (!mine) {
    anyBad = true;
    console.log(`\n  ✗✗ 你的号码 ${p.myPhone} 不在 Photon 的登记列表里。`);
    console.log(`     这就是「发过去没任何反应、控制台一行都没有」的原因 ——`);
    console.log(`     没登记的号码发给共享线路，Photon 在它那头就丢了，我们这边收不到。`);
    console.log(`     修法：「iMessage → 项目」里确认手机号，点「开通线路」重新登记。`);
  } else if (!mine.assignedPhoneNumber) {
    anyBad = true;
    console.log(`\n  ✗ 你登记上了，但 Photon 没给你分配线路号码。`);
    console.log(`     重新点一次「开通线路」；还是没有就是 Photon 那边的配额问题。`);
  } else if (mine.assignedPhoneNumber !== p.linePhone) {
    anyBad = true;
    console.log(`\n  ✗✗ 线路号码对不上 —— 这多半就是问题所在。`);
    console.log(`     配置里存的（你一直在发的）：${p.linePhone || "（空）"}`);
    console.log(`     Photon 现在给你的          ：${mine.assignedPhoneNumber}`);
    console.log(`     旧号码已经不归你了，发过去当然没反应。`);
    console.log(`     修法：「iMessage → 项目」里点一次「开通线路」把号码刷新，`);
    console.log(`           然后用 ${mine.assignedPhoneNumber} 这个号重新发。`);
  } else {
    console.log(`\n  ✓ 线路没问题：${p.myPhone} → ${mine.assignedPhoneNumber}，和配置一致。`);
    console.log(`    那就不是线路的事，问题在后面（模型、提示词、角色绑定）。`);
    console.log(`    下一步：发一条「在吗」，看控制台有没有「收到一轮消息」那一行。`);
  }
  console.log("");
}

console.log(anyBad ? "上面带 ✗ 的就是要动的地方。\n" : "全部正常。\n");
