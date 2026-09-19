/**
 * policy 的判定 → 前台呈现选项名。
 *
 * ## 为什么这一层要存在（而不是让原生自己判断）
 *
 * 前台要不要弹横幅是**判据**，判据在 `policy.ts`。原生那侧只认识系统的 flag
 * （`UNNotificationPresentationOptions`），中间必须有一步翻译；把翻译放在 JS 这边，
 * 桥就彻底没有"自己的意见"——它把名字翻成 flag，仅此而已。
 *
 * ## 三个判定分别翻成什么
 *
 * | policy 判定 | 前台呈现 | 为什么 |
 * | --- | --- | --- |
 * | `notify` | banner + list + sound | 交给系统弹（`deliveryFor` 只在 App 不在前台时给这个结果） |
 * | `in_app` | 什么都不弹 | 前台不弹横幅，由界面接住（HIG：通知在前台不出现） |
 * | `drop` | 什么都不弹 | 连界面里都不必强调 |
 *
 * 注意 `notify` 那一行在前台**用不到**（`willPresent` 只在 App 在前台时触发），
 * 留着它是为了让这张表是"判定的完整翻译"，而不是"前台那两种情况"——否则以后有人
 * 复用这张表时会撞上一个缺项的字典。
 */

import type { DeliveryDecision } from './policy.ts';

/** 与原生 `NotificationContract.PresentationOption` 的封闭集合一致。 */
export type PresentationOption = 'banner' | 'list' | 'sound' | 'badge';

export const PRESENTATION_OPTIONS: Record<DeliveryDecision, readonly PresentationOption[]> = {
  notify: ['banner', 'list', 'sound'],
  in_app: [],
  drop: [],
};

export function presentationOptionsFor(decision: DeliveryDecision): readonly PresentationOption[] {
  return PRESENTATION_OPTIONS[decision];
}

/** 原生 `notificationsResolvePresentation(json)` 的入参。跨桥只传字符串。 */
export function presentationResolution(requestId: string, decision: DeliveryDecision): string {
  return JSON.stringify({
    requestId,
    options: presentationOptionsFor(decision),
  });
}
