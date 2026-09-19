/**
 * 推送链路的运行时内部状态（仅开发构建，从 `/debug` 进）。
 *
 * ## 为什么这页存在
 *
 * 这条链路的每一步都是**静默**的：授权状态、分类有没有注册上、前台来了一条通知被判成
 * 什么、冷启动那次点击到了没有、token 拿到没有、注册远程通知为什么失败——全都不会在
 * 产品界面上露出来（这正是它们该待的地方）。没有这一页，"推送没反应"就只有一个结论
 * 可用：猜。
 *
 * 它是 `AGENTS.md` 说的那类东西：故障注入与运行时内部状态只放在 dev-only 的 `/debug`。
 * 产品屏幕上不会出现这里的任何一个词。
 *
 * ## 这里不显示 token 本身
 *
 * 只显示"有没有拿到、多长"（`registration.describeToken`）。device token 是能直接向这台
 * 设备投递的凭据，进截图、进日志都不行。
 */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ensurePermission,
  notificationBridgeState,
  readRegisteredCategories,
  simulateNotificationOpen,
  subscribeNotificationBridge,
  type BridgeState,
} from '../features/notifications/bridge.ts';
import { notificationsDiagnostics } from '@memoh-ios/kit';
import { approvalOptionIdFor } from '../features/notifications/openRouting.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

function line(label: string, value: string, palette: ReturnType<typeof usePalette>) {
  return (
    <View key={label} style={{ marginBottom: 6 }}>
      <Text style={{ color: palette.secondaryLabel, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: palette.label, fontSize: 14 }} testID={`debug-push-${label}`}>
        {value}
      </Text>
    </View>
  );
}

/** 展示用的文字拼装：用 if 而不是三元（`AGENTS.md` 禁止嵌套三元）。 */
function describeOpen(open: BridgeState['lastOpen']): string {
  if (open === null) return 'none';
  if (open.approvalId === null) return `${open.action} → ${open.sessionId}`;
  return `${open.action} → ${open.sessionId} / ${open.approvalId}`;
}

function describeDelivery(delivery: BridgeState['lastDelivery']): string {
  if (delivery === null) return 'none';
  const event = delivery.event === null ? 'unknown' : delivery.event;
  return `${event} → ${delivery.decision} (${delivery.sessionId})`;
}

function approvalAnswerFor(open: BridgeState['lastOpen']): string {
  if (open === null) return '—';
  const optionId = approvalOptionIdFor(open);
  if (optionId === null) return 'none';
  return optionId;
}

export function DebugNotificationsScreen() {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<BridgeState>(notificationBridgeState());

  useEffect(() => subscribeNotificationBridge(setState), []);

  /**
   * 顺手把**系统那边**记着的分类读回来（注册是"写出去没有回执"的调用，读回来才看得见
   * 有没有生效）。这一行就是"动作按钮为什么没出现"的第一现场。
   */
  useEffect(() => {
    void readRegisteredCategories();
  }, []);

  const delivery = state.lastDelivery;
  const open = state.lastOpen;
  const shownOpen = describeOpen(open);
  const shownDelivery = describeDelivery(delivery);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ padding: spacing.lg, paddingTop: insets.top + spacing.lg }}
    >
      <Text style={[typography.title2, { color: palette.label }]}>Push state</Text>
      <Text
        style={[typography.footnote, { color: palette.secondaryLabel, marginBottom: spacing.lg }]}
      >
        推送链路只有开发构建里能看到的状态。判据（何时打扰/前台弹不弹/徽标）在
        features/notifications/policy.ts，这里只是它执行后的痕迹。
      </Text>

      {line('native', state.available ? 'MemohKit present' : 'missing (old dev client)', palette)}
      {line('nativeWhy', notificationsDiagnostics(), palette)}
      {line('authorization', state.status, palette)}
      {line('asked', `count ${state.history.askedCount}`, palette)}
      {line('lastDelivery', shownDelivery, palette)}
      {line('lastOpen', shownOpen, palette)}
      {line('answerToApproval', approvalAnswerFor(open), palette)}
      {line('deviceToken', state.token, palette)}
      {line('categories', state.categories === '' ? 'not registered' : state.categories, palette)}
      {line('registration', state.lastFailure ?? 'ok', palette)}

      <Pressable
        accessibilityRole="button"
        testID="debug-push-request-permission"
        onPress={() => {
          void ensurePermission('user_asked');
        }}
        style={{ minHeight: 44, justifyContent: 'center', marginTop: spacing.md }}
      >
        <Text style={{ color: palette.accent, fontSize: 16 }}>
          请求通知权限（user_asked，走判据）
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="debug-push-refresh"
        onPress={() => void ensurePermission('cold_start')}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: palette.accent, fontSize: 16 }}>重读授权状态（cold_start）</Text>
      </Pressable>

      {/*
        这两条是**故障注入**：系统通知上的动作按钮不在 App 无障碍树里（simctl 没有触摸
        注入，Maestro 也够不到 SpringBoard 上的按钮），所以"点『允许』之后整条链路对不对"
        只能从同一个入口把事件喂进来。除了原生那一跳，走的是完全相同的代码。
      */}
      <Pressable
        accessibilityRole="button"
        testID="debug-push-open-approval"
        onPress={() =>
          simulateNotificationOpen({
            sessionId: 'fixture-session-untitled',
            approvalId: 'scene-approval-2',
            action: 'opened',
            event: 'approval_waiting',
            recipientUserId: 'fixture-user',
          })
        }
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: palette.accent, fontSize: 16 }}>注入：点通知本体（opened）</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="debug-push-allow-approval"
        onPress={() =>
          simulateNotificationOpen({
            sessionId: 'fixture-session-untitled',
            approvalId: 'scene-approval-2',
            action: 'allow',
            event: 'approval_waiting',
            recipientUserId: 'fixture-user',
          })
        }
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: palette.accent, fontSize: 16 }}>注入：点「允许」（allow）</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="debug-push-foreign-approval"
        onPress={() =>
          simulateNotificationOpen({
            sessionId: 'fixture-session-untitled',
            approvalId: 'scene-approval-2',
            action: 'allow',
            event: 'approval_waiting',
            recipientUserId: 'someone-else',
          })
        }
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: palette.accent, fontSize: 16 }}>注入：别的账号的通知（不该动）</Text>
      </Pressable>
    </ScrollView>
  );
}
