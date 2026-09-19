/**
 * 通知的**判据层**：什么时候请求权限、什么事件值得打扰、打扰时说什么。
 *
 * ## 为什么这一段先于推送存在
 *
 * 真·远程推送要 APNs 凭据 + 服务端发送方 + 原生模块（`expo-notifications` 或自建
 * `UNUserNotificationCenter` 桥），三样都还没有。但"什么时候该弹权限框""哪些事才配
 * 发通知""通知里能写什么"这些判断**不依赖任何凭据**——它们是策略，写成纯函数就能被
 * 测试钉住，等发送端接上直接调用，不用回头重写一遍散落在 UI 里的 if。
 *
 * 出处（都是 Apple 一手材料，逐条对应到下面的函数）：
 *
 * | 判据 | 出处 |
 * | --- | --- |
 * | 权限要在用户理解价值之后、由上下文触发，**不要冷启动就弹** | *Asking permission to use notifications*："Sending the request in context provides a better experience than automatically requesting authorization on first launch" |
 * | 被拒之后系统不会再弹（再调 `requestAuthorization` 也不弹），所以只能引导去系统设置 | 同上："Subsequent authorization requests don't prompt the person" |
 * | 请求前要先读授权状态，并按状态调整行为 | 同上："Always check your app's authorization status before scheduling local notifications" |
 * | 同一件事不要重复发，哪怕用户没理 | HIG *Notifications*："Avoid sending multiple notifications for the same thing, even if someone hasn't responded" |
 * | 前台收不到横幅时要在界面里温和呈现，不要另弹一层 | 同上："present the information in a way that's discoverable but not distracting or invasive" |
 * | 不要在通知里塞敏感信息（对话正文就是敏感信息） | 同上："Avoid including sensitive, personal, or confidential information" |
 * | 徽标只表示"未读通知数"，且要跟着读掉清零 | 同上 *Badging*："Use a badge only to show people how many unread notifications they have" |
 * | 打扰等级要如实反映紧迫度；Time Sensitive 只给"正在发生/一小时内"的事 | HIG *Managing notifications*：四个等级 + "Use the Time Sensitive interruption level only for notifications that are relevant in the moment" |
 * | 必须提供 App 内的通知设置入口 | 同上："you must also provide an in-app settings screen that lets people change their choice" |
 *
 * ## 这一层不做什么
 *
 * - **不碰** `UNUserNotificationCenter`、不碰 APNs、不发任何请求：这里只有纯判断，
 *   所以能在 `node --test` 里跑。
 * - **不发明事件**。事件集合是封闭的三条（见 `NOTIFICATION_EVENTS`），加一条要同时改
 *   这个文件、文案表和测试；"顺手也发一条"正是打扰用户的开始。
 */

import type { SFSymbol } from 'expo-symbols';

/** 会打扰用户的事件。**封闭集合**：这里每多一条，用户就多一个被打扰的理由。 */
export type NotificationEvent = 'approval_waiting' | 'run_finished' | 'run_failed';

/**
 * 授权状态，与 iOS `UNAuthorizationStatus` 一一对应。
 *
 * `provisional` 是"静默试探授权"（`UNAuthorizationOptions.provisional`）：系统直接给，
 * 但不发横幅、不进锁屏，只落在通知中心历史里，并带"保持/关闭"两个按钮让用户事后裁决。
 * 把 `provisional` 当 `authorized` 处理是错的——那样我们就以为能弹横幅了。
 */
export type AuthorizationStatus =
  'notDetermined' | 'denied' | 'authorized' | 'provisional' | 'ephemeral';

/** 触发"要不要请求权限"这个判断的时机。 */
export type PermissionTrigger =
  /** App 刚起来。**这个时机不请求**（HIG 点名的反例）。 */
  | 'cold_start'
  /** 用户在设置里主动点"开启通知"。 */
  | 'user_asked'
  /** 第一次遇到"有任务在等你批准"——上下文最清楚的时刻。 */
  | 'first_approval';

export interface PermissionState {
  status: AuthorizationStatus;
  /** 历史上主动请求过几次（用于封顶，见 `MAX_EXPLICIT_REQUESTS`）。 */
  askedCount: number;
  /** 上次请求的时间戳（毫秒）；没请求过就是 `null`。 */
  lastAskedAt: number | null;
}

export type PermissionAction =
  /** 调 `requestAuthorization`（系统只会在第一次真弹框）。 */
  | 'ask'
  /** 不再请求，给一条通往系统设置的路径。 */
  | 'open_system_settings'
  /** 什么都不做（这是默认答案，也是大多数情况下的正确答案）。 */
  | 'nothing';

/**
 * 主动请求的封顶次数。
 *
 * 系统层面第一次之后就再也不弹了，所以这里的意义是**别让 App 自己反复表达诉求**
 * （例如每次进设置页都调一次、每次都弹一个"请在系统设置里开启"的提示）。
 * 一次给上下文，一次给主动动作，够了。
 */
export const MAX_EXPLICIT_REQUESTS = 2;

/**
 * 两次请求之间的最小间隔（7 天）。
 *
 * 用户今天拒了、明天又被问一次，感受是"这 App 在缠着我"；而系统本来就不会再弹框，
 * 第二次请求的唯一效果就是多一次无声的失败。
 */
export const REQUEST_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 该不该请求通知权限。
 *
 * 判据的顺序是有讲究的——先看结果是"已经定了"的（授权/拒绝），再看时机，
 * 最后才看次数与冷却：
 *
 * 1. `authorized` / `ephemeral`：已经能给用户发通知了，别问。
 * 2. `provisional`：系统已经给了静默通道，此时**不该**再弹一次显式请求去打断用户
 *    （那等于把"事后裁决"提前变成"当场裁决"，正好丢了试探授权的意义）。
 * 3. `denied`：系统不会再弹框。唯一有意义的方向是引导去系统设置，且**只在用户主动要求时才给**。
 * 4. `notDetermined`：看时机。`cold_start` 一律不做；`user_asked` 与 `first_approval` 才请求。
 */
export function permissionActionFor(
  state: PermissionState,
  trigger: PermissionTrigger,
  now: number,
): PermissionAction {
  if (state.status === 'authorized' || state.status === 'ephemeral') return 'nothing';
  if (state.status === 'provisional') return 'nothing';
  if (state.status === 'denied') {
    // 被拒之后**只有**用户自己要求时才给设置入口：主动弹一次"去系统设置开一下"
    // 是在替用户做决定，而且大多数情况下他只是当时不想被打扰。
    return trigger === 'user_asked' ? 'open_system_settings' : 'nothing';
  }
  if (trigger === 'cold_start') return 'nothing';
  if (state.askedCount >= MAX_EXPLICIT_REQUESTS) {
    return trigger === 'user_asked' ? 'open_system_settings' : 'nothing';
  }
  if (state.lastAskedAt !== null && now - state.lastAskedAt < REQUEST_COOLDOWN_MS) {
    return 'nothing';
  }
  return 'ask';
}

/** 送达判断的输入：授权状态 + 用户此刻在哪。 */
export interface DeliveryContext {
  status: AuthorizationStatus;
  /** App 是否在前台。 */
  isForeground: boolean;
  /** 用户此刻正在看的会话 id（不在会话页就是 `null`）。 */
  visibleSessionId: string | null;
  /** 这条事件属于哪个会话。 */
  eventSessionId: string;
}

export type DeliveryDecision =
  /** 交给系统发通知。 */
  | 'notify'
  /** 不发通知，改在界面里就地呈现（首页待审批聚合、会话内的徽标）。 */
  | 'in_app'
  /** 系统不会显示，也没必要在界面里额外强调。 */
  | 'drop';

/**
 * 这条事件该不该发通知。
 *
 * `in_app` 与 `drop` 的区别是**用户还能不能在界面里自然看到它**：
 *
 * - 前台时系统不显示通知（HIG：通知在前台不出现，由 App 自己接住），所以前台一律不 `notify`。
 * - 但"有任务在等你批准"在别的会话里发生时，用户看不到——首页那份跨 bot 待审批聚合
 *   就是接住它的地方，所以给 `in_app`。
 * - 如果他正看着**这个**会话，审批 panel 就在眼前，再强调一次是噪音 → `drop`。
 * - "跑完了/失败了"不需要额外强调：眼前的消息流自己会停下或报错 → `drop`。
 */
export function deliveryFor(event: NotificationEvent, context: DeliveryContext): DeliveryDecision {
  if (context.status === 'denied' || context.status === 'notDetermined') return 'drop';
  if (!context.isForeground) return 'notify';
  if (event !== 'approval_waiting') return 'drop';
  if (context.visibleSessionId === context.eventSessionId) return 'drop';
  return 'in_app';
}

/** 会话内分组用的线程 id：同一会话的通知在通知中心归到一组。 */
export function threadIdFor(sessionId: string): string {
  return `session:${sessionId}`;
}

/** 打扰等级，取值与 `UNNotificationInterruptionLevel` 对应。 */
export type InterruptionLevel = 'passive' | 'active' | 'timeSensitive';

export interface NotificationPayload {
  /** 标题文案 key（文案表里的 key，不是字面量）。 */
  titleKey: string;
  /** 正文文案 key。 */
  bodyKey: string;
  /**
   * 会话内分组用 `session:<id>`：同一会话的多条通知在通知中心会归到一组
   * （`threadIdentifier`），不会各自占一行把通知中心刷满。
   */
  threadId: string;
  interruptionLevel: InterruptionLevel;
  /** 通知分类（决定进 App 之前能直接点哪些按钮）。 */
  category: string;
}

export interface ApprovalContext {
  sessionId: string;
  botName: string;
}

/**
 * 事件的打扰等级。
 *
 * - **审批等待**：`timeSensitive`。符合 HIG 的限定——agent 正在等你，就是"此刻发生的事"；
 *   不回，那一轮就一直挂着。系统第一次送达 Time Sensitive 通知时会向用户解释，且以后
 *   会周期性再问一次，所以这一档**不能滥用**。
 * - **跑完了**：`active`（默认级）。"你可能想知道"，不是"你必须现在知道"。
 * - **失败了**：也是 `active`，**不是** `timeSensitive`。失败要用户回来看看，但它不紧急，
 *   而 HIG 明确要求不要用高紧迫度去送低优先级信息。
 */
export function interruptionLevelFor(event: NotificationEvent): InterruptionLevel {
  if (event === 'approval_waiting') return 'timeSensitive';
  return 'active';
}

/**
 * 事件 → 通知内容。
 *
 * 正文里**永远不放对话内容**：通知会出现在锁屏上，可能被别人看到（HIG：不要把敏感、
 * 私人或机密信息放进通知）。所以正文只说"哪个 agent、什么事"，细节留给 App 里。
 */
export function payloadFor(
  event: NotificationEvent,
  context: ApprovalContext,
): NotificationPayload {
  if (event === 'approval_waiting') {
    return {
      titleKey: 'notification.approval.title',
      bodyKey: 'notification.approval.body',
      threadId: threadIdFor(context.sessionId),
      interruptionLevel: interruptionLevelFor(event),
      // 分类带"批准/拒绝"两个动作：不进 App 也能处理（HIG：动作要省掉"打开 App"这一步）。
      category: 'approval',
    };
  }
  if (event === 'run_failed') {
    return {
      titleKey: 'notification.failed.title',
      bodyKey: 'notification.failed.body',
      threadId: threadIdFor(context.sessionId),
      interruptionLevel: interruptionLevelFor(event),
      category: 'run',
    };
  }
  return {
    titleKey: 'notification.finished.title',
    bodyKey: 'notification.finished.body',
    threadId: threadIdFor(context.sessionId),
    interruptionLevel: interruptionLevelFor(event),
    category: 'run',
  };
}

/**
 * 徽标数字 = **跨 bot 的待审批总数**。
 *
 * HIG 的 *Badging* 那一节把徽标的语义钉死成"有多少条未读通知等你处理"，并明确
 * "Don't use a badge to convey numeric information that isn't related to notifications"。
 * 所以：
 *
 * - 它不是"会话数"（会话多不代表有事等你）；
 * - 不是"未读消息数"（消息流本来就会读，读到一半的数字没有意义）；
 * - **0 会在系统侧清掉通知中心里这个 App 的所有通知**，所以"处理完了"必须是 0，
 *   而不是留一个历史计数。
 *
 * 与首页顶部那份跨 bot 待审批聚合同源（`features/activity/useSessionActivity.ts`）：
 * 两处数字不一致比不显示更糟。
 */
export function badgeCountFor(pendingApprovals: number): number {
  if (!Number.isFinite(pendingApprovals) || pendingApprovals <= 0) return 0;
  return Math.floor(pendingApprovals);
}

/** 界面上列出来的事件顺序（设置页用它，与测试共用同一份，避免两处各写一遍）。 */
export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  'approval_waiting',
  'run_finished',
  'run_failed',
];

/** 每个事件在界面上的标题/说明 key。封闭集合用字典映射，不用三元（`AGENTS.md`）。 */
export const EVENT_COPY: Record<
  NotificationEvent,
  { titleKey: string; subtitleKey: string; icon: SFSymbol }
> = {
  approval_waiting: {
    titleKey: 'notification.event.approval.title',
    subtitleKey: 'notification.event.approval.subtitle',
    icon: 'hand.raised',
  },
  run_finished: {
    titleKey: 'notification.event.finished.title',
    subtitleKey: 'notification.event.finished.subtitle',
    icon: 'checkmark.circle',
  },
  run_failed: {
    titleKey: 'notification.event.failed.title',
    subtitleKey: 'notification.event.failed.subtitle',
    icon: 'exclamationmark.triangle',
  },
};

/**
 * 明确**不发**的东西。写下来是为了挡住"顺手也发一条"：
 * 每一条都有具体的代价，不是洁癖。
 */
export const NEVER_NOTIFY: readonly { readonly id: string; readonly why: string }[] = [
  {
    id: 'stream_tokens',
    why: '流式 token 一秒几十条。通知中心会被刷满，用户会把整个 App 的通知关掉——这个代价不可逆。',
  },
  {
    id: 'every_message',
    why: '同一件事不重复发（HIG）。用户没回一条消息不代表他想被再提醒一次。',
  },
  {
    id: 'marketing',
    why: 'HIG 要求营销类通知必须单独拿到明确同意，且永远不许用 Time Sensitive。我们没有营销内容，所以连开关都不给。',
  },
  {
    id: 'error_text',
    why: '失败通知只说"失败了、哪个会话"，不抄错误原文：错误文本里可能带路径、token 片段、URL，而通知会出现在锁屏上。',
  },
];
