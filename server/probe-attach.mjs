/**
 * 临时诊断：在这台机器上直接从 Photon 下一个附件，看网络到底多快。
 * 用法（在 server 目录下）：node probe-attach.mjs [附件guid]
 * 不带 guid 就用最近收到的那个附件。不收消息、不发消息，不影响正在跑的桥接。
 */
import fs from "node:fs";
import { SECRET_PATH } from "./src/datadir.js";
import { createLineClients, closeClients } from "./src/photongrpc.js";

const secret = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
const p = (secret.projects ?? []).find((x) => x.projectId && x.projectSecret);
if (!p) throw new Error(`${SECRET_PATH} 里没有填了 Photon 凭据的项目`);

let t0 = Date.now();
const lines = await createLineClients(p.projectId, p.projectSecret, { timeout: 60_000 });
const { client } = lines[0];
console.log(`换 token + 建连接：${((Date.now() - t0) / 1000).toFixed(1)}s`);

let guid = process.argv[2];
if (!guid) {
  const s = client.events.catchUp(0);
  for await (const e of s) {
    if (e.type === "catchup.complete") break;
    for (const a of e.message?.content?.attachments ?? []) guid = a.guid;
  }
  if (!guid) throw new Error("最近没有收到过附件，发一张图给任意角色再跑");
}

for (let run = 1; run <= 3; run++) {
  t0 = Date.now();
  let got = 0;
  let last = t0;
  const s = client.attachments.downloadStream(guid);
  const kill = setTimeout(() => s.close(), 180_000);
  try {
    for await (const f of s) {
      if (f.type !== "primaryChunk") continue;
      if (!got) console.log(`  第一个字节：${((Date.now() - t0) / 1000).toFixed(1)}s`);
      got += f.data.length;
      if (Date.now() - last > 5000) {
        last = Date.now();
        console.log(`  …${(got / 1048576).toFixed(2)}MB，${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
  } catch (e) {
    console.log(`  出错：${e.constructor.name} ${e.message}`);
  }
  clearTimeout(kill);
  const secs = (Date.now() - t0) / 1000;
  console.log(`第 ${run} 次：${(got / 1048576).toFixed(2)}MB，${secs.toFixed(1)}s，约 ${(got / 1024 / secs).toFixed(0)}KB/s`);
}
await closeClients(lines);
process.exit(0);
