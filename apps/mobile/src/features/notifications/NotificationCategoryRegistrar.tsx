/**
 * 注册通知分类（审批那两个动作）。**挂在登录闸门外面**，App 一起来就注册。
 *
 * ## 为什么不能等登录之后（本轮实测踩到的坑）
 *
 * 之前在 `startNotificationBridge` 里注册，而那个桥挂在 `SessionProvider` 里面——也就是
 * **登录之后**。后果是：App 没登录、或用户没打开过 App 时收到推送，iOS 端根本不知道
 * `approval` 这个分类，那条通知就**没有"允许/拒绝"两个按钮**（分类在投递那一刻就要
 * 匹配上，事后再注册补不回来）。
 *
 * 于是第一次验收看到的形态是：横幅、通知中心、徽标都对，就是没有动作按钮——而按钮正好
 * 是这条链路上最要紧的东西。分类必须**在任何一次启动里**都被注册一次，这样 daemon 那边
 * 才有它，下一次推送才带得上动作。
 *
 * ## 为什么在这里而不是纯模块级调用
 *
 * 文案要跟着语言走（`t`），而语言的当前值住在 i18n 模块里；用组件 + `useT()` 就不必
 * 自己订阅语言变化——语言一变 `t` 就换新，这个 effect 会拿新文案再注册一次。
 */
import { useEffect } from 'react';

import { registerNotificationCategories } from './bridge.ts';
import { useT } from '../../lib/i18n/useT.ts';

export function NotificationCategoryRegistrar() {
  const t = useT();
  useEffect(() => {
    void registerNotificationCategories(t);
  }, [t]);
  return null;
}
