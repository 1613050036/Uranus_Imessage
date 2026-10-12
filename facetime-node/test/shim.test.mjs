import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildFakeMediaShim } from "../src/fakemedia.mjs";
import { GUM_SHIM } from "../src/facetime.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/*
 * 注进页面的那几段代码是**模板字符串**，所以里面写一个反引号就会把它截断 ——
 * 而且截断处往往离真正的报错很远（「Unexpected identifier 'connectionState'」
 * 指向的是一行注释）。这个坑踩过两次，都是写注释时顺手用反引号引了个标识符。
 *
 * 下面两条测试把它钉死：注入的代码本身必须是合法 JS，而且不许含反引号。
 */

const shims = [
  ["fakemedia 的注入脚本", buildFakeMediaShim({ label: "测试" })],
  ["facetime 的 getUserMedia 钩子", GUM_SHIM],
];

for (const [name, code] of shims) {
  test(`${name}：本身是合法 JS`, () => {
    assert.doesNotThrow(() => new Function(code), `${name} 解析失败 —— 多半是注释里写了反引号`);
  });

  test(`${name}：不含反引号`, () => {
    const at = code.indexOf("`");
    if (at >= 0) {
      const around = code.slice(Math.max(0, at - 60), at + 20).replace(/\n/g, "\n");
      assert.fail(`第 ${at} 个字符是反引号，会把模板字符串截断：…${around}…`);
    }
  });
}

test("源文件里 HELPER 和 GUM_SHIM 都还是模板字符串（改法变了要更新这个测试）", () => {
  const src = readFileSync(join(SRC, "facetime.mjs"), "utf8");
  assert.match(src, /const HELPER = `/, "HELPER 不再是模板字符串了？");
  assert.match(src, /export const GUM_SHIM = `/, "GUM_SHIM 不再是模板字符串了？");
});
