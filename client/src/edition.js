/**
 * 这份界面是给哪种后端用的。
 *
 * 默认是桌面版（同一台机器上的 node 后端）。小手机控制台（Uranus小手机/console）
 * 打包的时候把 `VITE_URANUS_EDITION` 设成 "worker"：后端换成了 Cloudflare Worker，
 * 那边没有能重启的进程、没有能手改的 data/ 文件夹、没有 tar 打包，这几处界面
 * 按这个开关藏掉或换个说法。
 */
export const WORKER = import.meta.env.VITE_URANUS_EDITION === "worker";
