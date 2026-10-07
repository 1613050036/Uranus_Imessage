import { useState } from "react";
import { api, useConfig } from "../store.jsx";
import { Button, Field, NumberField, ResultNote, Switch, inputCls } from "../ui.jsx";
import { usePresetGate } from "./role.jsx";

/**
 * 角色配置里的「点单」那一栏：瑞幸、麦当劳各一块。
 *
 * 开关存在角色上（role.luckin），token 是全局的（config.luckinApi / config.mcdApi，
 * 只写 data.config.json）—— 角色文件会被原样拷进不含密钥的备份，token 挂在角色上就漏了。
 * 所以 token 框写明了「所有角色共用」，在哪个角色这儿填都是同一份。
 */

/** 「测试连接」按钮 + 结果。测的是框里现在的 token，没保存也能测。 */
function TestButton({ brand, token }) {
  const [state, setState] = useState(null);
  const run = async () => {
    setState({ busy: true });
    try {
      const r = await api("/api/order/test", { method: "POST", body: { brand, token } });
      setState({ ok: true, msg: `连上了，${r.tools.length} 个工具，${r.ms}ms` });
    } catch (e) {
      setState({ ok: false, msg: String(e?.message ?? e) });
    }
  };
  return (
    <div className="grid grid-cols-1 gap-3">
      <div>
        <Button variant="outline" onClick={run} disabled={state?.busy || !token.trim()}>
          {state?.busy ? "测试中…" : "测试连接"}
        </Button>
      </div>
      {state && !state.busy && <ResultNote state={state.ok ? "ok" : "fail"} message={state.msg} />}
    </div>
  );
}

/** token 输入框：默认打码，点「显示」看明文（核对是不是复制全了）。 */
function TokenField({ label, hint, value, onChange, warn }) {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type={shown ? "text" : "password"}
          className={`${inputCls} ${warn && !value.trim() ? "border-warn text-warn" : ""}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="填你自己的 token"
          autoComplete="off"
        />
        <button
          type="button"
          className="shrink-0 text-meta text-ink-faint underline decoration-line underline-offset-2 hover:text-ink"
          onClick={() => setShown((v) => !v)}
        >
          {shown ? "隐藏" : "显示"}
        </button>
      </div>
    </Field>
  );
}

/**
 * 麦当劳外送送到哪个地址。账号里的地址没有「默认」标记（实测三个地址分在两个城市），
 * 所以让用户自己挑一个；不挑就按「你」里的常用地址猜（服务端 mcd.js:pickAddress）。
 * 列表现拉，不存 —— 只存挑中的 addressId。
 */
function McdAddressPicker({ token, value, onChange }) {
  const [state, setState] = useState(null);
  const load = async () => {
    setState({ busy: true });
    try {
      const r = await api("/api/order/mcd-addresses", { method: "POST", body: { token } });
      setState({ list: r.addresses });
    } catch (e) {
      setState({ error: String(e?.message ?? e) });
    }
  };
  const list = state?.list ?? [];
  const known = list.some((a) => a.addressId === value);
  return (
    <Field
      label="外送送到哪个地址"
      hint="地址是你麦当劳账号里存的（在麦当劳 App 里增删）。不选的话按「你」里的常用地址猜最像的那个"
    >
      <div className="grid grid-cols-1 gap-2">
        {list.length > 0 ? (
          <select className={inputCls} value={known ? value : ""} onChange={(e) => onChange(e.target.value)}>
            <option value="">不选，按常用地址猜</option>
            {list.map((a) => (
              <option key={a.addressId} value={a.addressId}>
                {a.address}
                {a.name ? `（${a.name}）` : ""}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-meta text-ink-faint">
            {value ? "已经选过一个地址。" : "还没选，按常用地址猜。"}点下面的按钮读一下账号里的地址。
          </p>
        )}
        <div>
          <Button variant="outline" onClick={load} disabled={state?.busy || !token.trim()}>
            {state?.busy ? "读取中…" : "读取账号里的地址"}
          </Button>
        </div>
        {state?.error && <ResultNote state="fail" message={state.error} />}
      </div>
    </Field>
  );
}

const linkCls = "mx-1 underline decoration-line underline-offset-2 hover:text-ink";

export function RoleOrderFields({ role, onGoto }) {
  const { config, updateRole, updateLuckinApi, updateMcdApi } = useConfig();
  const openGate = usePresetGate(role);
  const lk = role.luckin ?? {};
  const set = (patch) => updateRole(role.id, { luckin: { ...lk, ...patch } });
  const md = role.mcd ?? {};
  const setMd = (patch) => updateRole(role.id, { mcd: { ...md, ...patch } });
  const luckinToken = config.luckinApi?.token ?? "";
  const mcdToken = config.mcdApi?.token ?? "";

  return (
    <div className="grid grid-cols-1 gap-8">
      <p className="text-meta leading-relaxed text-ink-faint">
        角色只负责挑：配好单发一张「待确认」的订单卡片，<strong className="text-ink-soft">你给卡片点个回应才真的下单</strong>
        ，然后收到付款方式（瑞幸是微信付款二维码，麦当劳是付款链接）。不点就永远不会下单。
        瑞幸算价时会自动用上你账号里最划算的券；麦当劳可以自动领券、用券。下了单想退，跟角色说一声它会帮你取消。
        <br />
        角色写的「#备注」（比如「天气冷了，宝宝喝点暖的」）会写在卡片上，也写进订单，
        拿到手还能在小票上看到。订单卡片只有云端（Photon）线路能发；
        本地 Mac 模式只发一句文字报价，不下单。
        <br />
        找店按你在对话里发的位置，没发过就按
        <button type="button" className={linkCls} onClick={() => onGoto?.("user")}>
          「你」
        </button>
        里的常用地址。token 所有角色共用一份，在哪个角色这儿填都一样。
      </p>

      {/* ── 瑞幸 ── */}
      <div className="grid grid-cols-1 gap-6">
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">瑞幸</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              模型写
              <code className="mx-1 bg-sunken px-1">[瑞幸:生椰拿铁|大杯|少冰]</code>
              时去离你最近的瑞幸门店配单算价。完整写法在
              <button type="button" className={linkCls} onClick={() => onGoto?.("preset")}>
                预设 → 消息格式与功能 → 瑞幸点单
              </button>
              里，只在你最近几句聊到咖啡时才注入。
            </span>
          </span>
          <Switch
            checked={Boolean(lk.enabled)}
            onChange={(v) => {
              set({ enabled: v });
              if (v) openGate("luckin");
            }}
            label="这个角色能帮你点瑞幸"
          />
        </label>

        <TokenField
          label="瑞幸 token"
          hint="登录瑞幸 AI 开放平台 open.lkcoffee.com 后复制。每个人自己的，大约一个月过期，过期了回来换一个"
          value={luckinToken}
          onChange={(v) => updateLuckinApi({ token: v })}
          warn={lk.enabled}
        />
        <TestButton brand="luckin" token={luckinToken} />

        {lk.enabled && (
          <div className="grid grid-cols-1 gap-6 border-t border-line pt-5">
            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">自动带上菜单</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  你聊到咖啡、又没有进行中的订单时，先查一次离你最近那家店的菜单（商品、价格、规格）放进提示词，
                  你说「随便」角色也能从菜单里替你挑。点完单就不再带了。
                  菜单大约多几百 token，同一家店 30 分钟内用缓存；第一次要多等一两秒。关掉的话角色凭自己知道的菜单点。
                </span>
              </span>
              <Switch checked={lk.menu !== false} onChange={(v) => set({ menu: v })} label="自动带上菜单" />
            </label>

            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">取餐码提醒</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  只在你确认下单之后才开始：每分钟查一次这一单，查到取餐码就把卡片改成「待取餐」、
                  让角色告诉你，然后停。最多查 45 分钟，重启就不查了。查到那一刻会起一轮回复（花 token）。
                </span>
              </span>
              <Switch
                checked={Boolean(lk.pickupNotify)}
                onChange={(v) => set({ pickupNotify: v })}
                label="取餐码提醒"
              />
            </label>

            <NumberField
              label="多久内确认算数"
              value={lk.confirmMinutes ?? 30}
              min={1}
              max={240}
              step={5}
              suffix="分钟"
              hint="从订单卡片发出去那一刻算起。超了再点回应不会下单，卡片改成「已失效」—— 隔久了价格和券都不作数"
              onChange={(v) => set({ confirmMinutes: v })}
            />

            <Field label="卡片上方那行小字" hint="空着就是「瑞幸咖啡」">
              <input
                className={inputCls}
                value={lk.appName ?? ""}
                maxLength={40}
                onChange={(e) => set({ appName: e.target.value })}
                placeholder="瑞幸咖啡"
              />
            </Field>
          </div>
        )}
      </div>

      {/* ── 麦当劳 ── */}
      <div className="grid grid-cols-1 gap-6 border-t border-line pt-6">
        <label className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-ui text-ink">麦当劳</span>
            <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
              模型写
              <code className="mx-1 bg-sunken px-1">[麦当劳:巨无霸套餐+麦辣鸡翅×2]</code>
              时配单算价。外送送到你麦当劳账号里存的地址（下面选哪个）；到店先找你在麦当劳 App 里收藏的门店，
              没有收藏就用能送到你那个地址的几家店。
              麦当劳没有查订单的接口，所以没有取餐码提醒。
            </span>
          </span>
          <Switch
            checked={Boolean(md.enabled)}
            onChange={(v) => {
              setMd({ enabled: v });
              if (v) openGate("mcd");
            }}
            label="这个角色能帮你点麦当劳"
          />
        </label>
        <TokenField
          label="麦当劳 token"
          hint="在麦当劳 MCP 开放平台 open.mcd.cn/mcp 申请，每个人自己的"
          value={mcdToken}
          onChange={(v) => updateMcdApi({ token: v })}
          warn={md.enabled}
        />
        <TestButton brand="mcd" token={mcdToken} />

        {md.enabled && (
          <div className="grid grid-cols-1 gap-6 border-t border-line pt-5">
            <Field label="默认怎么拿" hint="角色没写 @外送 / @到店 时按这个">
              <select
                className={inputCls}
                value={md.mode === "pickup" ? "pickup" : "delivery"}
                onChange={(e) => setMd({ mode: e.target.value })}
              >
                <option value="delivery">外送（送到麦当劳账号里的地址）</option>
                <option value="pickup">到店自取</option>
              </select>
            </Field>

            <McdAddressPicker token={mcdToken} value={md.addressId ?? ""} onChange={(v) => setMd({ addressId: v })} />

            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">自动领券</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  配单前先把麦麦省里能领的券一键领进你的账号（不花钱，6 小时最多一次）。这家店能用的券会列给角色，
                  角色照券名点就是用券。
                </span>
              </span>
              <Switch checked={md.autoCoupon !== false} onChange={(v) => setMd({ autoCoupon: v })} label="自动领券" />
            </label>

            <label className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-ui text-ink">自动带上菜单</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  你聊到吃的、又没有进行中的订单时，先查一次那家店这个时段能点的（早餐 / 午餐 / 夜宵会换）放进提示词。
                  点完单就不再带了。同一家店 30 分钟内用缓存。
                </span>
              </span>
              <Switch checked={md.menu !== false} onChange={(v) => setMd({ menu: v })} label="自动带上麦当劳菜单" />
            </label>

            <NumberField
              label="多久内确认算数"
              value={md.confirmMinutes ?? 30}
              min={1}
              max={240}
              step={5}
              suffix="分钟"
              hint="超了再点回应不会下单，卡片改成「已失效」"
              onChange={(v) => setMd({ confirmMinutes: v })}
            />

            <Field label="卡片上方那行小字" hint="空着就是「麦当劳」">
              <input
                className={inputCls}
                value={md.appName ?? ""}
                maxLength={40}
                onChange={(e) => setMd({ appName: e.target.value })}
                placeholder="麦当劳"
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}
