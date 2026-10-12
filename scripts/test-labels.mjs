/**
 * 前端 `client/src/labels.js` 和服务端对不对得上。
 *
 * 跑法：`node scripts/test-labels.mjs`
 *
 * ── 为什么要专门测这个 ──
 *
 * labels.js 里住着一批**服务端逻辑的镜像**：预设按 mode 分批、世界书按角色
 * 筛、转写服务挑哪一家。前端不能 import 服务端代码（它要能打进浏览器包），
 * 所以这些规则在两边各写一份，全靠注释里那句「两处一起改」。
 *
 * 那句注释失效过一次，代价不小：服务端的 `PRESET_MODES` 加了 `"call"`，
 * 前端那份没加 —— 于是
 *
 *  - 预设面板的「用在哪种玩法」只有两个按钮，**用户压根建不出通话预设**；
 *  - `presetsFor(config, "call")` 里 `want` 回落成 `"online"`，角色那栏的
 *    「通话预设」下拉框列出来的是一堆线上预设。
 *
 * 两个症状都不报错、不打日志，只是「功能看起来不存在」。这个文件就是为了
 * 下次加第四种玩法时立刻红一下。
 */

import {
  PRESET_MODES as UI_MODES,
  PRESET_MODE_LABELS,
  ENTRY_KIND_LABELS,
  ENTRY_KIND_HINTS,
  presetMode,
  presetsFor,
  resolvePreset,
  sttSourceName,
} from "../client/src/labels.js";
import {
  PRESET_MODES as SRV_MODES,
  CALL_FIXED_KINDS,
  OFFLINE_FIXED_KINDS,
  FIXED_KINDS,
} from "../server/src/preset.js";
import { pickSttSource } from "../server/src/stt.js";

let pass = 0;
let fail = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${what}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${what}\n      得到：${JSON.stringify(got)}\n      期望：${JSON.stringify(want)}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

group("预设的玩法清单：前端和服务端必须一字不差");
{
  check("PRESET_MODES 对得上", UI_MODES, SRV_MODES);
  // 少一个标签的后果是按钮上显示「undefined预设」
  check(
    "每一种玩法都有中文名",
    SRV_MODES.filter((m) => !PRESET_MODE_LABELS[m]),
    []
  );
}

group("presetMode：认得出三种，认不出的算线上");
{
  for (const m of SRV_MODES) {
    check(`${m} 原样认出`, presetMode({ mode: m }), m);
  }
  check("缺字段算线上（老配置）", presetMode({}), "online");
  check("写错了算线上", presetMode({ mode: "蛤" }), "online");
  check("undefined 也不炸", presetMode(undefined), "online");
}

group("presetsFor：三批不串");
{
  const config = {
    presets: [
      { id: "a", mode: "online" },
      { id: "b", mode: "offline" },
      { id: "c", mode: "call" },
      { id: "d" }, // 缺 mode 的老预设
    ],
  };
  check("线上那批（含缺字段的）", presetsFor(config, "online").map((p) => p.id), ["a", "d"]);
  check("线下那批", presetsFor(config, "offline").map((p) => p.id), ["b"]);
  /*
   * 这一条就是那个 bug 的回归测试：前端少了 "call" 的时候，
   * want 回落成 "online"，这里会返回 ["a","d"]。
   */
  check("通话那批", presetsFor(config, "call").map((p) => p.id), ["c"]);
  check("认不出的玩法回落到线上", presetsFor(config, "蛤").map((p) => p.id), ["a", "d"]);
}

group("resolvePreset：三种玩法各看各的引用字段");
{
  const config = {
    presets: [
      { id: "on1", mode: "online" },
      { id: "on2", mode: "online" },
      { id: "off1", mode: "offline" },
      { id: "call1", mode: "call" },
      { id: "call2", mode: "call" },
    ],
  };
  const role = {
    presetRef: "on2",
    offline: { presetRef: "off1" },
    call: { presetRef: "call2" },
  };
  check("线上看 role.presetRef", resolvePreset(config, role, "online")?.id, "on2");
  check("线下看 role.offline.presetRef", resolvePreset(config, role, "offline")?.id, "off1");
  check("通话看 role.call.presetRef", resolvePreset(config, role, "call")?.id, "call2");

  // 引用失效 → 回落到同一批的第一份，**不跨批**
  const stale = { presetRef: "没了", offline: { presetRef: "没了" }, call: { presetRef: "没了" } };
  check("线上引用失效回落到线上第一份", resolvePreset(config, stale, "online")?.id, "on1");
  check("通话引用失效回落到通话第一份", resolvePreset(config, stale, "call")?.id, "call1");

  // 这一批一份都没有 → null（服务端那边会兜底用内置的默认预设）
  const onlyOnline = { presets: [{ id: "on1", mode: "online" }] };
  check("一份通话预设都没有时返回 null", resolvePreset(onlyOnline, role, "call"), null);
}

group("固定条目的中文名：服务端列的每一个都得有");
{
  const kinds = [...new Set([...FIXED_KINDS, ...OFFLINE_FIXED_KINDS, ...CALL_FIXED_KINDS])];
  check(
    "每个固定条目都有中文名",
    kinds.filter((k) => !ENTRY_KIND_LABELS[k]),
    []
  );
  check(
    "每个固定条目都有说明",
    kinds.filter((k) => !ENTRY_KIND_HINTS[k]),
    []
  );
}

group("sttSourceName：和服务端 pickSttSource 同一个判据");
{
  const cases = [
    ["什么都没配", {}],
    ["undefined", undefined],
    ["openai 开着有密钥", { openai: { enabled: true, key: "k" } }],
    ["openai 开着没密钥", { openai: { enabled: true, key: "" } }],
    ["openai 有密钥但关着", { openai: { enabled: false, key: "k" } }],
    ["qwen 开着有密钥", { qwen: { enabled: true, key: "k" } }],
    ["两家都配了（按顺序挑第一个）", { openai: { enabled: true, key: "a" }, qwen: { enabled: true, key: "b" } }],
    ["讯飞三个凭据齐", { xfyun: { enabled: true, appId: "a", apiKey: "b", apiSecret: "c" } }],
    ["讯飞缺一个", { xfyun: { enabled: true, appId: "a", apiKey: "b", apiSecret: "" } }],
    ["只有空白的密钥不算", { openai: { enabled: true, key: "   " } }],
  ];
  for (const [what, api] of cases) {
    /*
     * 两边的**返回值形状不一样**（服务端回 {name,run}，前端回一个中文名），
     * 所以比的是「配没配上」这个布尔 —— 那才是会错位的东西。
     */
    check(what, Boolean(sttSourceName(api)), Boolean(pickSttSource(api)));
  }
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
