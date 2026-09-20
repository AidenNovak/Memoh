/**
 * 通知子页的 RN 薄桥（从设置 push 进来）。
 *
 * ## 边界
 *
 * **原生持有**导航标题/返回按钮、权限分组、三行投递政策、系统设置入口，以及直接打开本
 * App 的 iOS 设置页（`UIApplication.openSettingsURLString`）。**RN 暂时保留**路由、
 * i18n 文案，以及**权限判据本身**：冷启动只读状态、只有用户点击才请求——都走
 * `features/notifications/bridge.ts` 的 `ensurePermission`。
 *
 * ## 这一页回答什么
 *
 * iOS 的通知开关只有"全开/全关"，用户在这里能回答的两个问题是 App 该回答的：
 *
 * 1. **什么时候会打扰我**——只有三件事（等你批准 / 跑完一轮 / 一轮失败），且只在你
 *    离开 App 的时候。这不是承诺清单，是可执行的判据：那三条写在
 *    `features/notifications/policy.ts` 里，界面这一页读的就是同一份。
 * 2. **去哪儿改**——权限、横幅、声音、专注模式都在 iOS 设置里，App 自己改不了。
 *
 * ## 为什么三类事件不是三个开关
 *
 * 页面里的三行是明确的投递政策，不是假开关。当前唯一开关是 iOS 系统通知权限；在没有
 * 跨设备同步的服务端偏好之前，再画三枚只在本机生效的开关会造成设置漂移。每一行右侧
 * 显示它**会以什么力度打扰**（标准 / 时效性），那股力度也是判据的一部分。
 *
 * 这页的文案里没有"推送"这个词：用户关心的是"你会不会烦我"，不是走哪条通道。
 */
import {
  NativeNotificationsView,
  symbolName,
  type NativeNotificationsViewModel,
} from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';

import { ensurePermission } from '../features/notifications/bridge.ts';
import {
  EVENT_COPY,
  NOTIFICATION_EVENTS,
  interruptionLevelFor,
  type InterruptionLevel,
} from '../features/notifications/policy.ts';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

/** 打扰力度的显示名。封闭集合用字典映射，不叠三元（`AGENTS.md`）。 */
const LEVEL_LABEL_KEY: Record<InterruptionLevel, string> = {
  passive: 'notifications.level.passive',
  active: 'notifications.level.active',
  timeSensitive: 'notifications.level.timeSensitive',
};

export function NotificationsScreen() {
  const t = useT();
  const router = useRouter();
  const { mode } = useTheme();

  /**
   * 系统授权状态。只影响**一行**：还没被问过时才给"开启通知"。
   *
   * 为什么这一行必须存在：一个从没请求过授权的 App，在 iOS 设置里**根本没有"通知"这一项**
   * ——所以下面那条通往系统设置的路径对未授权用户是空目标（这个差异不是 bug）。用户在
   * 这页看到的唯一有意义动作就是把它要过来。
   */
  const [needsPermission, setNeedsPermission] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ensurePermission('cold_start').then((outcome) => {
      if (cancelled) return;
      // `cold_start` 只用来**读**当前状态，不请求任何东西（冷启动不问是判据的第一条）。
      setNeedsPermission(outcome.status === 'notDetermined');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 用户主动要：这时才真去请求系统授权（`user_asked`）。
   *
   * 结果不回写到界面文案里：系统框出现/不出现本身就是回答，而"没给"之后这一行会消失
   * （被拒 = 已经定了，判据不许再缠）。写一句"你拒绝了"只多一次打扰。
   */
  const requestPermission = useCallback(() => {
    void ensurePermission('user_asked').then((outcome) => {
      setNeedsPermission(outcome.status === 'notDetermined');
    });
  }, []);

  /**
   * 返回。深链直达 / 状态恢复成栈底时没有上一页，兜底回落到设置主页（与外观页同一处理）。
   */
  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);

  const viewModel: NativeNotificationsViewModel = {
    title: t('notifications.title'),
    backLabel: t('common.back'),
    enable: needsPermission
      ? {
          header: t('notifications.enable.header'),
          row: t('notifications.enable.row'),
          footer: t('notifications.enable.footer'),
        }
      : null,
    eventsHeader: t('notifications.events.header'),
    // 三行来自 policy 这一份真源，不在原生里复制/重新发明投递政策。
    events: NOTIFICATION_EVENTS.map((event) => ({
      id: event,
      symbol: symbolName(EVENT_COPY[event].icon),
      title: t(EVENT_COPY[event].titleKey),
      subtitle: t(EVENT_COPY[event].subtitleKey),
      value: t(LEVEL_LABEL_KEY[interruptionLevelFor(event)]),
    })),
    eventsFooter: t('notifications.events.footer'),
    systemHeader: t('notifications.system.header'),
    systemRow: t('notifications.system.row'),
    systemFooter: t('notifications.system.footer'),
  };

  return (
    <NativeNotificationsView
      style={{ flex: 1 }}
      mode={mode}
      viewModelJson={JSON.stringify(viewModel)}
      onRequestPermission={requestPermission}
      onBack={handleBack}
    />
  );
}
