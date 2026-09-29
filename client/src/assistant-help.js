/**
 * Uranus 助手在前端要用到的几个常量。
 *
 * 只有兜底值和纯展示用的东西。**内置世界书那本手册不在这儿** ——
 * 它在 server/src/assistant.js 里，因为那本书是拼进系统提示词的，
 * 前端一个字都不需要看见。抄一份到前端只会多一处会过期的副本。
 */

import { WORKER } from "./edition.js";

/**
 * 群号的兜底写法，只在 /api/assistant/hello 还没回来的那一瞬间派得上用场。
 * 正主是 server/src/assistant.js 的 QQ_GROUP，改那边记得改这边。
 *
 * 小手机不放群号（用户点名要的），是空串；界面上凡是提群的地方见空就不画。
 */
export const DEFAULT_QQ_GROUP = WORKER ? "" : "1125033956";

/**
 * Niki 写的图文教程。比内置世界书详细，而且有图。
 * 正主也在 server/src/assistant.js（DOC_URL），改那边记得改这边。
 */
export const DOC_URL = "https://docs.qq.com/doc/DVnFncG9Tc05kdFZY";

/** 接口没回来时先显示这句，免得气泡一打开是空的。 */
export const DEFAULT_HELLO =
  "我是 Uranus ՞˶˃ ᵕ ˂˶՞ 不知道某个功能是干什么的、不知道该在哪儿开、或者报了错不知道缺什么，都可以问我。";

/** 历史最多留几条（一问一答算两条）。和后端 MAX_TURNS 对齐，超了从头上丢。 */
export const MAX_TURNS = 12;

/**
 * 快速配置弹窗左下角那颗「教程」按钮里的清单。
 *
 * 大多是 Niki 放在 QQ 群群文件里的文档，有链接版的给链接；
 * `file` 是群文件里的文件名，没有链接版的只能照这个名字去群里找。
 * 小手机不提群，只留有链接的，也不报群文件名（见文件末尾）。
 */
const ALL_TUTORIALS = [
  {
    title: "常见问题与功能介绍",
    url: "https://ccnb9dqqjtkg.feishu.cn/docx/NaMmd5mhwoKQm4xGOiwcEpRdnmd",
  },
  {
    title: "查岗功能",
    url: "https://docs.qq.com/doc/p/6e3326acd1cf9f3b181904d74f49386792fce71e",
    file: "查岗全部功能使用说明txt",
    note: "第一次配置查岗，先看群文件【IOS查岗教程图文版】docx；链接版是图文 + 快捷指令配置的整合",
  },
  {
    title: "搬家（转移记忆）",
    url: "https://docs.qq.com/doc/DVnpndW11TGVFVFVW",
    file: "如何搬家？（转移记忆）docx",
    note: "在别的地方已经有记忆，要迁移过来",
  },
  {
    title: "Windows 部署（详细版）",
    url: "https://docs.qq.com/doc/DVnBIUW9xd2twdHpr",
    file: "部署Uranus教程本地版docx",
  },
  { title: "Mac 部署", file: "Mac部署教程md" },
  {
    title: "VPS 云端部署",
    url: "https://docs.qq.com/doc/DVnBRVWxZeEZwSEtQ",
    file: "部署Uranus教程VPS版docx",
  },
  {
    title: "绑定 IG",
    url: "https://docs.qq.com/doc/DVmNTU29RYUhZdmtX",
    file: "绑定IG教程docx",
  },
  {
    title: "视频识别（含抖音 / 小红书）",
    url: "https://docs.qq.com/doc/DVnJvRUFKZGJ0Z3dW",
    note: "教程和限制",
  },
  {
    title: "连 Photon",
    url: "https://docs.qq.com/doc/p/2b72d49de9b6406f36357c0ced64d034024a0df7",
  },
  {
    title: "Photon 建完项目找不到侧边栏",
    url: "https://ccnb9dqqjtkg.feishu.cn/wiki/PSOvwac77iExhtkR9iqcuWgLnYe",
    note: "手机上看不到 Configure、拿不到 Project ID 和 Secret",
  },
  { title: "备份", url: "https://docs.qq.com/doc/DVnBsb0FQamNqeU93" },
];

export const TUTORIALS = WORKER
  ? ALL_TUTORIALS.filter((t) => t.url).map(({ file, note, ...t }) => ({
      ...t,
      ...(note && !note.includes("群文件") && { note }),
    }))
  : ALL_TUTORIALS;
