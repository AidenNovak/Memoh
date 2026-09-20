/**
 * `MemohKit` 里推送那部分的 **typed facade**。
 *
 * ## 这一层做什么
 *
 * 只做三件事：找到模块、把方法名与形状写清楚、**在能力缺失时返回 null**。
 * 任何判断（该不该请求权限、前台弹不弹、徽标是什么）都不在这里——它们在
 * `apps/mobile/src/features/notifications/`，SDK 侧的判据层才是唯一说了算的地方。
 *
 * ## 为什么允许 null
 *
 * 这条能力不是每个运行环境都有：
 *
 * - 模拟器 / 没有凭据的机器：能拿到 API，但注册远程通知一定会失败（那是预期，不是 bug）；
 * - **旧 dev client**：原生代码还没编进去，模块存在但方法不存在；
 * - 非 iOS 平台：本项目 iOS-only，但 facade 不该在别的平台上崩。
 *
 * 所以调用方拿到的可能是 null，且**必须**能继续跑（不弹权限框、不设徽标、不做深链）。
 * 这与 `NativeMessageList` 处理"原生视图不在"是同一套做法。
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/** 原生 `willPresent` 报上来的东西。`requestId` 是回话用的。 */
export interface PresentedNotification {
  requestId: string;
  title: string;
  body: string;
  category: string;
  threadId: string;
  sessionId: string;
  approvalId: string;
  event: string;
}

/** 用户点通知/点动作之后报上来的东西。 */
export interface OpenedNotification {
  sessionId: string;
  approvalId?: string;
  action: string;
  event?: string;
}

export interface RemoteTokenPayload {
  token: string;
}

export interface RemoteRegistrationFailure {
  message: string;
}

export type NotificationEventName =
  | 'onNotificationPresented'
  | 'onNotificationOpened'
  | 'onRemoteToken'
  | 'onRemoteRegistrationFailed';

export interface NotificationSubscription {
  remove(): void;
}

/**
 * 原生那一侧暴露的方法名。
 *
 * **必须与 `MemohKitModule.swift` 里的字符串一字不差**——名字对不上时模块还在、函数还在，
 * 但 JS 拿到的是 undefined；表现是"桥什么都没发生"（本轮实测踩过：facade 里写成
 * `authorizationStatus`，原生那边注册的是 `notificationsAuthorizationStatus`，于是
 * `native: missing` 而构建一切正常）。所以这里连名字都不重命名一遍，直接照抄。
 */
export interface NativeNotifications {
  notificationsAuthorizationStatus(): Promise<string>;
  notificationsRequestAuthorization(options: readonly string[]): Promise<string>;
  notificationsRegisterForRemoteNotifications(): Promise<void>;
  notificationsRegisterCategories(json: string): Promise<void>;
  notificationsResolvePresentation(json: string): Promise<void>;
  notificationsSetBadgeCount(count: number): Promise<void>;
  notificationsTakePendingOpen(): Promise<Record<string, unknown> | null>;
  addListener(
    event: NotificationEventName,
    listener: (payload: unknown) => void,
  ): NotificationSubscription;
}

const REQUIRED_METHODS: readonly (keyof NativeNotifications)[] = [
  'notificationsAuthorizationStatus',
  'notificationsRequestAuthorization',
  'notificationsRegisterForRemoteNotifications',
  'notificationsRegisterCategories',
  'notificationsResolvePresentation',
  'notificationsSetBadgeCount',
  'notificationsTakePendingOpen',
  'addListener',
];

/** 能力探测：模块在 + 需要的方法都在（老构建里模块在、方法不在）。 */
function isNotificationCapable(module: unknown): module is NativeNotifications {
  if (typeof module !== 'object' || module === null) return false;
  const candidate = module as Record<string, unknown>;
  return REQUIRED_METHODS.every((name) => typeof candidate[name] === 'function');
}

let resolved = false;
let facade: NativeNotifications | null = null;

export function nativeNotifications(): NativeNotifications | null {
  if (resolved) return facade;
  resolved = true;
  if (Platform.OS !== 'ios') return null;
  try {
    const module = requireOptionalNativeModule<unknown>('MemohKit');
    if (module === null || module === undefined) return null;
    if (isNotificationCapable(module)) {
      facade = module;
      return facade;
    }
  } catch {
    return null;
  }
  return null;
}
