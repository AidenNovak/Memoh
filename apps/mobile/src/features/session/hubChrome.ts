/**
 * Hub 顶层件（大标题 / 视图切换 / agent 行 / 连接状态 / 新建会话）的模型组装。
 *
 * ## 为什么要有这个文件
 *
 * 会话 / 文件 / 定时是**同一个 agent 的三种看法**（裁决见 `screens/SessionsHubScreen.tsx`
 * 顶部），所以"现在在哪个视图、有哪些视图可选、这个 agent 叫什么、连接好不好"这四件事
 * 在三个视图上必须是**同一份数据**。模块 9 之前只有会话视图是原生的，这份组装写在
 * `NativeSessionsScreen.tsx` 里；现在文件与定时也交给原生画同一套顶层件，组装代码就有了
 * 三个调用方——抄成三份，就会有一天只改了其中一处（旧 `SessionsHubScreen` 的标题行就是
 * 这么跟会话页分叉出去的）。
 *
 * 这里只算**数据**，不碰 React、不碰路由、不碰任何组件：原生侧只画，它不认识 bot、
 * i18n 和权限（判据全在 RN）。
 */
import type { NativeHubChromeModel, NativeSettingsAvatar } from '@memoh-ios/kit';

import type { ConnectionState } from '../../api/realtime.ts';
import type { Bot } from '../../api/types.ts';
import { agentStatus } from '../bots/label.ts';
import { nativeAvatarPlan } from '../bots/nativeAvatar.ts';
import type { HubView } from '../bots/surfaces.ts';

/**
 * 翻译函数。`useT()` 的返回值就长这样（`(key, params?) => string`）。
 *
 * 判据与文案都在这里查好再下发：原生不认识 i18n，语言是运行时可切的（`lib/i18n`），
 * 切语言时整份模型重算一次就够。
 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 视图 → SF Symbol 名。原生拿到的是符号名，不是视图语义。 */
export const VIEW_SYMBOLS: Record<HubView, string> = {
  sessions: 'bubble.left.and.bubble.right',
  files: 'folder',
  schedule: 'calendar',
};

/**
 连接状态 → 文案 key。

 封闭集合用字典而不是嵌套三元（AGENTS.md 的规矩，这里也真的更清楚）：
 `connection` 以后再加一档（比如服务端主动踢人），只改这一张表。
 */
const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: 'chat.connecting',
  connecting: 'chat.connecting',
  reconnecting: 'chat.reconnecting',
  closed: 'chat.disconnected',
  unauthorized: 'chat.expired',
  open: 'chat.disconnected',
};

/** 连接行：`label` 主行，`pendingLabel` 空串 = 没有第二行，`retryHint` 是整行的无障碍提示。 */
export interface HubConnectionModel {
  label: string;
  pendingLabel: string;
  retryHint: string;
}

/** agent 菜单里的一项：`id === '__new__'` 是"新建 agent"入口（判据在 RN）。 */
export interface HubBotOption {
  id: string;
  name: string;
  statusLabel: string;
  selected: boolean;
  /**
   * 这一项要画的头像（远程图 / 内置图形 / 吉祥物）。**必填**：菜单每一项都有头像，
   * 缺一个就是"某个 agent 那一行空着"——组装处一律填满，判据全在
   * `features/bots/nativeAvatar.ts`（原生不复制那张表）。
   */
  avatar: NativeSettingsAvatar;
}

/** 视图切换器的一段。 */
export interface HubViewOption {
  id: string;
  label: string;
  symbol: string;
  selected: boolean;
}

/**
 * 连接行该说什么。**返回 null 就是整行不画**。
 *
 * 三种"不画"之外的形态：只读（没有实时通道）、正常连着且没有待发（`open` + 0）、
 * 以及还没有当前 agent。除了这三条，其余一律要说出来——弱网下"看起来连着"是最容易
 * 骗到人的状态（掉线期间点发送，界面和成功一模一样）。
 */
export function hubConnectionModel(
  input: {
    connection: ConnectionState;
    pendingSends: number;
    realtimeEnabled: boolean;
    currentBot: Bot | null;
  },
  t: Translate,
): HubConnectionModel | null {
  if (input.currentBot === null) return null;
  if (!input.realtimeEnabled) {
    return { label: t('chat.readOnly.short'), pendingLabel: '', retryHint: t('common.retry') };
  }
  if (input.connection === 'open' && input.pendingSends === 0) return null;
  const pendingLabel =
    input.pendingSends > 0 ? t('chat.pending', { count: input.pendingSends }) : '';
  return {
    label: t(CONNECTION_LABELS[input.connection]),
    pendingLabel,
    retryHint: t('chat.connection.retryHint'),
  };
}

/**
 * agent 菜单的行。
 *
 * 名字优先用 `display_name`（那是用户给这个 agent 起的名字），没设过才退回 `name`
 * （URL 名）；状态走 `agentStatus`——**同一处判据**，与设置页的 agent 卡片、会话页顶部的
 * 切换器是同一个函数（`features/bots/label.ts`）。
 *
 * `connectionOpen` 只喂给头像计划（远程头像失败后原生据此最多重试一次），由调用方把
 * `useConnectionState() === 'open'` 传进来——连接状态是 React 上下文里的东西，这一层
 * （纯函数、不碰 React）拿不到。
 */
export function hubBotRows(
  bots: readonly Bot[],
  currentBotId: string | null,
  t: Translate,
  connectionOpen: boolean,
): HubBotOption[] {
  return bots.map((bot) => {
    const status = agentStatus(bot, t);
    return {
      id: bot.id,
      name: bot.display_name !== '' ? bot.display_name : bot.name,
      statusLabel: status.label ?? '',
      selected: bot.id === currentBotId,
      // 没有 `avatar_url`（服务端 omitempty 时整个 key 都不在）时 `avatarFor` 落回吉祥物。
      avatar: nativeAvatarPlan(bot.avatar_url ?? '', connectionOpen),
    };
  });
}

/**
 * 视图切换器的选项。
 *
 * 标签用 `hub.view.<id>`，符号走 `VIEW_SYMBOLS`（原生只认符号名）。选中项是**真正挂载的
 * 那个视图**（`visibleHubView` 的结果），不是深链里写的那个——权限未知时先画的必须是
 * 允许画的那一屏。
 */
export function hubViewOptions(
  hubViews: readonly HubView[],
  visibleView: HubView,
  t: Translate,
): HubViewOption[] {
  return hubViews.map((id) => ({
    id,
    label: t(`hub.view.${id}`),
    symbol: VIEW_SYMBOLS[id],
    selected: id === visibleView,
  }));
}

/** 视图 → 标题的 i18n 键。会话视图复用 `home.title`：同一个词不该有两个键。 */
const HUB_TITLE_KEY: Record<HubView, string> = {
  sessions: 'home.title',
  files: 'hub.view.files',
  schedule: 'hub.view.schedule',
};

/**
 * 大标题该写哪个键。
 *
 * 标题**就是当前视图名**：三个视图共用这一份，写两遍必然有一天不一致（标题写着"文件"
 * 而内容还是会话）。
 */
export function hubTitleKey(view: HubView): string {
  return HUB_TITLE_KEY[view];
}

/**
 * 文件 / 定时两个原生屏要下发的完整 Hub 顶层件模型。
 *
 * 文案 key 与**会话页完全一致**（`home.newSession` / `bots.create` / `home.bot.switch`，
 * 大标题走 `hubTitleKey`）：三个视图上同一个按钮必须叫同一个名字，否则用户在文件页看到的
 * "新建会话"和会话页看到的会变成两件事。
 *
 * `showNewSession` 恒为 true：新建会话与 `sessions` 视图同权（`hubViewsFor` 永远含
 * `sessions`），所以没有"这一屏不给新建"的档；留着这个字段是让原生**不必自己判断**
 * 什么时候不该画——判断只有 RN 一处。
 */
export function hubChromeModel(
  input: {
    visibleView: HubView;
    hubViews: readonly HubView[];
    bots: readonly Bot[];
    currentBotId: string | null;
    connection: ConnectionState;
    pendingSends: number;
    realtimeEnabled: boolean;
    currentBot: Bot | null;
    /**
     * 实时连接是不是**已恢复**（`useConnectionState() === 'open'`）。
     *
     * 与 `connection` 是同一个上下文值的两种说法，仍然分开传：`connection` 是"现在画哪一行
     * 连接文案"（`hubConnectionModel` 要分辨 `connecting` / `unauthorized` 那几档），
     * 头像只关心"能不能重试那张远程图"这一条布尔。
     */
    connectionOpen: boolean;
  },
  t: Translate,
): NativeHubChromeModel {
  return {
    title: t(hubTitleKey(input.visibleView)),
    viewPickerVisible: input.hubViews.length > 1,
    views: hubViewOptions(input.hubViews, input.visibleView, t),
    bots: hubBotRows(input.bots, input.currentBotId, t, input.connectionOpen),
    viewMenuLabel: t('home.title'),
    botMenuLabel: t('home.bot.switch'),
    newBotLabel: t('bots.create'),
    newSessionLabel: t('home.newSession'),
    showNewSession: true,
    connection: hubConnectionModel(
      {
        connection: input.connection,
        pendingSends: input.pendingSends,
        realtimeEnabled: input.realtimeEnabled,
        currentBot: input.currentBot,
      },
      t,
    ),
  };
}
