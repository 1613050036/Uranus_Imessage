import { useCallback, useEffect, useMemo, useState } from "react";
import { roleLabel } from "../labels.js";
import { useSection } from "../section.jsx";
import { api, useConfig } from "../store.jsx";
import { Card, ResultNote } from "../ui.jsx";
import { IPhone } from "./phoneos.jsx";
import { SettingsApp } from "./phonesettings.jsx";

/**
 * 查手机（后端 server/src/phonecheck.js；手机本体 phoneos.jsx；手机里的「设置」App phonesettings.jsx）。
 *
 * 这一页只放那台手机。生成按钮、世界书、同步开关、墙纸、App 样式和图标、自定义 App……
 * 全在手机里的「设置」App 里（用户要的：别把这一页弄乱，手机和电脑上都好用）。
 */

/** 没拉到数据之前先用这份。和 phonecheck.js 的 BUILTIN_APPS 对上。 */
const BUILTIN = [
  { id: "contacts", name: "通讯录" },
  { id: "chat", name: "信息" },
  { id: "call", name: "电话" },
  { id: "shop", name: "购物" },
  { id: "delivery", name: "外卖" },
  { id: "browser", name: "浏览器" },
  { id: "wallet", name: "钱包" },
  { id: "track", name: "活动轨迹" },
  { id: "favorites", name: "文件" },
  { id: "video", name: "视频" },
  { id: "incognito", name: "无痕浏览" },
];
const SETTINGS_APP = { id: "settings", name: "设置" };
const WALLPAPER_KEY = "uranus.phone.wallpaper";

export function PhonePanel() {
  const { config } = useConfig();
  const { itemId } = useSection();
  const role = (config.roles ?? []).find((r) => r.id === itemId) ?? null;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [wallpaper, setWallpaperState] = useState(() => {
    try {
      return localStorage.getItem(WALLPAPER_KEY) || "ocean";
    } catch {
      return "ocean";
    }
  });
  const setWallpaper = (id) => {
    setWallpaperState(id);
    try {
      localStorage.setItem(WALLPAPER_KEY, id);
    } catch {
      /* 存不进就只在这一次有效 */
    }
  };

  const refresh = useCallback(async () => {
    if (!itemId) return;
    try {
      setData((await api(`/api/phone/${itemId}`)).state);
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, [itemId]);

  useEffect(() => {
    setData(null);
    refresh();
  }, [refresh]);

  // App 样式（决定 App 名字）存在 config 里，自动保存之后重新拉一次 state
  const { savedConfig } = useConfig();
  const skinsKey = JSON.stringify(savedConfig?.phone?.skins ?? {});
  useEffect(() => {
    refresh();
  }, [skinsKey, refresh]);

  const running = useMemo(() => (data?.jobs ?? []).filter((j) => j.status === "running"), [data?.jobs]);
  useEffect(() => {
    if (!running.length) return undefined;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [running.length, refresh]);

  const builtin = data?.builtin ?? BUILTIN;
  const apps = useMemo(
    () => [...builtin, SETTINGS_APP, ...(config.phone?.customApps ?? []).map((a) => ({ ...a, custom: true }))],
    [builtin, config.phone?.customApps]
  );
  const batch = config.phone?.batchApps ?? ["contacts", "call", "shop", "delivery"];
  // 正在生成的 App：单个刷新的任务标题就是 App 名，一键 / 继续 / 重置算一次生成那一组
  const busyApps = useMemo(() => {
    const set = new Set();
    for (const j of running) {
      const hit = apps.find((a) => a.name === j.title);
      if (hit) set.add(hit.id);
      else batch.forEach((id) => set.add(id));
    }
    return set;
  }, [running, apps, batch]);

  const call = async (path, body, method = "POST") => {
    try {
      setData((await api(path, { method, ...(body ? { body } : {}) })).state);
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
      throw e;
    }
  };
  /** mode: "append" 在原来的手机上接着加 | "reset" 整台手机换成新的一批 */
  const generate = (appIds, mode = "append") =>
    call(`/api/phone/${itemId}/generate`, { apps: appIds ?? [], bookIds: data?.bookIds ?? [], mode }).catch(() => {});
  const setBooks = (bookIds) => {
    setData((d) => ({ ...d, bookIds }));
    call(`/api/phone/${itemId}/books`, { bookIds }).catch(() => {});
  };
  const setAsset = (body) => call(`/api/phone/${itemId}/assets`, body);
  const del = (appId, item) => call(`/api/phone/${itemId}/apps/${appId}?item=${encodeURIComponent(item)}`, null, "DELETE").catch(() => {});

  if (!itemId || !role) {
    return (
      <Card title="查手机" desc="左边挑一个角色，翻翻 TA 自己的手机。">
        <p className="text-meta leading-relaxed text-ink-faint">
          这里的东西全是模型按人设、记忆和最近的聊天虚构出来的、角色自己手机里的内容 —— 和「查岗」（看你的真屏幕）不是一回事。
          生成、世界书、墙纸这些设置都在手机里的「设置」App 里。
        </p>
      </Card>
    );
  }

  return (
    <Card title={`${roleLabel(role)} 的手机`}>
      {error && (
        <div className="mb-6">
          <ResultNote state="fail" message={error} />
        </div>
      )}
      {!data && !error && <p className="text-eyebrow uppercase text-ink-meta">读取中</p>}
      {data && (
        <>
          <IPhone
            data={data}
            apps={apps}
            busyApps={busyApps}
            onRefresh={(id) => generate([id])}
            onDelete={del}
            roleName={role.name}
            roleId={role.id}
            wallpaper={wallpaper}
            renderSettings={(close) => (
              <SettingsApp
                close={close}
                role={role}
                data={data}
                apps={apps}
                running={running}
                onGenerate={generate}
                onBooks={setBooks}
                onAsset={setAsset}
                wallpaper={wallpaper}
                setWallpaper={setWallpaper}
              />
            )}
          />
          <p className="mx-auto mt-5 max-w-[400px] text-center text-meta leading-relaxed text-ink-meta">
            点屏幕解锁，生成和各种设置都在手机里的「设置」App。App 里点底部横条回桌面，右上角可以全屏看。
          </p>
        </>
      )}
    </Card>
  );
}
