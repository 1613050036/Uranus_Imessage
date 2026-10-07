import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../store.jsx";
import { Button, Card, Field, Modal, NumberField, ResultNote, Switch, inputCls } from "../ui.jsx";

/**
 * 侧边栏「提醒」（后端见 server/src/reminder.js、reminderapi.js）。三节：
 *  设置     —— 默认提前几分钟（0 = 只在到点说），哪些角色开着
 *  角色设的 —— 角色写 [2026年10月10日08:00 | 提醒她带钥匙] 记下的；写错的标「已失效」
 *  我的日程 —— 自己加的：一次性、课表（每周 + 单双周 + 学期起止）、生日（可农历）、纪念日
 *
 * 不在 config 里（data/reminders.json），改了立刻落盘，不用点保存。
 * 时间都按「用户那边」显示：绑了哪个角色就是那个角色的「所在城市」。
 */

const STATUS = {
  pending: { text: "待提醒", cls: "text-ink-soft" },
  done: { text: "已提醒", cls: "text-good" },
  missed: { text: "已错过", cls: "text-ink-faint" },
  invalid: { text: "已失效", cls: "text-warn" },
  cancelled: { text: "已取消", cls: "text-ink-faint" },
};

const KIND_LABEL = { once: "一次性", schedule: "日程 / 课表", birthday: "生日", anniversary: "纪念日", custom: "自定义" };
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const LUNAR_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const LUNAR_DAYS = Array.from({ length: 30 }, (_, i) => {
  const d = i + 1;
  if (d === 10) return "初十";
  if (d === 20) return "二十";
  if (d === 30) return "三十";
  return `${["初", "十", "廿"][Math.floor(d / 10)]}${"一二三四五六七八九"[(d % 10) - 1]}`;
});

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 一行状态 + 下次时间。 */
function whenLine(it) {
  // 已失效的没有一个能信的时间，原文在下一行
  if (it.status === "invalid") return "";
  if (it.status !== "pending") return it.repeat.type === "once" ? it.ruleText : `${it.ruleText}（${STATUS[it.status]?.text}）`;
  if (!it.notify) return `${it.ruleText} · 不发消息，只进时间感知`;
  if (!it.nextAt) return `${it.ruleText} · 不会再响了`;
  return it.repeat.type === "once" ? it.nextText : `${it.ruleText} · 下次 ${it.nextText}`;
}

function leadText(it) {
  if (!it.notify || it.status !== "pending") return "";
  if (it.lead === null || it.lead === undefined) return it.leadUsed ? `提前 ${it.leadUsed} 分钟（跟全局）` : "只在到点说（跟全局）";
  return it.lead ? `提前 ${it.lead} 分钟` : "只在到点说";
}

function SettingsCard({ data, onChange }) {
  const [lead, setLead] = useState(data.settings.leadMinutes);
  const [note, setNote] = useState({ state: "idle", message: "" });
  useEffect(() => setLead(data.settings.leadMinutes), [data.settings.leadMinutes]);

  async function save(body = { leadMinutes: lead }) {
    try {
      onChange(await api("/api/reminders/settings", { method: "PUT", body }));
      setNote({ state: "ok", message: "存好了" });
    } catch (e) {
      setNote({ state: "fail", message: String(e?.message ?? e) });
    }
  }

  const on = data.roles.filter((r) => r.enabled);
  return (
    <Card
      title="设置"
      desc="提醒到点时，角色会按人设来找你说一声；开了提前提醒的，提前那一下先说一次、到点再说一次。勿扰时段不挡提醒。"
    >
      <div className="grid grid-cols-1 gap-6">
        <div className="flex flex-wrap items-end gap-4">
          <NumberField
            label="默认提前"
            hint="0 = 到点才提醒。单条提醒可以自己改，角色也能在标记里写「提前30分钟」"
            value={lead}
            min={0}
            max={10080}
            step={1}
            suffix="分钟"
            onChange={setLead}
          />
          <Button variant="outline" disabled={lead === data.settings.leadMinutes} onClick={() => save()}>
            保存
          </Button>
        </div>
        <ResultNote state={note.state} message={note.message} />
        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          {on.length ? (
            <>
              开着「让角色帮你设提醒」的角色：<span className="text-ink-soft">{on.map((r) => r.name).join("、")}</span>。
            </>
          ) : (
            "还没有角色开「让角色帮你设提醒」—— 在「角色 → 单独配置 → 定时提醒」里打开。"
          )}
          生日、纪念日、节日提前几天写进时间戳（「明天万圣节」），在「角色 → 单独配置 → 时间感知」里设。
          关机期间到点的：过点半小时以内开机会补上，再早的标「已错过」。线下模式、提示词协助模式开着时先不说。
          聊天里也能直接加：/提醒 明天8:00 带钥匙、/增加纪念日 在一起 2025年10月10日、/增加生日 宝宝 农历八月十五、/提醒列表。
        </p>
      </div>
    </Card>
  );
}

/** 一条的那一行：标题、时间、谁来提醒、状态，右边是动作。 */
function ItemRow({ it, onEdit, onChange }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function act(path, opts) {
    setBusy(true);
    setErr("");
    try {
      onChange(await api(path, opts));
    } catch (e) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  const st = STATUS[it.status] ?? STATUS.pending;
  return (
    <div className="grid grid-cols-1 gap-1.5 border-b border-line py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ui text-ink">
            {it.title}
            <span className={`ml-2 text-meta ${st.cls}`}>{st.text}</span>
            {it.source === "user" && <span className="ml-2 text-meta text-ink-faint">{it.kind === "custom" && it.label ? it.label : KIND_LABEL[it.kind]}</span>}
          </p>
          <p className="mt-0.5 text-meta text-ink-faint">
            {[whenLine(it), leadText(it), it.roleName].filter(Boolean).join(" · ")}
          </p>
          {it.status === "invalid" && (
            <p className="mt-0.5 text-meta text-warn">
              {it.note}
              {it.raw ? `　原文：${it.raw}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {it.source === "user" && (
            <Switch
              checked={it.notify}
              label="到点发消息"
              onChange={(v) => act(`/api/reminders/${it.id}`, { method: "PUT", body: { notify: v } })}
            />
          )}
          {it.status === "pending" || it.source === "user" ? (
            <Button variant="ghost" disabled={busy} onClick={() => onEdit(it)}>
              <Pencil size={13} /> 改
            </Button>
          ) : null}
          {it.source === "role" && it.status === "pending" && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => act(`/api/reminders/${it.id}`, { method: "PUT", body: { status: "cancelled" } })}
            >
              取消
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            className={confirm ? "text-warn hover:text-warn" : ""}
            onClick={() => (confirm ? act(`/api/reminders/${it.id}`, { method: "DELETE" }) : setConfirm(true))}
          >
            <Trash2 size={13} /> {confirm ? "再点一次删掉" : "删除"}
          </Button>
        </div>
      </div>
      {err && <ResultNote state="fail" message={err} />}
    </div>
  );
}

function RoleItemsCard({ data, onEdit, onChange }) {
  const list = data.items
    .filter((it) => it.source === "role")
    .sort((a, b) => (a.status === "pending") - (b.status === "pending") || (a.nextAt ?? 0) - (b.nextAt ?? 0))
    .reverse();
  return (
    <Card
      title="角色设的"
      desc="角色在聊天里写 [2026年10月10日08:00 | 提醒她带钥匙] 记下的，默认一次性。写错的、时间已经过了的标「已失效」，角色下一轮会收到一句你看不到的提示让它重设。响过的留 7 天。"
    >
      {list.length ? (
        <div>{list.map((it) => <ItemRow key={it.id} it={it} onEdit={onEdit} onChange={onChange} />)}</div>
      ) : (
        <p className="text-meta text-ink-faint">还没有。跟角色说「明天提醒我上班之前带钥匙」试试。</p>
      )}
    </Card>
  );
}

function UserItemsCard({ data, onEdit, onAdd, onChange }) {
  const list = data.items
    .filter((it) => it.source === "user")
    .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  return (
    <Card
      title="我的日程"
      desc="自己定的：课表、生日、纪念日、某天要办的事。到点由选中的角色来提醒你；生日和纪念日当天还会写进时间感知的星期后面（「周六 · 在一起第一年纪念日」）。课表只提醒，不进时间感知。"
      actions={
        <Button variant="outline" onClick={onAdd}>
          <Plus size={13} /> 新增
        </Button>
      }
    >
      {list.length ? (
        <div>{list.map((it) => <ItemRow key={it.id} it={it} onEdit={onEdit} onChange={onChange} />)}</div>
      ) : (
        <p className="text-meta text-ink-faint">还没有。点右上角「新增」，或者在聊天里发 /提醒 每周一三 8:00 高数。</p>
      )}
    </Card>
  );
}

function blank(roles) {
  return {
    kind: "once",
    title: "",
    roleId: roles[0]?.id ?? "",
    date: today(),
    time: "09:00",
    repeat: { type: "once", weekdays: [], parity: "all", termStart: "", termEnd: "", lunar: false },
    lunar: { m: 8, d: 15 },
    lead: null,
    notify: true,
    milestones: true,
    label: "",
    showInTime: false,
  };
}

/** 新增 / 修改那个弹窗。角色设的只让改时间、提前量、事件。 */
function EditModal({ item, roles, onClose, onSaved }) {
  const isNew = !item.id;
  const [d, setD] = useState(() => ({
    ...item,
    time: String(item.time ?? "09:00").slice(0, item.time?.endsWith(":00") ? 5 : 8),
    lunar: item.lunar ?? { m: 8, d: 15 },
    repeat: { weekdays: [], parity: "all", termStart: "", termEnd: "", lunar: false, ...item.repeat },
  }));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const setRepeat = (patch) => setD((x) => ({ ...x, repeat: { ...x.repeat, ...patch } }));
  const roleSet = d.source === "role";

  // 换类型时把规则跟着摆好：生日纪念日每年一次，一次性就是 once
  function setKind(kind) {
    // 自定义的规则随便选，切过去时原样保留
    const type = kind === "custom" ? d.repeat.type : kind === "once" ? "once" : kind === "schedule" ? (d.repeat.type === "once" || d.repeat.type === "yearly" ? "weekly" : d.repeat.type) : "yearly";
    setD((x) => ({
      ...x,
      kind,
      repeat: { ...x.repeat, type, lunar: kind === "birthday" ? x.repeat.lunar : false },
      lead: kind === "birthday" || kind === "anniversary" ? 0 : x.lead,
    }));
  }

  async function save() {
    setBusy(true);
    setErr("");
    const body = roleSet
      ? { title: d.title, date: d.date, time: d.time, lead: d.lead }
      : {
          kind: d.kind,
          title: d.title,
          roleId: d.roleId,
          date: d.kind === "birthday" && d.repeat.lunar ? "" : d.date,
          time: d.time,
          repeat: d.repeat,
          lunar: d.kind === "birthday" && d.repeat.lunar ? d.lunar : null,
          lead: d.lead,
          notify: d.notify,
          milestones: d.milestones,
          label: d.kind === "custom" ? d.label : "",
          showInTime: d.kind === "custom" && d.showInTime,
        };
    try {
      const out = await api(isNew ? "/api/reminders" : `/api/reminders/${d.id}`, {
        method: isNew ? "POST" : "PUT",
        body,
      });
      onSaved(out);
      onClose();
    } catch (e) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const type = d.repeat.type;
  // 课表和自定义都能挑重复规则；自定义还多一个「只这一次」
  const repeating = d.kind === "schedule" || d.kind === "custom";
  const showDate =
    roleSet ||
    d.kind === "once" ||
    d.kind === "anniversary" ||
    (d.kind === "birthday" && !d.repeat.lunar) ||
    (repeating && (type === "once" || type === "monthly" || type === "yearly"));

  return (
    <Modal
      title={isNew ? "新增日程" : roleSet ? "改这条提醒" : "改日程"}
      desc={roleSet ? "角色设的提醒：能改时间、提前量和内容。" : "时间按你那边算（选中角色的「所在城市」）。"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !d.title.trim()} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        {!roleSet && (
          <Field label="类型">
            <select className={inputCls} value={d.kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label={d.kind === "birthday" ? "谁的生日" : d.kind === "anniversary" ? "纪念什么" : "提醒什么"}
          hint={
            d.kind === "birthday"
              ? "写名字，显示成「宝宝的生日」"
              : d.kind === "anniversary"
                ? "写「在一起」，显示成「在一起第一年纪念日」"
                : ""
          }
        >
          <input className={inputCls} value={d.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>

        {!roleSet && (
          <Field label="由谁来提醒" hint="生日纪念日选「所有角色」就进每个角色的时间感知">
            <select className={inputCls} value={d.roleId} onChange={(e) => set({ roleId: e.target.value })}>
              <option value="">所有角色</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {!roleSet && d.kind === "custom" && (
          <Field label="类型名称" hint="自己起，比如「吃药」「考试」「还信用卡」，列表里和提醒时都会带上">
            <input className={inputCls} value={d.label ?? ""} maxLength={20} onChange={(e) => set({ label: e.target.value })} />
          </Field>
        )}

        {!roleSet && repeating && (
          <Field label="重复">
            <select className={inputCls} value={type} onChange={(e) => setRepeat({ type: e.target.value })}>
              {d.kind === "custom" && <option value="once">只这一次</option>}
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="yearly">每年</option>
            </select>
          </Field>
        )}

        {!roleSet && repeating && type === "weekly" && (
          <>
            <Field label="每周哪几天">
              <div className="flex flex-wrap gap-2 pt-1">
                {[1, 2, 3, 4, 5, 6, 0].map((n) => {
                  const on = d.repeat.weekdays.includes(n);
                  return (
                    <Button
                      key={n}
                      variant={on ? "primary" : "outline"}
                      onClick={() =>
                        setRepeat({
                          weekdays: on ? d.repeat.weekdays.filter((x) => x !== n) : [...d.repeat.weekdays, n],
                        })
                      }
                    >
                      周{WEEK[n]}
                    </Button>
                  );
                })}
              </div>
            </Field>
            <Field label="单双周" hint="按学期开始那周算第 1 周">
              <select className={inputCls} value={d.repeat.parity} onChange={(e) => setRepeat({ parity: e.target.value })}>
                <option value="all">每周都有</option>
                <option value="odd">只在单周</option>
                <option value="even">只在双周</option>
              </select>
            </Field>
          </>
        )}

        {!roleSet && repeating && (type === "weekly" || type === "daily") && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="学期开始" hint="可不填">
              <input type="date" className={inputCls} value={d.repeat.termStart} onChange={(e) => setRepeat({ termStart: e.target.value })} />
            </Field>
            <Field label="学期结束" hint="可不填">
              <input type="date" className={inputCls} value={d.repeat.termEnd} onChange={(e) => setRepeat({ termEnd: e.target.value })} />
            </Field>
          </div>
        )}

        {!roleSet && d.kind === "birthday" && (
          <label className="flex items-center justify-between gap-4">
            <span className="text-ui text-ink">按农历过</span>
            <Switch checked={Boolean(d.repeat.lunar)} label="按农历过" onChange={(v) => setRepeat({ lunar: v })} />
          </label>
        )}

        {!roleSet && d.kind === "birthday" && d.repeat.lunar && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="农历月">
              <select className={inputCls} value={d.lunar.m} onChange={(e) => set({ lunar: { ...d.lunar, m: Number(e.target.value) } })}>
                {LUNAR_MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}月
                  </option>
                ))}
              </select>
            </Field>
            <Field label="农历日">
              <select className={inputCls} value={d.lunar.d} onChange={(e) => set({ lunar: { ...d.lunar, d: Number(e.target.value) } })}>
                {LUNAR_DAYS.map((x, i) => (
                  <option key={x} value={i + 1}>
                    {x}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          {showDate && (
            <Field
              label={
                d.kind === "anniversary"
                  ? "从哪天开始"
                  : d.kind === "birthday"
                    ? "生日（年份随便）"
                    : type === "monthly" && !roleSet
                      ? "每月几号（取这个日期的「日」）"
                      : "日期"
              }
            >
              <input type="date" className={inputCls} value={d.date} onChange={(e) => set({ date: e.target.value })} />
            </Field>
          )}
          <Field label="几点" hint={d.kind === "birthday" || d.kind === "anniversary" ? "当天几点发消息" : ""}>
            <input type="time" step="1" className={inputCls} value={d.time} onChange={(e) => set({ time: e.target.value })} />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 pb-2">
            <Switch checked={d.lead === null} label="提前量跟全局" onChange={(v) => set({ lead: v ? null : 10 })} />
            <span className="text-meta text-ink-soft">提前量跟全局</span>
          </label>
          {d.lead !== null && (
            <NumberField
              label="提前"
              hint="0 = 到点才说"
              value={d.lead}
              min={0}
              max={10080}
              step={1}
              suffix="分钟"
              onChange={(v) => set({ lead: Math.max(0, v || 0) })}
            />
          )}
        </div>

        {!roleSet && (
          <label className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">到点让角色发消息</span>
              <span className="mt-0.5 block text-meta text-ink-faint">关掉的话生日纪念日只进时间感知，不专门来找你</span>
            </span>
            <Switch checked={d.notify} label="到点让角色发消息" onChange={(v) => set({ notify: v })} />
          </label>
        )}

        {!roleSet && d.kind === "custom" && (
          <label className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">当天进时间感知</span>
              <span className="mt-0.5 block text-meta text-ink-faint">像生日纪念日那样，当天写在星期后面（「周五 · 期末考试」），角色一整天都知道</span>
            </span>
            <Switch checked={Boolean(d.showInTime)} label="当天进时间感知" onChange={(v) => set({ showInTime: v })} />
          </label>
        )}

        {!roleSet && d.kind === "anniversary" && (
          <label className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-ui text-ink">满整百天也告诉角色</span>
              <span className="mt-0.5 block text-meta text-ink-faint">满 100、200、300… 天那天，时间感知里写「在一起满300天」</span>
            </span>
            <Switch checked={d.milestones} label="满整百天也告诉角色" onChange={(v) => set({ milestones: v })} />
          </label>
        )}

        {err && <ResultNote state="fail" message={err} />}
      </div>
    </Modal>
  );
}

export function RemindersPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api("/api/reminders"));
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    refresh();
    // 角色在聊天里随时会设新的；面板开着时隔一阵拉一次
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error && !data) return <ResultNote state="fail" message={error} />;
  if (!data) return <p className="text-eyebrow uppercase text-ink-meta">读取中</p>;

  return (
    <>
      <SettingsCard data={data} onChange={setData} />
      <RoleItemsCard data={data} onEdit={setEditing} onChange={setData} />
      <UserItemsCard data={data} onEdit={setEditing} onAdd={() => setEditing(blank(data.roles))} onChange={setData} />
      {editing && (
        <EditModal item={editing} roles={data.roles} onClose={() => setEditing(null)} onSaved={setData} />
      )}
    </>
  );
}
