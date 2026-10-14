/*
 * 定时提醒里「哪些日子进时间感知」那一段，外加小剧场「生成后注入」的三档。
 *
 * 指向临时数据目录（URANUS_DATA_DIR），绝不碰用户真实的 data/ —— 那里面有真的
 * 提醒、聊天记录和小剧场成品。不发任何网络请求：测的是纯粹的判断逻辑
 * （specialDayNames / shouldInject / normalizeTheater），不是打模型那一段。
 *
 * 跑法：node scripts/test-reminder.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uranus-reminder-test-"));
process.env.URANUS_DATA_DIR = TMP;
process.env.IMESSAGE_BRIDGE = "off";

const rm = await import("../server/src/reminder.js");
const theater = await import("../server/src/theater.js");
const { normalizeConfig } = await import("../server/src/config.js");
const { ensureLayout } = await import("../server/src/datadir.js");

ensureLayout();

let pass = 0;
let fail = 0;
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`);
  }
}
function checkThat(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
}

/** 清空重来：每一节自己摆自己的数据。 */
function reset() {
  rm.updateReminders((s) => {
    s.items = [];
    s.settings = { leadMinutes: 10, scheduleInTime: false };
  });
}

/* ================= 课表进时间感知 ================= */

console.log("\n=== 1. 课表进时间感知的总开关 ===");
{
  reset();
  /*
   * 2026-10-19 是周一。一条「每周一 08:00 高数」的课表，外加一条生日对照 ——
   * 生日不受这个开关影响，课表受。
   */
  rm.addItem({
    source: "user",
    kind: "schedule",
    title: "高数",
    time: "08:00:00",
    repeat: { type: "weekly", weekdays: [1] },
  });

  // 节日那一路单独测，这里一律关掉，免得「10月19日有没有节」混进来
  const names = (ymd) => rm.specialDayNames(ymd, "", [], { aheadDays: 0, festivals: false });

  check("默认关 → 课表不进时间感知", names("2026-10-19"), []);

  rm.setSettings({ scheduleInTime: true });
  // 带钟点：生日是一整天的事，「今天有课」不说几点就没用
  check("开了 → 当天带钟点进来", names("2026-10-19"), ["高数 08:00"]);
  check("不是周一 → 没有", names("2026-10-20"), []);

  rm.setSettings({ scheduleInTime: false });
  check("关回去 → 又没有了", names("2026-10-19"), []);
}

console.log("\n=== 2. 课表只报当天，不提前报 ===");
{
  reset();
  rm.addItem({
    source: "user",
    kind: "schedule",
    title: "高数",
    time: "08:00:00",
    repeat: { type: "weekly", weekdays: [1] },
  });
  rm.addItem({ source: "user", kind: "birthday", title: "宝宝", date: "2000-10-20", time: "09:00:00", repeat: { type: "yearly" } });
  rm.setSettings({ scheduleInTime: true });

  const names = (ymd, aheadDays) => rm.specialDayNames(ymd, "", [], { aheadDays, festivals: false });

  /*
   * 10-19 是周一（有课），10-20 周二是宝宝生日。站在 10-19 往后看一天：
   * 生日该提前报（能准备），当天那节课照报，但**明天的课不报** ——
   * 一周十几节全提前缀上，每条消息的时间戳后面会拖「明天高数 08:00、
   * 明天线代 10:00、明天体育 14:00」，那是噪音不是感知。
   */
  check("当天的课 + 明天的生日", names("2026-10-19", 1), ["高数 08:00", "明天宝宝的生日"]);
  // 站在周日往后看两天：周一有课、周二生日 —— 只有生日该冒出来
  check("提前两天 → 只有生日，一节课都没有", names("2026-10-18", 2), ["后天宝宝的生日"]);
  check("当天的课照报", names("2026-10-19", 0), ["高数 08:00"]);
}

console.log("\n=== 3. 另外几类不受这个开关影响 ===");
{
  reset();
  rm.addItem({ source: "user", kind: "birthday", title: "宝宝", date: "2000-10-19", time: "09:00:00", repeat: { type: "yearly" } });
  rm.addItem({ source: "user", kind: "anniversary", title: "在一起", date: "2025-10-19", time: "09:00:00", repeat: { type: "yearly" } });
  // 自定义类型有自己的那一条开关（showInTime），和课表那个总开关互不相干
  rm.addItem({
    source: "user",
    kind: "custom",
    title: "期末考试",
    label: "考试",
    date: "2026-10-19",
    time: "09:00:00",
    repeat: { type: "once" },
    showInTime: true,
  });
  rm.addItem({
    source: "user",
    kind: "custom",
    title: "吃药",
    label: "吃药",
    date: "2026-10-19",
    time: "09:00:00",
    repeat: { type: "once" },
    showInTime: false,
  });

  const names = () => rm.specialDayNames("2026-10-19", "", [], { aheadDays: 0, festivals: false });

  // 课表开关关着，这几类照旧
  check("关着时生日 / 纪念日 / 勾了的自定义照旧进来", names(), [
    "宝宝的生日",
    "在一起第一年纪念日",
    "期末考试",
  ]);
  rm.setSettings({ scheduleInTime: true });
  check("开了之后这几类一个字没变", names(), ["宝宝的生日", "在一起第一年纪念日", "期末考试"]);
}

console.log("\n=== 4. 一次性提醒和角色设的都不进时间感知 ===");
{
  reset();
  rm.setSettings({ scheduleInTime: true });
  // 「一次性」那一类压根没进过时间感知（它只是到点说一声），开关不该把它带进来
  rm.addItem({ source: "user", kind: "once", title: "交房租", date: "2026-10-19", time: "09:00:00", repeat: { type: "once" } });
  rm.addItem({ source: "role", kind: "once", title: "提醒她带钥匙", date: "2026-10-19", time: "09:00:00", repeat: { type: "once" } });
  check("都不进", rm.specialDayNames("2026-10-19", "", [], { aheadDays: 0, festivals: false }), []);
}

console.log("\n=== 5. 课表按角色分，和别的几类一个规矩 ===");
{
  reset();
  rm.setSettings({ scheduleInTime: true });
  rm.addItem({
    source: "user",
    kind: "schedule",
    title: "高数",
    roleId: "r-1",
    time: "08:00:00",
    repeat: { type: "weekly", weekdays: [1] },
  });
  const names = (roleId) => rm.specialDayNames("2026-10-19", roleId, [], { aheadDays: 0, festivals: false });
  check("绑的那个角色看得到", names("r-1"), ["高数 08:00"]);
  check("别的角色看不到", names("r-2"), []);
}

console.log("\n=== 6. 设置的规范化 ===");
{
  reset();
  check("默认关", rm.loadReminders().settings.scheduleInTime, false);
  rm.setSettings({ scheduleInTime: true });
  check("开了之后落盘读回来还是开的", rm.loadReminders().settings.scheduleInTime, true);
  // 面板上的开关发的是布尔，但从 JSON 捞回来可能是别的形状
  rm.setSettings({ scheduleInTime: "" });
  check("空串当关", rm.loadReminders().settings.scheduleInTime, false);
  // 改这一项不该把提前量冲掉（同一个对象里的两件事）
  rm.setSettings({ leadMinutes: 25 });
  rm.setSettings({ scheduleInTime: true });
  check("提前量没被带走", rm.loadReminders().settings.leadMinutes, 25);
}

/* ================= 小剧场：生成后注入 ================= */

console.log("\n=== 7. 「生成后注入」三档的规范化 ===");
{
  const mode = (v) => normalizeConfig({ theater: { injectAfterGeneration: v } }).theater.injectAfterGeneration;
  check("off", mode("off"), "off");
  check("all", mode("all"), "all");
  check("picked", mode("picked"), "picked");
  // 老配置里这是个布尔
  check("老配置的 true → 全部注入", mode(true), "all");
  check("老配置的 false → 关", mode(false), "off");
  check("缺字段 → 关", mode(undefined), "off");
  // 手机上改过、或从 JSON 捞回来的字符串形态
  check('字符串 "true" → 全部注入', mode("true"), "all");
  check("数字 1 → 全部注入", mode(1), "all");
  // 认不出的一律退回关：宁可不注入，也别在用户没点头时往会话里塞东西
  check("乱填的 → 关", mode("whatever"), "off");
}

console.log("\n=== 8. 哪一次该注入 ===");
{
  theater.saveTemplate({ title: "勾了的", prompt: "提示词 A", inject: true });
  theater.saveTemplate({ title: "没勾的", prompt: "提示词 B" });
  const picked = theater.listTemplates().find((t) => t.title === "勾了的");
  const plain = theater.listTemplates().find((t) => t.title === "没勾的");
  const cfg = (m) => ({ theater: { injectAfterGeneration: m } });

  check("关 → 勾了的也不注入", theater.shouldInject(cfg("off"), picked.id), false);
  check("全部 → 没勾的也注入", theater.shouldInject(cfg("all"), plain.id), true);
  check("全部 → 临时提示词也注入", theater.shouldInject(cfg("all"), ""), true);
  check("只有勾了的 → 勾了的注入", theater.shouldInject(cfg("picked"), picked.id), true);
  check("只有勾了的 → 没勾的不注入", theater.shouldInject(cfg("picked"), plain.id), false);
  /*
   * 临时提示词（/临时小剧场）没有模板可勾，「只有勾了的才注入」的答案只能是否。
   * 要让临时的也注入就选「全部」。
   */
  check("只有勾了的 → 临时提示词不注入", theater.shouldInject(cfg("picked"), ""), false);
  // 模板被删了之后，指着它的那个 id 不该变成「注入」
  check("模板不存在 → 不注入", theater.shouldInject(cfg("picked"), "没这个id"), false);
  check("配置里压根没有 theater → 不注入", theater.shouldInject({}, picked.id), false);
}

console.log("\n=== 9. 模板上那个勾存得住 ===");
{
  const before = theater.listTemplates().find((t) => t.title === "没勾的");
  check("新建时默认没勾", before.inject, false);

  // 面板上拨开关发的是一整份模板（见 panels/theater.jsx 的 toggleInject）
  theater.saveTemplate({ ...before, inject: true });
  check("拨开之后勾上了", theater.listTemplates().find((t) => t.id === before.id).inject, true);

  // 只改标题（不带 inject 字段）不该把这个勾抹掉
  theater.saveTemplate({ id: before.id, title: "改了名", prompt: before.prompt });
  const renamed = theater.listTemplates().find((t) => t.id === before.id);
  check("只改标题 → 勾还在", renamed.inject, true);
  check("标题真的改了", renamed.title, "改了名");

  theater.saveTemplate({ ...renamed, inject: false });
  check("拨回去 → 勾没了", theater.listTemplates().find((t) => t.id === before.id).inject, false);
}

console.log("\n=== 10. 开箱自带的三个模板都没勾 ===");
{
  // 默认不注入，和「关」那一档的默认一致 —— 换了档位也不该凭空多出注入行为
  checkThat(
    "自带模板一个都没勾",
    theater.listTemplates().filter((t) => t.inject).length === 0 ||
      // 上面那一节拨过开关，只看三个自带的
      !theater
        .listTemplates()
        .filter((t) => ["假如是X上的网H博主小剧场", "同人小剧场", "小红书小剧场"].includes(t.title))
        .some((t) => t.inject)
  );
}

console.log(
  fail ? `\n✗ ${pass} 项通过，${fail} 项失败` : `\n✓ ${pass} 项全部通过`
);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
