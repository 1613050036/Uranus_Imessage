/**
 * 这份界面是给哪种后端用的。
 *
 * 默认是桌面版（同一台机器上的 node 后端）。小手机控制台（Uranus小手机/console）
 * 打包的时候把 `VITE_URANUS_EDITION` 设成 "worker"：后端换成了 Cloudflare Worker，
 * 那边没有能手改的 data/ 文件夹、没有自动更新，这几处界面
 * 按这个开关藏掉或换个说法。
 */
export const WORKER = import.meta.env.VITE_URANUS_EDITION === "worker";

/**
 * 小手机的后端有没有某个功能。
 *
 * 小手机的后端是每个人自己从 Uranus_Phone 仓库部署的，常常比控制台旧好几版 ——
 * 控制台一更新，所有人立刻用上新界面，后端却要等各自重新部署。旧后端上碰到
 * 新功能会出两种怪事（用户报过）：
 *
 *  - 提醒页报 500：后端压根没有 /api/reminders
 *  - 点单「保存后自己关掉」：后端的配置整理不认识这些字段，存的时候直接丢了，
 *    回来的配置里没有它们，开关就显示成关
 *
 * 旧后端不报版本号（/api/health 里没有），所以按**它回的配置里有没有那一块**来认：
 * 配置整理只保留自己认识的字段，没有就是不认识。每个功能挑一个和它同一版加进来
 * 的顶层字段。
 *
 * 判断要用**后端最后一次回的那份**（store 里的 savedConfig），不能用草稿 ——
 * 界面上一改，草稿里就有那个字段了。
 *
 * 桌面版前后端同一份代码、一起更新，永远返回 true。
 */
const BACKEND_SINCE = {
  // 1.14：点单（瑞幸 / 麦当劳）
  order: "luckinApi",
  // 1.16：定时提醒、共感娃娃、自定义 CSS（同一版加的；提醒和 CSS 不在配置里，借娃娃那一块认）
  reminder: "dollApi",
  doll: "dollApi",
  customCss: "dollApi",
  // 1.18：语音转文字；1.19 起：FaceTime 通话
  stt: "sttApi",
  call: "callNode",
};

export function backendHas(savedConfig, feature) {
  if (!WORKER) return true;
  const key = BACKEND_SINCE[feature];
  // 还没读到配置时先当有 —— 宁可多显示一会儿，也别让新后端的人看到一闪而过的「太旧」
  if (!key || !savedConfig || typeof savedConfig !== "object") return true;
  return Object.prototype.hasOwnProperty.call(savedConfig, key);
}
