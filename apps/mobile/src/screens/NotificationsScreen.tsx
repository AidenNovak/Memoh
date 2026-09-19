/**
 * 通知子页（从设置 push 进来）。
 *
 * ## 这一页回答什么
 *
 * iOS 的通知开关只有"全开/全关"，用户在这里能回答的两个问题是 App 该回答的：
 *
 * 1. **什么时候会打扰我**——只有三件事（等你批准 / 跑完一轮 / 一轮失败），且只在你
 *    离开 App 的时候。这不是承诺清单，是可执行的判据：那三条写在
 *    `features/notifications/policy.ts` 里并被测试钉着，界面这一页读的就是同一份。
 * 2. **去哪儿改**——权限、横幅、声音、专注模式都在 iOS 设置里，App 自己改不了，所以给
 *    一条直接打开本 App 系统设置页的路径（HIG *Managing notifications* 要求 App 必须
 *    提供可改的地方，而不是只在首次弹框时问一句）。
 *
 * ## 为什么现在还没有开关
 *
 * 页面里的三行**不是**开关，是说明。开关要有东西承接：真正的投递要 APNs 凭据 + 服务端
 * 发送方 + 原生通知模块，三样都还没接上。现在画三个拨不动的开关（或拨了没效果的开关）
 * 是在骗用户——而"设置里有个开关但没生效"是这类 App 最容易招骂的一种。
 * 每一行右侧显示的是它**会以什么力度打扰**（标准 / 时效性），那股力度也是判据的一部分。
 *
 * ## 顺带一提
 *
 * 这页的文案里没有"推送"这个词：用户关心的是"你会不会烦我"，不是走哪条通道。
 */
import { SymbolView } from 'expo-symbols';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ensurePermission } from '../features/notifications/bridge.ts';
import {
  EVENT_COPY,
  NOTIFICATION_EVENTS,
  interruptionLevelFor,
  type InterruptionLevel,
  type NotificationEvent,
} from '../features/notifications/policy.ts';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { BackButton } from '../ui/BackButton.tsx';
import { Group, Row } from '../ui/GroupedList.tsx';

/** 打扰力度的显示名。封闭集合用字典映射，不叠三元（`AGENTS.md`）。 */
const LEVEL_LABEL_KEY: Record<InterruptionLevel, string> = {
  passive: 'notifications.level.passive',
  active: 'notifications.level.active',
  timeSensitive: 'notifications.level.timeSensitive',
};

export function NotificationsScreen() {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  /**
   * 系统授权状态。只影响**一行**：还没被问过时才给"开启通知"。
   *
   * 为什么这一行必须存在：一个从没请求过授权的 App，在 iOS 设置里**根本没有"通知"
   * 这一项**——所以下面那条通往系统设置的路径对未授权用户是空目标（上一轮文档里
   * 已经写明这个差异不是 bug）。用户在这页看到的唯一有意义动作就是把它要过来。
   *
   * 判据仍在 `features/notifications/bridge.ts`（→ `policy.permissionActionFor`）：
   * 被拒之后这里不会再出现，冷却与封顶也归它管。这页只负责"请求这件事由用户发起"。
   */
  const [needsPermission, setNeedsPermission] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ensurePermission('cold_start').then((outcome) => {
      if (cancelled) return;
      // `cold_start` 只会得到 `nothing` 或（被拒时的）`nothing`——这条调用只用来
      // 读当前状态，不请求任何东西（冷启动不问是判据的第一条）。
      setNeedsPermission(outcome.status === 'notDetermined');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 用户主动要：这时才真去请求系统授权（`user_asked`）。
   *
   * 结果不回写到界面文案里：系统框出现/不出现本身就是回答，而"没给"之后这一行会
   * 消失（被拒 = 已经定了，判据不许再缠）。写一句"你拒绝了"只多一次打扰。
   */
  const requestPermission = useCallback(() => {
    void ensurePermission('user_asked').then((outcome) => {
      setNeedsPermission(outcome.status === 'notDetermined');
    });
  }, []);

  /**
   * 打开本 App 的系统设置页。
   *
   * 失败也不提示：这个动作的失败形态只有"系统设置没打开"，用户看到的就是没反应，
   * 再弹一个"打开失败"的错误框只会多一次打扰。而且 iOS 上这条几乎不会失败。
   */
  const openSystemSettings = useCallback(() => {
    void Linking.openSettings().catch(() => undefined);
  }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.sm,
        paddingBottom: insets.bottom + spacing.xxl,
        paddingHorizontal: GROUP_INSET,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: GROUP_INSET,
          marginBottom: spacing.md,
        }}
      >
        <BackButton testID="notifications-back" fallback="/settings" />
        <Text style={[typography.title2, { color: palette.label, flex: 1 }]}>
          {t('notifications.title')}
        </Text>
      </View>

      {needsPermission ? (
        <Group header={t('notifications.enable.header')} footer={t('notifications.enable.footer')}>
          <Row
            testID="notifications-enable"
            title={t('notifications.enable.row')}
            disclosure
            last
            onPress={requestPermission}
          />
        </Group>
      ) : null}

      <Group header={t('notifications.events.header')} footer={t('notifications.events.footer')}>
        {NOTIFICATION_EVENTS.map((event: NotificationEvent, index: number) => (
          <Row
            key={event}
            testID={`notifications-event-${event}`}
            icon={
              <SymbolView
                name={EVENT_COPY[event].icon}
                size={17}
                tintColor={palette.secondaryLabel}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            }
            title={t(EVENT_COPY[event].titleKey)}
            subtitle={t(EVENT_COPY[event].subtitleKey)}
            value={t(LEVEL_LABEL_KEY[interruptionLevelFor(event)])}
            last={index === NOTIFICATION_EVENTS.length - 1}
          />
        ))}
      </Group>

      <Group header={t('notifications.system.header')} footer={t('notifications.system.footer')}>
        <Row
          testID="notifications-system-settings"
          title={t('notifications.system.row')}
          disclosure
          last
          onPress={openSystemSettings}
        />
      </Group>
    </ScrollView>
  );
}
