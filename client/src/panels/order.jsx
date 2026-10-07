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

const linkCls = "mx-1 underline decoration-line underline-offset-2 hover:text-ink";

export function RoleOrderFields({ role, onGoto }) {
  const { config, updateRole, updateLuckinApi, updateMcdApi } = useConfig();
  const openGate = usePresetGate(role);
  const lk = role.luckin ?? {};
  const set = (patch) => updateRole(role.id, { luckin: { ...lk, ...patch } });
  const luckinToken = config.luckinApi?.token ?? "";
  const mcdToken = config.mcdApi?.token ?? "";

  return (
    <div className="grid grid-cols-1 gap-8">
      <p className="text-meta leading-relaxed text-ink-faint">
        角色只负责挑：配好单发一张「待确认」的订单卡片，<strong className="text-ink-soft">你给卡片点个回应才真的下单</strong>
        ，然后收到微信付款二维码。不点就永远不会下单。订单卡片只有云端（Photon）线路能发；
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
                <span className="block text-ui text-ink">先看菜单</span>
                <span className="mt-0.5 block text-meta leading-relaxed text-ink-faint">
                  允许模型先写
                  <code className="mx-1 bg-sunken px-1">[瑞幸菜单:拿铁|美式]</code>
                  查附近门店的商品和价格，看完再点。那一趟你看不见。
                  <strong className="text-ink-soft">每查一次要多问模型一轮</strong>
                  ，那一轮的花费翻倍，所以默认关。
                </span>
              </span>
              <Switch checked={Boolean(lk.menu)} onChange={(v) => set({ menu: v })} label="先看菜单" />
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
        <div>
          <p className="text-ui text-ink">麦当劳</p>
          <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
            点单链路还没接上（下一步做），现在可以先把 token 填好、测一下能不能连上。
          </p>
        </div>
        <TokenField
          label="麦当劳 token"
          hint="在麦当劳 MCP 开放平台 open.mcd.cn/mcp 申请，每个人自己的"
          value={mcdToken}
          onChange={(v) => updateMcdApi({ token: v })}
        />
        <TestButton brand="mcd" token={mcdToken} />
      </div>
    </div>
  );
}
