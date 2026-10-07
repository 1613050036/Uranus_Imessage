/**
 * 快捷指令一览 —— 右上角那张表的数据。
 *
 * **这是 server/src/commands.js 里 buildHelp() 那张表的镜像。**
 * 改了那边记得改这边：两张表说的不一样，用户会信错一张，然后对着一条
 * 根本不存在的指令怀疑自己手机坏了。
 *
 * 为什么不直接把后端那张纯文本发过来渲染：那份是给 iMessage 看的
 * （等宽对齐、一行一句），塞进网页只能当 `<pre>` 用，搜不了、排不了版、
 * 也没法把用法和说明分成两列。这里要的是结构化的几行，不是一坨字。
 *
 * `cmd` 是主写法，`alt` 是别的写法（别名、简写、带参数的形式），
 * `desc` 是一句人话。`group` 决定在表里分到哪一段。
 */

/**
 * 暗号的兜底写法，只在配置还没从后端拉回来的那一瞬间派得上用场。
 * 正主是 server/src/config.js 里的 DEFAULT_PRIVACY_TRIGGER，改那边记得改这边。
 */
export const DEFAULT_PRIVACY_TRIGGER = "/防相亲";

/** 表格分段。顺序就是画出来的顺序。 */
export const COMMAND_GROUPS = [
  { key: "context", label: "上下文" },
  { key: "model", label: "模型" },
  { key: "make", label: "生成" },
  { key: "offline", label: "线下模式" },
  { key: "reminder", label: "提醒" },
  { key: "system", label: "系统" },
];

export const COMMAND_ROWS = [
  {
    group: "context",
    cmd: "/clear 1",
    alt: ["/clear1", "/clear[1]"],
    desc: "清除最近 1 轮对话。不带数字按 1 轮算。",
  },
  {
    group: "context",
    cmd: "/del",
    alt: [],
    desc: "清空当前对话的全部上下文。",
  },
  {
    group: "model",
    cmd: "/provider",
    alt: [],
    desc: "列出所有服务商源，标出当前用的那个。",
  },
  {
    group: "model",
    cmd: "/provider1",
    alt: [],
    desc: "切到第 1 个服务商源。模型从它已开启的 LLM 里随机挑一个。",
  },
  {
    group: "model",
    cmd: "/model",
    alt: [],
    desc: "列出当前服务商下的模型，标出当前用的那个。",
  },
  {
    group: "model",
    cmd: "/model1",
    alt: [],
    desc: "切到第 1 个模型。",
  },
  {
    group: "make",
    cmd: "/image 描述",
    alt: ["/image 小猫 描述", "/image[小猫] 描述"],
    desc: "直接出一张图，不经过 AI、也不进上下文。带参考图名字就是图生图；名字里有空格用方括号框住。",
  },
  {
    group: "make",
    cmd: "/memory",
    alt: ["/记忆"],
    desc: "立刻把攒着的聊天记录总结成一条记忆。",
  },
  {
    group: "make",
    cmd: "/diary",
    alt: ["/日记"],
    desc: "立刻写一篇日记。",
  },
  {
    group: "make",
    cmd: "/重roll",
    alt: ["/reroll"],
    desc: "对刚才那条回复不满意，重新生成一次。",
  },
  {
    group: "make",
    cmd: "/立即触发评论",
    alt: ["/igtick"],
    desc: "Instagram 排着的赞和评论不用再等，全部立刻跑完。",
  },
  {
    group: "system",
    cmd: "/提示词协助模式",
    alt: ["/promptmode"],
    desc: "角色让位，换一个提示词工程师帮你排查人设/世界书/预设。这期间不会有任何角色扮演，说的话也不进角色的上下文。",
  },
  {
    group: "system",
    cmd: "/提示词协助模式关闭",
    alt: ["/promptmodeoff"],
    desc: "结束协助，这期间的对话一并丢掉，回到正常聊天。",
  },
  {
    group: "offline",
    cmd: "/开启线下",
    alt: ["/offlineon"],
    desc: "开始演一段线下剧情。开着的时候这个角色的线上功能全部停用（主动消息、消息格式与功能都不生效）。演的是和网页「线下模式」分区同一段剧情，手机上开的头能在网页里接着演。",
  },
  {
    group: "offline",
    cmd: "/小总结",
    alt: ["/sumsmall"],
    desc: "立刻把还没总结过的那几轮剧情概括成一份小总结，不用等轮数攒够。",
  },
  {
    group: "offline",
    cmd: "/大总结",
    alt: ["/sumbig"],
    desc: "立刻把攒着的几份小总结合并成一份大总结。",
  },
  {
    group: "offline",
    cmd: "/关闭线下",
    alt: ["/offlineoff"],
    desc: "结束这段剧情：先立刻回归线上功能，再补一次大总结、把小/大总结写进这个角色的待总结（记忆库）。那两份总结要打模型，可能要等几分钟，但线下已经关了。",
  },
  {
    group: "make",
    cmd: "/小剧场 1",
    alt: ["/生成小剧场 同人小剧场"],
    desc: "按模板编号或标题生成一个小剧场。先回一句「开始生成」，好了再发一条；完整页面在网页的「小剧场」里看。",
  },
  {
    group: "make",
    cmd: "/临时小剧场 提示词",
    alt: [],
    desc: "用这次写的提示词直接生成，不进模板目录。{{char}} / {{user}} 会换成名字。",
  },
  {
    group: "make",
    cmd: "/生成随机小剧场",
    alt: [],
    desc: "从模板目录里随机挑一个生成。",
  },
  {
    group: "make",
    cmd: "/小剧场 重试",
    alt: [],
    desc: "用这个角色上一次小剧场的设定（模板、人设、世界书）重新生成一次。",
  },
  {
    group: "make",
    cmd: "/小剧场目录",
    alt: [],
    desc: "列出模板目录和编号。编号跟着模板顺序走，删了中间的后面会往前挪。",
  },
  {
    group: "make",
    cmd: "/查看小剧场 1",
    alt: [],
    desc: "看某个模板的标题和提示词（不是生成好的成品）。",
  },
  {
    group: "make",
    cmd: "/查手机",
    alt: ["/checkphone"],
    desc: "偷看一眼角色的手机：按「查手机 → 设置」里勾的那几个 App 生成一批，结果发回来一条。要先在「查手机」里给这个角色打开这条指令。",
  },
  {
    group: "reminder",
    cmd: "/提醒 明天8:00 带钥匙",
    alt: ["/增加提醒", "/提醒 每天 7:30 吃药", "/提醒 每周一三 8:00 高数", "/提醒 每月15号 9:00 交房租"],
    desc: "加一条自己的提醒，到点由这个角色按人设来提醒你。开头可写 每天 / 每周几 / 每月几号 / 每年；末尾可加「提前30分钟」或「准时」，不写就用「提醒」里的默认提前量。",
  },
  {
    group: "reminder",
    cmd: "/增加纪念日 在一起 2025年10月10日",
    alt: [],
    desc: "每年这天写进时间感知（「周五 · 在一起第一年纪念日」），满 100、200… 天也会告诉角色，当天早上 9 点角色会来找你。要写全年份。",
  },
  {
    group: "reminder",
    cmd: "/增加生日 宝宝 10月10日",
    alt: ["/增加生日 宝宝 农历八月十五"],
    desc: "生日当天写进时间感知，早上 9 点角色会来找你。农历就在日期前面写「农历」。",
  },
  {
    group: "reminder",
    cmd: "/提醒列表",
    alt: ["/删除提醒 2"],
    desc: "看还没到点的提醒和日程（带编号）；/删除提醒 加编号删掉一条。网页端在侧边栏「提醒」里。",
  },
  {
    group: "system",
    cmd: "/重启",
    alt: ["/restart"],
    desc: "重启整个服务。",
  },
  {
    /*
     * 这一行的 cmd 是**用户自己设的暗号**，不是写死的字符串 ——
     * 表里其余几条都是常量，只有它要从配置里现读（见 commands.jsx）。
     */
    group: "system",
    key: "privacy",
    cmd: null,
    alt: [],
    desc: "开关防相亲。开着的时候系统发言一条都不发出来（指令确认、报错、记忆和日记的总结）。这个词带不带 / 都认。",
  },
  {
    group: "system",
    cmd: "/help",
    alt: [],
    desc: "在 iMessage 里把这张表发一遍。",
  },
];

/**
 * 后端认得的全部命令词 —— server/src/commands.js 里 COMMANDS + COMMAND_ALIASES
 * 那两张表拼起来。只给下面那个撞车检查用。
 */
const COMMAND_WORDS = new Set([
  "clear",
  "del",
  "provider",
  "model",
  "help",
  "image",
  "memory",
  "diary",
  "reroll",
  "restart",
  "igtick",
  "promptmode",
  "promptmodeoff",
  "offlineon",
  "offlineoff",
  "sumsmall",
  "sumbig",
  "checkphone",
  "theater",
  "theatertemp",
  "theaterrandom",
  "theaterlist",
  "theaterview",
  "remind",
  "remindlist",
  "reminddel",
  "addanniv",
  "addbday",
  "日记",
  "记忆",
  "重roll",
  "重启",
  "立即触发评论",
  "提示词协助模式",
  "提示词协助模式关闭",
  "开启线下",
  "关闭线下",
  "小总结",
  "大总结",
  "查手机",
  "生成小剧场",
  "小剧场",
  "临时小剧场",
  "生成随机小剧场",
  "小剧场目录",
  "查看小剧场",
  "提醒",
  "增加提醒",
  "提醒列表",
  "删除提醒",
  "增加纪念日",
  "增加生日",
]);

/**
 * 暗号会不会被真指令吃掉；撞上了返回那个命令词，没撞返回空串。
 *
 * 后端 tryCommand 是**先**认真指令、认不出来才比对暗号的，所以撞车时真指令赢。
 * 也就是说暗号设成 `del` 的后果不是「/del 从此变成一个开关」，而是这条暗号
 * 再也不会触发 —— 一个静悄悄不生效的防相亲比任何报错都糟，所以在网页上
 * 提前说一声。（顺带一提，那个优先级是有意的：一个手滑就把上下文清空的
 * 暗号，代价比认不出暗号大得多。）
 *
 * 判断比后端宽松，宁可多提醒一次：把可能的数字参数削掉再查表。
 */
export function commandCollision(trigger) {
  let s = String(trigger ?? "").trim().toLowerCase();
  // 中文输入法打出来的是全角斜杠，后端 normalize 会换成半角，这里一并认
  if (s.startsWith("/") || s.startsWith("／")) s = s.slice(1);
  // `/clear1`、`/clear 1`、`/clear[1]` 和 `/clear` 是同一条指令
  const word = s.trim().replace(/[\s[(（]*\d+[\])）]*$/, "").trim();
  // /image 后面跟的是自由文本，整段都算参数，所以只看第一个词
  if (word.split(/\s+/)[0] === "image") return "image";
  return COMMAND_WORDS.has(word) ? word : "";
}
