/**
 * 快拍播放器。
 *
 * 手机版：整屏黑底、图片信箱式居中、底部「发消息 + 爱心 + 纸飞机」。
 * 电脑版：深灰底、中间一张 9:16 卡片、两侧翻页箭头、左上角字标 + 右上角大 ×。
 *
 * 自己的快拍底栏不一样：动态 / 精选 / 提及 / 发送 / 更多 —— 其中**精选**是
 * 「把这条存进自己主页的精选」那个入口。角色的快拍这里只能看和回，右上角那个
 * 三点整个不出现：存进**角色**的精选、删**角色**的快拍都是上帝视角的活，在
 * Uranus 控制台的 Instagram 分区里做（真 IG 上你本来也删不掉别人的快拍）。
 *
 * 自动播放：每条 5 秒，进度条动画填充。点左右半屏翻页，Esc / × 关掉。
 *
 * ── 什么时候暂停 ──
 *
 * 光标进了回复框（`typing`）、指针停在底下那摞回复上（`hover`）、菜单开着、
 * 输入框里有字，这四种任意一种都停。**光标进框就停**这条是补的 bug：以前只看
 * 「输入框里有没有字」，于是看完一条快拍再去点输入框，5 秒早就到了、播放器
 * 自己关掉了 —— 用户的原话是「快拍发不了评论」，症状就是这个。
 * 长按暂停还是没做（那要 pointer 事件配合定时器暂停恢复，值不回来）。
 *
 * ── 回复为什么全摊开给人看 ──
 *
 * 真 IG 上快拍回复是私信，别人看不见。这儿故意反着来：谁回的都列出来，
 * 角色 A 回角色 B 的快拍也列。这个面板本来就是上帝视角（角色的快拍能在控制台
 * 里删、能存进它的精选），而「角色之间在互相说什么」正是用户要看的东西 ——
 * 藏起来的话，`[story:]` 这条线上发生的所有事都只剩一张图。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  MoreHorizontal,
  Send,
  Sparkles,
  X,
} from "lucide-react";

import { Avatar, Sheet, igMediaUrl, timeAgo } from "./parts.jsx";

/** 一条快拍放多久（毫秒）。IG 的图片快拍是 5 秒。 */
const DURATION = 5000;
/** 进度条刷新间隔。60ms 够顺，又不至于每帧都 setState。 */
const TICK = 60;
/** 底下最多摊开几条回复，再多就折起来只报个数。 */
const MAX_REPLIES = 4;
/** 用户在 IG 这套数据里的 owner（服务端 igstore 的 USER_OWNER）。 */
const SELF = "user";

export default function Story({
  owner,
  head,
  stories = [],
  start = 0,
  view,
  isSelf,
  onClose,
  onNext,
  onSaveHighlight,
  onDelete,
  onReply,
  onLike,
}) {
  const [index, setIndex] = useState(start);
  const [elapsed, setElapsed] = useState(0);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState("");
  // 光标在回复框里
  const [typing, setTyping] = useState(false);
  // 指针停在底下那摞回复上（读别人说了什么的时候别翻页）
  const [reading, setReading] = useState(false);
  // 四种情况都暂停，理由见文件头那段
  const paused = menu || typing || reading || Boolean(draft);
  const desktop = view === "desktop";
  const story = stories[index];

  const go = useCallback(
    (delta) => {
      setElapsed(0);
      setIndex((i) => {
        const next = i + delta;
        if (next < 0) return 0;
        // 放完最后一条：交给上层决定是关掉还是跳到下一个人
        if (next >= stories.length) {
          onNext?.();
          return i;
        }
        return next;
      });
    },
    [stories.length, onNext]
  );

  /* 自动播放。paused 时不推进 —— 定时器照跑但不加时间，省掉一次 clear/set */
  useEffect(() => {
    if (!story) return undefined;
    const timer = setInterval(() => {
      if (paused) return;
      setElapsed((e) => {
        if (e + TICK >= DURATION) {
          go(1);
          return 0;
        }
        return e + TICK;
      });
    }, TICK);
    return () => clearInterval(timer);
  }, [story, paused, go]);

  /* Esc 关掉、左右方向键翻页 */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, go]);

  if (!story) return null;
  const url = igMediaUrl(story.image?.file);

  /*
   * 底下那摞：谁赞过、谁回了什么。
   *
   * 只留最近 MAX_REPLIES 条 —— 一条快拍活 24 小时，几个角色刷下来能攒十几条，
   * 全铺开会把画面盖掉。上面那行「前面还有 N 条」说清楚被折了多少。
   */
  const replies = story.replies ?? [];
  const shown = replies.slice(-MAX_REPLIES);
  const folded = replies.length - shown.length;
  const likes = story.likes ?? [];
  const likedByMe = likes.includes(SELF);
  const likeLine = likes.map((who) => (who === SELF ? "你" : who)).join("、");

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onReply?.(story.id, text);
  };

  return (
    <div className="ig-story" data-view={desktop ? "desktop" : "mobile"}>
      {desktop ? (
        <>
          <span className="ig-story-brand">Instagram</span>
          <button
            type="button"
            className="ig-story-close ig-icon-btn"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={28} color="#fff" />
          </button>
          {index > 0 ? (
            <button
              type="button"
              className="ig-story-arrow"
              data-side="left"
              onClick={() => go(-1)}
              aria-label="上一条"
            >
              <ChevronLeft size={22} />
            </button>
          ) : null}
          {index < stories.length - 1 ? (
            <button
              type="button"
              className="ig-story-arrow"
              data-side="right"
              onClick={() => go(1)}
              aria-label="下一条"
            >
              <ChevronRight size={22} />
            </button>
          ) : null}
        </>
      ) : null}

      <div className="ig-story-card">
        {/* 进度条：看过的填满、当前的按 elapsed 填、没看的空着 */}
        <div className="ig-story-bars">
          {stories.map((s, i) => (
            <i key={s.id}>
              <em
                style={{
                  "--fill":
                    i < index ? "100%" : i === index ? `${(elapsed / DURATION) * 100}%` : "0%",
                }}
              />
            </i>
          ))}
        </div>

        <div className="ig-story-top">
          <Avatar avatar={head?.avatar} name={head?.displayName} size={32} />
          <span className="ig-story-who">
            {isSelf ? "你的快拍" : head?.username || owner}
          </span>
          <span className="ig-story-age">{timeAgo(story.createdAt, true)}</span>
          <span style={{ flex: 1 }} />
          {/* 三点只对自己的快拍给 —— 底下那两条（存精选、删掉）都只对自己成立 */}
          {isSelf ? (
            <button
              type="button"
              className="ig-icon-btn"
              onClick={() => setMenu(true)}
              aria-label="更多"
              style={{ color: "#fff" }}
            >
              <MoreHorizontal size={22} />
            </button>
          ) : null}
          {!desktop ? (
            <button
              type="button"
              className="ig-icon-btn"
              onClick={onClose}
              aria-label="关闭"
              style={{ color: "#fff" }}
            >
              <X size={22} />
            </button>
          ) : null}
        </div>

        {/* 点左右半屏翻页。图片本身在下面一层，这层只接点击 */}
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="上一条"
          style={{ position: "absolute", inset: "56px 50% 76px 0", zIndex: 2 }}
        />
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="下一条"
          style={{ position: "absolute", inset: "56px 0 76px 50%", zIndex: 2 }}
        />

        <div className="ig-story-media">
          {url ? (
            <img src={url} alt={story.image?.alt || ""} />
          ) : (
            /* 生图关着时把描述当画面显示 —— 和帖子那边一个规则 */
            <div
              style={{
                padding: 32,
                color: "#fff",
                textAlign: "center",
                fontSize: 17,
                lineHeight: "26px",
              }}
            >
              {story.image?.alt || story.caption || "（没有内容）"}
            </div>
          )}
        </div>

        {/*
          * 配文和回复摞在一起，整体压在底栏上面。
          *
          * z-index 3 在翻页那两块透明按钮（2）之上 —— 不然点回复、滚回复都会
          * 被当成「点了半屏」翻到下一条。指针进来就暂停，读完再走。
          */}
        {story.caption || replies.length || likes.length ? (
          <div
            className="ig-story-bottom"
            onPointerEnter={() => setReading(true)}
            onPointerLeave={() => setReading(false)}
          >
            {story.caption ? <div className="ig-story-caption">{story.caption}</div> : null}

            {likes.length ? (
              <div className="ig-story-likes">
                <Heart size={13} fill="currentColor" />
                <span>{likeLine} 赞过</span>
              </div>
            ) : null}

            {folded > 0 ? (
              <div className="ig-story-folded">…前面还有 {folded} 条</div>
            ) : null}

            {shown.map((r) => (
              <div className="ig-story-reply" key={r.id}>
                <Avatar name={r.owner === SELF ? "你" : r.owner} size={24} />
                <span>
                  <b>{r.owner === SELF ? "你" : r.owner}</b>：{r.text}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {isSelf ? (
          /* 自己的快拍底栏。「精选」是存进自己主页那个入口 */
          <div className="ig-story-own">
            <button type="button" disabled aria-label="动态（暂不可用）">
              <Send size={20} />
              动态
            </button>
            <button type="button" onClick={() => onSaveHighlight?.(story.id)}>
              <Sparkles size={20} />
              精选
            </button>
            <button type="button" disabled aria-label="提及（暂不可用）">
              <Heart size={20} />
              提及
            </button>
            <button type="button" disabled aria-label="发送（暂不可用）">
              <Send size={20} />
              发送
            </button>
            <button type="button" onClick={() => setMenu(true)}>
              <MoreHorizontal size={20} />
              更多
            </button>
          </div>
        ) : (
          <div className="ig-story-foot">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              placeholder="发消息…"
              aria-label="回复这条快拍"
            />
            <button
              type="button"
              className="ig-icon-btn"
              onClick={() => onLike?.(story.id)}
              aria-label={likedByMe ? "取消赞" : "赞"}
            >
              <Heart
                size={24}
                color={likedByMe ? "#ff3040" : "currentColor"}
                fill={likedByMe ? "#ff3040" : "none"}
              />
            </button>
            <button
              type="button"
              className="ig-icon-btn"
              onClick={send}
              aria-label="发送"
              disabled={!draft.trim()}
            >
              <Send size={24} />
            </button>
          </div>
        )}
      </div>

      {menu ? (
        <Sheet
          onClose={() => setMenu(false)}
          items={[
            /* 底栏那个「精选」通到同一处，这里只是多给一个位置（IG 两处都有） */
            { label: "保存到我的主页（精选）", onClick: () => onSaveHighlight?.(story.id) },
            { label: "删除这条快拍", danger: true, onClick: () => onDelete?.(story.id) },
          ]}
        />
      ) : null}
    </div>
  );
}
