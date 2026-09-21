/**
 * Hub 顶层件的视图模型（RN → 原生）。
 *
 * ## 这是什么
 *
 * 会话 / 文件 / 定时是**同一个 agent 的三种看法**，所以三屏顶部那几样东西——大标题、
 * 视图切换器、agent 菜单、连接行、新建会话——必须是同一份数据。会话视图从模块 4 起就有
 * 自己的等价物（`NativeSessionsViewModel` 里的 `views` / `bots` / `connection`，本文件不
 * 回去动它）；模块 9 让文件与定时也画同一套顶层件，于是抽出这一份**只描述顶层件**的模型，
 * 两个视图各自把它挂在自己的模型上（`NativeFilesViewModel.hub` /
 * `NativeScheduleListViewModel.hub`）。
 *
 * ## 分工
 *
 * 状态所有者仍是 RN：标题文案、视图符号名、agent 名字与状态、连接文案、要不要画切换器
 * ——全都在 RN 侧查好（`features/session/hubChrome.ts`），以一份 JSON 下发；原生只画并回
 * 事件，**原生不认识 bot、i18n 和权限**。
 *
 * 缺省（`hub` 为 `undefined` / `null`）＝ 这一屏不画顶层件：老 dev client 与还没接上的
 * 调用方都走这条路，不是错误。
 */
import type { NativeSettingsAvatar } from '../settings/NativeSettingsView';

export interface NativeHubChromeModel {
  /** 当前视图名（大标题）。 */
  title: string;
  /** 可选视图多于一个才 true；false 时整块切换器不画。 */
  viewPickerVisible: boolean;
  views: NativeHubChromeViewOption[];
  bots: NativeHubChromeBotOption[];
  /** 视图切换器的无障碍标签 / 菜单标题。 */
  viewMenuLabel: string;
  /** agent 菜单的无障碍标签。 */
  botMenuLabel: string;
  /** agent 菜单末尾"新建 agent"那一项的文字。 */
  newBotLabel: string;
  /** 新建会话按钮的无障碍标签。 */
  newSessionLabel: string;
  /** 是否画新建会话入口（判据在 RN：这一屏给不给新建）。 */
  showNewSession: boolean;
  /** 连接行；`null` = 不画（正常连着、或还没有当前 agent）。 */
  connection?: NativeHubChromeConnection | null;
}

/** 视图切换器的一段。`symbol` 是 SF Symbol 名（RN 查好表再下发）。 */
export interface NativeHubChromeViewOption {
  /** `sessions` | `files` | `schedule`。 */
  id: string;
  label: string;
  symbol: string;
  selected: boolean;
}

/** agent 菜单的一项。`id === '__new__'` 是"新建 agent"入口（RN 判）。 */
export interface NativeHubChromeBotOption {
  id: string;
  name: string;
  /** 状态文案；空串 = 不显示。 */
  statusLabel: string;
  selected: boolean;
  /**
   * 这一项要画的头像（远程图 / 内置图形 / 吉祥物）。
   *
   * 与选择器行上的 `avatar` 是**同一份计划**（`features/bots/nativeAvatar.ts`）：原生只按它
   * 画，不判"这个 bot 有没有头像"。缺省 = 旧原生按老画法画一颗系统图标。
   */
  avatar?: NativeSettingsAvatar;
}

/** 连接行：主行 + 可选次级行（"还有几条没发出去"）+ 整行的无障碍提示。 */
export interface NativeHubChromeConnection {
  label: string;
  /** 空串 = 没有第二行。 */
  pendingLabel: string;
  /** 点这一行会发生什么（无障碍 hint）。 */
  retryHint: string;
}
