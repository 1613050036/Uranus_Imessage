/**
 * 离线自测：通话里那几个标记的解析（calltags.js）+ 通话会话（callsession.js）。
 *
 * 这两摊都是纯的 —— 不读配置、不打网络，所以这里一行假数据都不用造。
 *
 * 为什么这块非测不可：**漏剥一个标记，用户听到的就是角色一本正经地念出
 * 「transfer 冒号 4000 冒号 零花钱」**。而且通话里不拆气泡，模型写惯了的那个
 * `$` 会被念成「美元」。这类错不会报任何异常，只会在真打电话的时候很出戏。
 *
 * 跑：node scripts/test-calltags.mjs
 */

import {
  ANSWER,
  callPrefix,
  findFaceTimeLink,
  interruptedNotice,
  inviteNotice,
  isFaceTimeInvite,
  readAnswer,
  readHangUp,
  speakableFrom,
  silenceNotice,
  splitSentences,
  stripCallTags,
  stripSeparator,
  typedPrefix,
} from "../server/src/calltags.js";
import {
  callStatus,
  endCall,
  getCall,
  inCall,
  markConnected,
  primeGreeting,
  recordCallTurn,
  resetForTest,
  sayDuration,
  startCall,
  takeGreeting,
} from "../server/src/callsession.js";
import { splitMedia } from "../server/src/media.js";

let pass = 0;
let fail = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${what}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${what}\n      得到：${JSON.stringify(got)}\n      应该：${JSON.stringify(want)}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

// ───────────────────────────────── 认链接

group("从消息里认出 FaceTime 链接");
{
  const real =
    "https://facetime.apple.com/join#v=1&p=xUuJ6sYZEfGa1dJP+JYAYQ&k=tfn0uqnPOr01xXCCOggyjzU_YHCfn64nXYxTTXRmY5A";
  check("实测那条收到的链接", findFaceTimeLink(real), real);
  check("夹在文字里也认得", findFaceTimeLink(`给你打电话 ${real} 快接`), real);
  check("isFaceTimeInvite", isFaceTimeInvite(real), true);

  check("普通消息", findFaceTimeLink("在干嘛"), "");
  check("别的链接", findFaceTimeLink("https://www.bilibili.com/video/BV1"), "");
  check("只提到名字不算", findFaceTimeLink("我们 facetime 一下"), "");

  // 密钥在 # 后面，少了它是一条进不去的链接 —— 挡在这儿，别白开一次浏览器
  check("没有井号片段的不算", findFaceTimeLink("https://facetime.apple.com/join"), "");
  check("片段里没有 k= 的不算", findFaceTimeLink("https://facetime.apple.com/join#v=1&p=abc"), "");

  // 句末标点不能跟着进链接
  check(
    "句末的句号剔掉",
    findFaceTimeLink(`${real}。`),
    real
  );
}

group("给模型的那几句话");
{
  /*
   * 邀请这条分两行，**第一行是用户钉死的措辞**，一个字都不能动 ——
   * 所以这里单独钉第一行，而不是整段。第二行（让它顺便把开场白写了）
   * 是后加的，措辞可以调，但那两个标记名得在里面。
   */
  const invite = inviteNotice("ming");
  check(
    "邀请的第一行（用户钉死的措辞）",
    invite.split("\n")[0],
    "[ming向你发起Facetime通话邀请，回复[接受通话]即可进入通话，[拒绝通话]则会拒绝，请按照人设来进行回应，不要ooc]"
  );
  check("邀请里让它顺便写开场白", /第一句话/.test(invite), true);
  check("并且说清了那句话不发短信", /不会以短信发出/.test(invite), true);
  check("通话中的时间戳", callPrefix("3 分 12 秒"), "[Facetime已接通 3 分 12 秒]");
  check("打字发来的", typedPrefix("ming"), "[ming在imessage发来的信息]");
  check(
    "好久没说话",
    silenceNotice(45, "ming"),
    "[ming已经45秒没有说话了，可能是关闭了麦克风，请根据人设以及上下文作出回应]"
  );
  check(
    "被打断（说出口了几句）",
    interruptedNotice(["喂？", "听得到吗"], 2, "ming"),
    "[ming插话打断了你，对方只听到了你说的「喂？听得到吗」，后面2句没说出口]"
  );
  check(
    "被打断（一句都没说出口）",
    interruptedNotice([], 3, "ming"),
    "[ming插话打断了你，对方还没听到你说的话，后面3句没说出口]"
  );
}

// ───────────────────────────────── 接听判定

group("角色接不接这通电话");
{
  check("接", readAnswer("[接受通话]").answer, ANSWER.accept);
  check("拒", readAnswer("[拒绝通话]").answer, ANSWER.reject);
  check("什么都没说", readAnswer("喂？").answer, ANSWER.none);
  check("标记里有空格也认", readAnswer("[ 接受通话 ]").answer, ANSWER.accept);

  // 模型偶尔会把两个选项都复述一遍，按「接」处理
  check(
    "两个都写了算接",
    readAnswer("要么[接受通话]要么[拒绝通话]").answer,
    ANSWER.accept
  );

  check("正文里的标记被剥掉", readAnswer("[接受通话]\n\n喂？等我一下").text, "喂？等我一下");
  check("拒绝时正文照样留着", readAnswer("[拒绝通话]现在在开车，等会儿打给你").text, "现在在开车，等会儿打给你");
}

group("角色主动挂断");
{
  check("认得出来", readHangUp("那就这样，拜拜[结束通话]").hangUp, true);
  check("没写就是不挂", readHangUp("还有一件事").hangUp, false);
  check("正文留下来了", readHangUp("拜拜[结束通话]").text, "拜拜");
}

group("剥标记时顺手收拾空行");
{
  // 剥完留下一堆换行的话，送进 TTS 会多出一段莫名的停顿
  check("夹在中间的", stripCallTags("好啊\n\n[结束通话]\n\n"), "好啊");
  check("连续空行压成一个", stripCallTags("一\n\n\n\n[结束通话]二"), "一\n\n二");
}

// ───────────────────────────────── 气泡分隔符

group("那个 $ 不能念出来");
{
  check("夹在句子之间", stripSeparator("今天好累$你呢"), "今天好累 你呢");
  check("两边有空格", stripSeparator("嗯 $ 然后呢"), "嗯 然后呢");
  check("好几个", stripSeparator("一$二$三"), "一 二 三");
  check("行尾", stripSeparator("说完了$"), "说完了");

  // 真要说钱的时候那个 $ 紧贴着数字，不该动
  check("花了多少钱不能动", stripSeparator("这个要 $20"), "这个要 $20");
  check("$5 也不能动", stripSeparator("才 $5 而已"), "才 $5 而已");

  check("换成别的分隔符也行", stripSeparator("一|二", "|"), "一 二");
  check("没配分隔符就原样", stripSeparator("一$二", ""), "一$二");
}

// ───────────────────────────────── 哪些字该念

group("功能保留，但不念出来");
{
  // splitMedia 是 media.js 的现成函数，通话这边复用它来挑出纯文本
  const reply = "我给你转点钱[transfer:4000:零花钱]你拿去买吧";
  const parts = splitMedia(reply);
  check("切出了三块", parts.map((p) => p.kind), ["text", "transfer", "text"]);
  check("只念文字那部分", speakableFrom(parts), "我给你转点钱 你拿去买吧");
}
{
  const reply = "听这个[audio_message:好听吧]";
  check("语音条标记不念", speakableFrom(splitMedia(reply)), "听这个");
}
{
  const reply = "[接受通话]喂？$听得到吗";
  check(
    "通话标记和分隔符一起剥",
    speakableFrom(splitMedia(reply)),
    "喂？ 听得到吗"
  );
}
{
  check("一个字都不剩时返回空串", speakableFrom(splitMedia("[结束通话]")), "");
}

// ───────────────────────────────── 切句

group("按句切开，一句一句合成");
{
  const out = splitSentences("喂？听得到吗。我这边信号不太好，你那边怎么样。");
  check("第一句单独切出来（它决定多久能听到声音）", out[0], "喂？");
  check("切成了几段", out.length >= 2, true);
}
{
  // 第一句刻意短，后面的攒够字数再切
  const out = splitSentences("嗯。今天真的累死了，从早上开始就一直在开会，一个接一个。");
  check("第一句是「嗯。」", out[0], "嗯。");
}
{
  const out = splitSentences("");
  check("空文本切出空数组", out, []);
}
{
  const out = splitSentences("没有标点的一句话");
  check("没标点也要出一段", out, ["没有标点的一句话"]);
}
{
  // TTS 有长度上限（media.js:88 MAX_TTS_CHARS = 1000），太长要硬切
  const long = "啊".repeat(500);
  const out = splitSentences(long, { maxChars: 180 });
  check("太长的被硬切开", out.length, 3);
  check("每段都不超上限", out.every((s) => s.length <= 180), true);
}
{
  const out = splitSentences("问号也算句末？那当然。");
  check("问号后面切", out[0], "问号也算句末？");
}

// ───────────────────────────────── 时长

group("把毫秒说成人话");
{
  check("不到一分钟", sayDuration(59_400), "59 秒");
  check("超过一分钟", sayDuration(192_000), "3 分 12 秒");
  check("刚好一分钟", sayDuration(60_000), "1 分 0 秒");
  check("零", sayDuration(0), "0 秒");
  // 不兜住的话模型会收到「[Facetime已接通 NaN 秒]」
  check("脏数据不会说出奇怪的话", sayDuration(NaN), "0 秒");
  check("负数也兜住", sayDuration(-5000), "0 秒");
}

// ───────────────────────────────── 通话会话

group("一次只能一通");
{
  resetForTest();
  check("一开始没人在打", getCall(), null);
  check("inCall 也是 false", inCall(), false);

  const c = startCall({
    roleId: "r1",
    roleName: "Ken",
    sessionId: "s1",
    peer: "+8613800138000",
    spaceId: "chat1",
    link: "https://facetime.apple.com/join#x",
  });
  check("起起来了", c.state, "connecting");
  check("还没接通，inCall 是 false", inCall(), false);

  let threw = "";
  try {
    startCall({ roleId: "r2", roleName: "别人", sessionId: "s2", peer: "x", spaceId: "y", link: "z" });
  } catch (e) {
    threw = e.message;
  }
  check("第二通被挡住", threw, "已经有一通电话在进行中了");

  markConnected();
  check("接通之后 inCall 是 true", inCall(), true);

  recordCallTurn("喂？", "嗯，我在");
  recordCallTurn("在干嘛", "刚下班");
  check("记了两轮", getCall().turns, 2);
  check("原文留着", getCall().log.length, 2);

  const ended = endCall("对方挂断");
  check("挂了之后拿得到最终状态", ended.turns, 2);
  check("原因记着", ended.reason, "对方挂断");
  check("挂了之后就没人在打了", getCall(), null);
  check("可以再起一通", startCall({ roleId: "r3", roleName: "C", sessionId: "s", peer: "p", spaceId: "sp", link: "l" }).state, "connecting");
  resetForTest();
}

group("给控制台看的那份状态");
{
  resetForTest();
  check("没通话时", callStatus(), { active: false });

  startCall({
    roleId: "r1",
    roleName: "Ken",
    sessionId: "s1",
    peer: "+8613800138000",
    spaceId: "chat1",
    link: "https://facetime.apple.com/join#v=1&p=secret&k=secret",
  });
  markConnected();
  const st = callStatus();
  check("active", st.active, true);
  check("带着角色名", st.roleName, "Ken");
  check("带着轮数", st.turns, 0);
  // 链接等于一把能加入通话的钥匙，不该摆在接口里
  check("不含链接", "link" in st, false);
  resetForTest();
}
// ───────────────────────────────── 通话预设

group("通话预设这条链路");
{
  const { defaultEntries, normalizePreset, presetsFor, resolvePreset } = await import(
    "../server/src/preset.js"
  );
  const { normalizeConfig } = await import("../server/src/config.js");
  const { buildPrompt } = await import("../server/src/prompt.js");

  const entries = defaultEntries("call");
  check(
    "固定条目的顺序（callHowto 在 format 后面）",
    entries.map((e) => e.kind),
    ["char", "user", "world", "format", "callHowto", "context", "memory"]
  );
  // format 在通话里要开着 —— 那些功能是保留的，只是不念出来
  check("format 默认开着", entries.find((e) => e.kind === "format").enabled, true);

  /*
   * 通话默认预设的「消息格式与功能」（用户定的）：
   *  - 引言清空 —— 那两句是发短信的说法（「你在用 iMessage 聊天」「用 {{sep}} 分气泡」）
   *  - 这几条默认关：语音、联网搜索、已读不回、引用回复、撤回、特效、IG、小红书、查岗四条
   * 只是默认数据，关着的子条目 formatBlock 本来就不注入。
   */
  const fmt = entries.find((e) => e.kind === "format");
  check("通话预设的引言是空的", fmt.content, "");
  check(
    "默认关掉的子条目",
    fmt.children.filter((c) => !c.enabled).map((c) => c.kind),
    [
      "voice",
      "search",
      "leaveOnRead",
      "quote",
      "undoSend",
      "effect",
      "instagram",
      "xiaohongshu",
      "spyScreen",
      "spyView",
      "spyControl",
      "spyMusic",
    ]
  );
  check(
    "「那些功能照样能用」那一节删掉了",
    /那些功能/.test(entries.find((e) => e.kind === "callHowto").content),
    false
  );
  // 线上预设不受影响
  check(
    "线上预设的引言还在",
    Boolean(defaultEntries("online").find((e) => e.kind === "format").content),
    true
  );

  // 归一化不能把默认正文吃掉（漏了这一支的话，整段提示词会静默消失）
  const norm = normalizePreset({ mode: "call", name: "x", entries }, "p1");
  check(
    "归一化之后 callHowto 还带着正文",
    Boolean(norm.entries.find((e) => e.kind === "callHowto")?.content),
    true
  );

  const config = normalizeConfig({
    presets: [
      { id: "p-online", name: "线上", mode: "online", entries: defaultEntries("online") },
      { id: "p-call", name: "我的通话预设", mode: "call", entries },
    ],
    roles: [
      { id: "r1", name: "Ken", presetRef: "p-online", call: { enabled: true, presetRef: "p-call" } },
    ],
    users: [{ id: "u1", name: "ming" }],
  });
  const role = config.roles[0];

  // presetsFor 原来写的是「不是 offline 就算 online」，call 一份都筛不出来
  check("presetsFor 筛得出通话预设", presetsFor(config, "call").map((p) => p.id), ["p-call"]);
  check("通话模式解析到角色挑的那份", resolvePreset(config, role, "call").name, "我的通话预设");
  check("线上模式不受影响", resolvePreset(config, role, "online").name, "线上");

  const built = await buildPrompt(config, role, config.users[0], [{ role: "user", content: "喂？" }], "", {
    mode: "call",
  });
  const sys = built.messages.map((m) => m.content).join("\n");
  check("提示词里有通话那一段", sys.includes("<Phone_Call>"), true);
  check("里面有「别写括号动作」", sys.includes("括号里的动作"), true);
  check("里面有「别写分隔符」", sys.includes("分隔符"), true);
  check("变量替换过了", sys.includes("{{char}}"), false);

  // 用户改过的正文不能被默认值盖掉
  const edited = normalizeConfig({
    ...config,
    presets: [
      config.presets[0],
      {
        ...config.presets[1],
        entries: config.presets[1].entries.map((e) =>
          e.kind === "callHowto" ? { ...e, content: "我自己写的" } : e
        ),
      },
    ],
  });
  const b2 = await buildPrompt(edited, role, edited.users[0], [{ role: "user", content: "喂" }], "", {
    mode: "call",
  });
  const s2 = b2.messages.map((m) => m.content).join("\n");
  check("用户改过的正文留着", s2.includes("我自己写的"), true);
  check("默认正文没被塞回来", s2.includes("括号里的动作"), false);

  // 发短信那条路不该被污染
  const b3 = await buildPrompt(config, role, config.users[0], [{ role: "user", content: "在吗" }], "");
  check("线上提示词里没有通话那段", b3.messages.map((m) => m.content).join().includes("Phone_Call"), false);
}

group("开场白：接的那一轮就写好，接通时直接念");
{
  resetForTest();
  startCall({
    roleId: "r",
    roleName: "Ken",
    sessionId: "s",
    peer: "+1",
    spaceId: "sp",
    link: "x",
    greeting: "喂？怎么了。",
  });
  check("存下来了", getCall().greeting, "喂？怎么了。");
  check("取出来", takeGreeting().text, "喂？怎么了。");
  /*
   * 一次性 —— 节点要是因为重连再问一次 greeting，角色不该把同一句再说一遍。
   */
  check("拿过就没了", takeGreeting().text, "");
}
{
  resetForTest();
  startCall({ roleId: "r", roleName: "C", sessionId: "s", peer: "+1", spaceId: "sp", link: "x" });
  check("没带开场白时是空串", takeGreeting().text, "");
  resetForTest();
  check("压根没通话时也不炸", takeGreeting().text, "");
}
{
  // 空白被吃掉：模型写 `[接受通话]\n\n` 时不该被当成「写了开场白」
  resetForTest();
  startCall({
    roleId: "r",
    roleName: "C",
    sessionId: "s",
    peer: "+1",
    spaceId: "sp",
    link: "x",
    greeting: "   \n  ",
  });
  check("只有空白等于没写", takeGreeting().text, "");
}

group("开场白的音频提前合成");
{
  // 合成在入会之前就开跑，接通时 await 已经 resolve 的那个 promise
  resetForTest();
  startCall({
    roleId: "r",
    roleName: "C",
    sessionId: "s",
    peer: "+1",
    spaceId: "sp",
    link: "x",
    greeting: "喂。",
  });
  primeGreeting(Promise.resolve([{ text: "喂。", audio: null, media: [], seq: 0 }]));
  const got = takeGreeting();
  check("文字和音频一起拿到", got.text, "喂。");
  check("音频是那几句", (await got.audio).length, 1);
  check("音频也是一次性的", takeGreeting().audio, null);
}
{
  /*
   * 合成失败**不能**把整通电话连累掉 —— primeGreeting 在 promise 上就把
   * 异常吃掉（没人 await 的 rejected promise 会打 unhandledRejection），
   * 给调用方一个 null，让它退回现场合成。
   */
  resetForTest();
  startCall({
    roleId: "r",
    roleName: "C",
    sessionId: "s",
    peer: "+1",
    spaceId: "sp",
    link: "x",
    greeting: "喂。",
  });
  primeGreeting(Promise.reject(new Error("TTS 挂了")));
  const got = takeGreeting();
  check("失败时音频是 null，不抛", await got.audio, null);
  check("文字还在（可以现场再合成一次）", got.text, "喂。");
}
{
  resetForTest();
  // 压根没通话时调用不该炸
  primeGreeting(Promise.resolve([]));
  check("没通话时 primeGreeting 是空转", getCall(), null);
}

group("开场白是从 [接受通话] 后面那段来的");
{
  /*
   * imessage.js 那边拿的就是 readAnswer 剥完标记的正文，所以这里钉死
   * 「剥完还剩什么」—— 剥多了开场白就没了，剥少了角色会念出方括号。
   */
  const a = readAnswer("[接受通话]喂？怎么突然打电话过来。");
  check("答复是接", a.answer, ANSWER.accept);
  check("剩下的正文就是开场白", a.text, "喂？怎么突然打电话过来。");

  const b = readAnswer("[接受通话]\n\n嗯？\n\n大半夜的。");
  check("中间的空行收拾干净", b.text, "嗯？\n\n大半夜的。");

  const c = readAnswer("[接受通话]");
  check("只写标记时没有开场白", c.text, "");

  const d = readAnswer("[拒绝通话]现在在开车，等会儿打给你。");
  check("拒接时正文照旧是要发的短信", d.text, "现在在开车，等会儿打给你。");
  check("拒接就是拒接", d.answer, ANSWER.reject);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
