/**
 * 推送桥的 JS 侧：**执行 `policy.ts` 的判定，自己不下判断**。
 *
 * ## 这一层与 policy 的分工（红线）
 *
 * policy 说"该不该请求权限 / 前台弹不弹 / 徽标是什么"，桥只把它变成调用：
 *
 * | 时机 | 谁决定 | 桥做什么 |
 * | --- | --- | --- |
 * | 冷启动 | `permissionActionFor(state,'cold_start')` → `nothing` | 记一笔状态，**不请求** |
 * | 用户点"开启通知" | `permissionActionFor(state,'user_asked')` | 请求，并把 `askedCount` 加一 |
 * | 前台收到推送 | `deliveryFor(event, ctx)` | 把判定翻成呈现选项名回给原生（`presentation.ts`） |
 * | 待审批数变了 | `badgeCountFor(n)` | `setBadgeCount` |
 *
 * 这里**没有**"如果……就弹"这类条件：桥上再抄一份判据，判据层就白做了，而且两份会漂移。
 *
 * ## 能力缺失时必须能降级
 *
 * `nativeNotifications()` 返回 null（旧 dev client、非 iOS）时，所有函数都是安全的
 * 空操作，且**仍然返回 policy 算出来的结论**——调用方（设置页、验收）拿到的行为一致，
 * 只是没有东西被执行。模拟器上注册远程通知会失败，那是预期：错误经
 * `onRemoteRegistrationFailed` 报上来，由上层决定要不要说，桥不改成"假装成功"。
 */
import { nativeNotifications } from '@memoh-ios/kit';
import { AppState } from 'react-native';

import { categorySpecsJSON } from './categories.ts';
import { recordPermissionRequest } from './history.ts';
import { parseOpen, type NotificationOpen } from './openRouting.ts';
import {
  badgeCountFor,
  deliveryFor,
  permissionActionFor,
  type AuthorizationStatus,
  type DeliveryDecision,
  type NotificationEvent,
  type PermissionAction,
  type PermissionTrigger,
} from './policy.ts';
import { presentationResolution } from './presentation.ts';
import {
  authorizationHeader,
  boundAfter,
  pushEnvironment,
  registrationSteps,
  requestFor,
} from './registration.ts';
import {
  clearBoundRegistration,
  loadBoundRegistration,
  loadPermissionHistory,
  saveBoundRegistration,
  savePermissionHistory,
} from './store.ts';

/** 与 `policy.AuthorizationStatus` 同名的字面量；原生给不认识的值时按"还没定"处理。 */
const STATUS_NAMES: Record<string, AuthorizationStatus> = {
  notDetermined: 'notDetermined',
  denied: 'denied',
  authorized: 'authorized',
  provisional: 'provisional',
  ephemeral: 'ephemeral',
};

const EVENT_NAMES: Record<string, NotificationEvent> = {
  approval_waiting: 'approval_waiting',
  run_finished: 'run_finished',
  run_failed: 'run_failed',
};

/** 桥要看到的 App 侧事实。由宿主组件提供（桥不 import store，避免反向依赖）。 */
export interface BridgeContext {
  /** 用户此刻在看哪个会话（不在会话页就是 null）。 */
  visibleSessionId: string | null;
  /** 当前登录用户 id（用于防串号核对）。 */
  currentUserId: string | null;
}

export interface BridgeEvents {
  /** 用户点了通知本体或某个动作。 */
  onOpen(open: NotificationOpen): void;
  /** 前台来了一条通知：policy 的判定在这里被算出，附带给调用方看。 */
  onDelivery(record: DeliveryRecord): void;
  /** 拿到 device token（hex）。**不要在日志里打印它**。 */
  onToken(token: string): void;
  /** 注册远程通知失败（模拟器/无凭据最常见）。 */
  onRegistrationFailed(message: string): void;
}

/** 一条前台通知的处置记录。 */
export interface DeliveryRecord {
  event: NotificationEvent | null;
  decision: DeliveryDecision;
  sessionId: string;
  at: number;
}

let currentStatus: AuthorizationStatus = 'notDetermined';

/**
 * 读一次授权状态。
 *
 * 原生不在时返回 `notDetermined` 而不是假的 `authorized`：那会让 policy 以为"已经能发
 * 通知了"，于是界面上不再给用户任何入口，而实际上什么都没接上。
 */
export async function refreshAuthorizationStatus(): Promise<AuthorizationStatus> {
  const native = nativeNotifications();
  if (native === null) return currentStatus;
  const raw = await native.notificationsAuthorizationStatus();
  const status = STATUS_NAMES[raw] ?? 'notDetermined';
  currentStatus = status;
  return status;
}

export interface PermissionOutcome {
  action: PermissionAction;
  status: AuthorizationStatus;
}

/**
 * 按判据处理"要不要请求权限"。
 *
 * `open_system_settings` 只是**答复**：桥不自己打开系统设置页（那是屏幕的事，
 * 而且只有用户主动要求时才该出现）。`ask` 才是动作。
 */
export async function ensurePermission(
  trigger: PermissionTrigger,
  now: number = Date.now(),
): Promise<PermissionOutcome> {
  const status = await refreshAuthorizationStatus();
  const history = await loadPermissionHistory();
  const action = permissionActionFor(
    { status, askedCount: history.askedCount, lastAskedAt: history.lastAskedAt },
    trigger,
    now,
  );
  if (action !== 'ask') return { action, status };

  const native = nativeNotifications();
  if (native === null) {
    // 没有原生能力时**不要**记这一笔：没请求过就不该消耗用户的配额。
    return { action: 'nothing', status };
  }

  const requested = await native.notificationsRequestAuthorization(['alert', 'sound', 'badge']);
  const nextStatus = STATUS_NAMES[requested] ?? status;
  const nextHistory = recordPermissionRequest(history, now);
  await savePermissionHistory(nextHistory);
  currentStatus = nextStatus;
  await registerForRemoteNotifications(nextStatus);
  return { action, status: nextStatus };
}

/**
 * 拿到"能发通知"的授权之后才去注册远程通知。
 *
 * 为什么等到有授权：`registerForRemoteNotifications` 在未授权时会直接失败（或拿到
 * 一个永远送不达的 token），而失败会污染我们对"这条链路到底通没通"的判断。
 */
async function registerForRemoteNotifications(status: AuthorizationStatus): Promise<void> {
  const native = nativeNotifications();
  if (native === null) return;
  const capable = status === 'authorized' || status === 'provisional' || status === 'ephemeral';
  if (!capable) return;
  await native.notificationsRegisterForRemoteNotifications();
}

/**
 * 注册通知分类（审批那两个动作）。
 *
 * 时机见 `NotificationCategoryRegistrar`：**任何一次启动都要注册**，不能等登录——分类要
 * 在推送投递那一刻就匹配上。这里只是执行，分类名与动作文案都来自 policy 与 i18n。
 */
export async function registerNotificationCategories(t: (key: string) => string): Promise<void> {
  const native = nativeNotifications();
  if (native === null) return;
  const json = categorySpecsJSON(t);
  await native.notificationsRegisterCategories(json);
}

/** 徽标 = 待审批数（与首页那份聚合同源）。0 会连通知中心里本 App 的通知一起清掉。 */ export async function syncNotificationBadge(
  pendingApprovals: number,
): Promise<void> {
  const native = nativeNotifications();
  if (native === null) return;
  await native.notificationsSetBadgeCount(badgeCountFor(pendingApprovals));
}

/**
 * 前台来了一条通知：算出判定、把"要不要呈现"回给原生。
 *
 * 判定用的是 policy 的 `deliveryFor`，上下文里 `isForeground: true` 是**事实**
 * （`willPresent` 只在 App 在前台时触发），不是我们猜的。
 */
function handlePresented(payload: Record<string, unknown>, context: BridgeContext): DeliveryRecord {
  const eventName = typeof payload.event === 'string' ? payload.event : '';
  const event = EVENT_NAMES[eventName] ?? null;
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';

  // 认不出来的事件一律按"不打扰"处理：**不为没有判据的事件发明呈现方式**。
  const decision: DeliveryDecision =
    event === null
      ? 'drop'
      : deliveryFor(event, {
          status: currentStatus,
          isForeground: true,
          visibleSessionId: context.visibleSessionId,
          eventSessionId: sessionId,
        });

  const native = nativeNotifications();
  if (native !== null && requestId !== '') {
    void native.notificationsResolvePresentation(presentationResolution(requestId, decision));
  }

  const record: DeliveryRecord = { event, decision, sessionId, at: Date.now() };
  return record;
}

/**
 * 启动整条链路。返回一个卸载函数。
 *
 * 做三件事：读一次授权状态、订上四个原生事件、取一次冷启动的点击。
 * `AppState` 变化只在**回到前台**时重读授权状态——用户去系统设置里开了通知再回来，
 * 界面必须立刻反映出来（否则他会以为没生效，然后再回去关一次）。
 *
 * **不在这里注册分类**：分类由 `NotificationCategoryRegistrar` 在登录之前就注册，理由
 * 见那个文件（等登录会让"App 没打开时的推送"没有动作按钮）。
 */
export function startNotificationBridge(
  config: { context: () => BridgeContext },
  events: BridgeEvents,
): () => void {
  const native = nativeNotifications();
  if (native === null) return () => undefined;

  const subscriptions = [
    native.addListener('onNotificationPresented', (payload) => {
      if (typeof payload !== 'object' || payload === null) return;
      const record = handlePresented(payload as Record<string, unknown>, config.context());
      events.onDelivery(record);
    }),
    native.addListener('onNotificationOpened', (payload) => {
      const open = parseOpen(payload);
      if (open === null) return;
      events.onOpen(open);
    }),
    native.addListener('onRemoteToken', (payload) => {
      const token = tokenFrom(payload);
      if (token === null) return;
      events.onToken(token);
    }),
    native.addListener('onRemoteRegistrationFailed', (payload) => {
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { message?: unknown }).message === 'string'
          ? String((payload as { message: string }).message)
          : 'remote notification registration failed';
      events.onRegistrationFailed(message);
    }),
  ];

  const appStateSubscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      void refreshAuthorizationStatus()
        .then(registerForRemoteNotifications)
        .catch(() => undefined);
    }
  });

  // 已授权的设备每次启动都重新向 APNs 注册；系统会复用或轮换 token，并通过同一个
  // onRemoteToken 事件交给上层。只在首次授权时注册会漏掉后续冷启动与 token 轮换。
  void refreshAuthorizationStatus()
    .then(registerForRemoteNotifications)
    .catch(() => undefined);

  // 冷启动那次点击：原生在 JS 起来之前就收到了，放在那儿等我们取。
  void native
    .notificationsTakePendingOpen()
    .then((pending) => {
      if (pending === null) return;
      const open = parseOpen(pending);
      if (open === null) return;
      events.onOpen(open);
    })
    .catch(() => undefined);

  return () => {
    for (const subscription of subscriptions) subscription.remove();
    appStateSubscription.remove();
  };
}

function tokenFrom(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const token = (payload as { token?: unknown }).token;
  if (typeof token !== 'string' || token === '') return null;
  return token;
}

export interface RegistrationReportParams {
  /** 当前会话（`credentials.getSession()` 给的那一份）。 */
  baseUrl: string;
  accessToken: string;
  currentUserId: string;
  bundleId: string;
  isDevBuild: boolean;
}

export type RegistrationOutcome =
  /** 没登录/没 token：没有可绑定的东西（不是错误）。 */
  | { kind: 'nothing_to_do' }
  /** 已是最新绑定，没有重复写。 */
  | { kind: 'up_to_date' }
  /** 跑了哪几步，以及哪一步失败了（失败时列出 step 便于对账）。 */
  | { kind: 'reported'; steps: number }
  | { kind: 'failed'; step: string; status: number };

/**
 * 把 device token 上报给服务端。
 *
 * 顺序由 `registration.registrationSteps` 给出：换号或换 token 都是**先解绑、再绑定**。
 */
export async function reportDeviceRegistration(
  params: RegistrationReportParams,
  options: { token: string | null },
): Promise<RegistrationOutcome> {
  if (options.token === null || params.currentUserId === '') return { kind: 'nothing_to_do' };
  const bound = await loadBoundRegistration();
  const steps = registrationSteps({
    token: options.token,
    userId: params.currentUserId === '' ? null : params.currentUserId,
    bound,
    environment: pushEnvironment(params.isDevBuild),
  });
  if (steps.length === 0) return { kind: 'up_to_date' };

  for (const step of steps) {
    const request = requestFor(step, {
      bundleId: params.bundleId,
      userId: params.currentUserId,
    });
    const response = await sendDeviceRequest(params, request);
    if (response === null) return { kind: 'failed', step: step.kind, status: 0 };
    if (!response.ok) return { kind: 'failed', step: step.kind, status: response.status };
    const next = boundAfter(step, true, bound);
    if (next === null) {
      await clearBoundRegistration();
    } else {
      await saveBoundRegistration(next);
    }
  }
  return { kind: 'reported', steps: steps.length };
}

/** 手动退出时解绑当前设备；网络失败时保留本地绑定，下一次登录会按安全顺序重试。 */
export async function removeDeviceRegistration(
  params: Pick<RegistrationReportParams, 'baseUrl' | 'accessToken' | 'currentUserId'>,
): Promise<boolean> {
  const bound = await loadBoundRegistration();
  if (bound === null || bound.userId !== params.currentUserId) return true;
  const request = requestFor(
    { kind: 'unregister', token: bound.token },
    { bundleId: '', userId: params.currentUserId },
  );
  const response = await sendDeviceRequest(params, request, 2_000);
  if (response === null || !response.ok) return false;
  await clearBoundRegistration();
  return true;
}

async function sendDeviceRequest(
  params: Pick<RegistrationReportParams, 'baseUrl' | 'accessToken'>,
  request: ReturnType<typeof requestFor>,
  timeoutMs: number = 8_000,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${params.baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        ...authorizationHeader(params.accessToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
