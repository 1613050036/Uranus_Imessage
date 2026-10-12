/**
 * 把 `scripts/test-*.mjs` 全跑一遍，最后报一行总账。
 *
 * 跑法：`npm test`
 *
 * ── 为什么需要这个 ──
 *
 * 这些测试一直是一个一个手敲 `node scripts/test-xxx.mjs` 跑的，于是：
 *
 *  - 改了公共代码（config.js、preset.js 这种）很难确认没碰坏别的摊子，
 *    实际发生过：`voiceSend` 多了两个字段，test-media 从那天起就是红的，
 *    没人知道，因为没人会去跑一个和自己改的东西无关的文件；
 *  - **两个文件必须带 `--experimental-test-module-mocks` 才能跑**
 *    （test-location / test-transfer 用 node:test 的 mock.module 换掉
 *    photongrpc）。不带的话报一句 `mock.module is not a function`，
 *    看起来就像测试坏了 —— 交接文档里就把它们记成「红的」记了好几版。
 *    这个脚本统一带上那个 flag，省掉这个误会。
 *
 * 退出码：有任何一个文件失败就是 1，CI 和 `&&` 都能用。
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/*
 * 这个 flag 对不用 mock.module 的文件是**无害的**（Node 只是多认一个实验
 * 特性），所以一律带上，不去维护「哪几个需要」那张表 —— 那张表一定会过期。
 */
const FLAGS = ["--experimental-test-module-mocks"];

/** 自己（test-all）不算，别递归。 */
const files = readdirSync(HERE)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs") && f !== "test-all.mjs")
  .sort();

/** 跑一个文件，返回它的退出码和输出。 */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...FLAGS, join(HERE, file)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const failed = [];
const started = Date.now();

for (const file of files) {
  const { code, out } = await run(file);
  const name = file.replace(/^test-|\.mjs$/g, "");
  if (code === 0) {
    /*
     * 成功的只打最后一行有字的那行（各文件自己的「全部通过：N 条」）——
     * 全文打出来几千行，真正要看的失败会被埋掉。
     */
    const tail = out.trimEnd().split("\n").filter((l) => l.trim()).at(-1) ?? "";
    console.log(`  ✓ ${name.padEnd(16)} ${tail.trim()}`);
  } else {
    failed.push(name);
    console.log(`\n  ✗ ${name}（退出码 ${code}）`);
    // 失败的全文打出来，不然还得自己再跑一遍
    console.log(
      out
        .trimEnd()
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")
    );
    console.log("");
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n${failed.length ? `有失败：${failed.join("、")}` : "全部通过"}` +
    `（${files.length - failed.length}/${files.length} 个文件，${secs}s）\n`
);

if (!failed.length) {
  console.log("节点那边的测试在另一个 workspace 里，单独跑：cd facetime-node && npm test\n");
}

process.exit(failed.length ? 1 : 0);
