import { useState } from "react";
import { roleLabel } from "../labels.js";
import { api, useConfig } from "../store.jsx";
import { Button, Card, Field, ResultNote, Switch, inputCls } from "../ui.jsx";
import { usePresetGate } from "./role.jsx";

/**
 * 「点单」分区：瑞幸、麦当劳的 token 和「哪些角色能替你点」都在这一屏。
 *
 * token 是全局的（config.luckinApi / config.mcdApi，只写 data.config.json），
 * 每个角色的开关还是存在角色上（role.luckin），这里只是把它们摆到一起开 ——
 * 细项（先看菜单、取餐码提醒、确认时限）在角色面板的「瑞幸点单」里。
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

function RoleSwitch({ role }) {
  const { updateRole } = useConfig();
  const openGate = usePresetGate(role);
  const lk = role.luckin ?? {};
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="text-ui text-ink">{roleLabel(role)}</span>
      <Switch
        checked={Boolean(lk.enabled)}
        onChange={(v) => {
          updateRole(role.id, { luckin: { ...lk, enabled: v } });
          if (v) openGate("luckin");
        }}
        label={`${roleLabel(role)} 能帮你点瑞幸`}
      />
    </label>
  );
}

export function OrderPanel({ onGoto }) {
  const { config, updateLuckinApi, updateMcdApi } = useConfig();
  const roles = config.roles ?? [];
  const luckinToken = config.luckinApi?.token ?? "";
  const mcdToken = config.mcdApi?.token ?? "";

  return (
    <>
      <Card
        title="瑞幸"
        desc="角色写 [瑞幸:生椰拿铁|大杯|少冰]，这边去离你最近的门店配单算价，发一张订单卡片；你给卡片点个回应才下单，然后收到微信付款码。"
      >
        <div className="grid grid-cols-1 gap-6">
          <Field
            label="Token"
            hint="登录瑞幸 AI 开放平台 open.lkcoffee.com 后复制。每个人自己的，大约一个月过期，过期了回来换一个"
          >
            <input
              type="password"
              className={`${inputCls} ${luckinToken.trim() ? "" : "border-warn text-warn"}`}
              value={luckinToken}
              onChange={(e) => updateLuckinApi({ token: e.target.value })}
              placeholder="填你自己的 token"
            />
          </Field>
          <TestButton brand="luckin" token={luckinToken} />

          <div className="grid grid-cols-1 gap-4 border-t border-line pt-5">
            <div>
              <p className="text-ui text-ink">哪些角色能帮你点</p>
              <p className="mt-0.5 text-meta leading-relaxed text-ink-faint">
                先看菜单、取餐码提醒、确认时限这些细项在
                <button
                  type="button"
                  className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                  onClick={() => onGoto?.("role")}
                >
                  角色 → 瑞幸点单
                </button>
                里。找店按你在对话里发的位置，没发过就按
                <button
                  type="button"
                  className="mx-1 underline decoration-line underline-offset-2 hover:text-ink"
                  onClick={() => onGoto?.("user")}
                >
                  「你」
                </button>
                里的常用地址。
              </p>
            </div>
            {roles.length ? (
              roles.map((r) => <RoleSwitch key={r.id} role={r} />)
            ) : (
              <p className="text-meta text-ink-faint">还没有角色。</p>
            )}
          </div>
        </div>
      </Card>

      <Card
        title="麦当劳"
        desc="点单链路还没接上（下一步做），现在可以先把 token 填好、测一下能不能连上。"
      >
        <div className="grid grid-cols-1 gap-6">
          <Field label="Token" hint="在麦当劳 MCP 开放平台 open.mcd.cn/mcp 申请，每个人自己的">
            <input
              type="password"
              className={inputCls}
              value={mcdToken}
              onChange={(e) => updateMcdApi({ token: e.target.value })}
              placeholder="填你自己的 token"
            />
          </Field>
          <TestButton brand="mcd" token={mcdToken} />
        </div>
      </Card>
    </>
  );
}
