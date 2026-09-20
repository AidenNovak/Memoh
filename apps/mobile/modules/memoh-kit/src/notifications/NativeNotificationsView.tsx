import React, { useState } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

/**
 * 原生通知页（SwiftUI `Form`）的薄壳。
 *
 * 判据仍在 RN：三行事件与打扰力度来自 `features/notifications/policy.ts`，授权状态来自
 * `features/notifications/bridge.ts` 的 `ensurePermission`。原生只画，并把"用户点了开启"
 * 与"返回"报回来——**原生不自己决定该不该请求权限**。
 */
export interface NativeNotificationsEvent {
  /** 与 `policy.ts` 的 `NotificationEvent` 同一套字面量。 */
  id: string;
  /** SF Symbol 名（`EVENT_COPY[event].icon`）。 */
  symbol: string;
  title: string;
  subtitle: string;
  /** 打扰力度的显示名（标准 / 时效性）。 */
  value: string;
}

export interface NativeNotificationsViewModel {
  title: string;
  backLabel: string;
  /** 只在授权状态是 `notDetermined` 时非 null。 */
  enable: { header: string; row: string; footer: string } | null;
  eventsHeader: string;
  events: NativeNotificationsEvent[];
  eventsFooter: string;
  systemHeader: string;
  systemRow: string;
  systemFooter: string;
}

export interface NativeNotificationsViewProps extends ViewProps {
  /** 主题模式 `system | light | dark | oled`；权威状态在 RN `ThemeProvider`。 */
  mode: string;
  viewModelJson: string;
  /** 用户点了"开启通知"：RN 这才调 `ensurePermission('user_asked')`。 */
  onRequestPermission?: (event: { nativeEvent: Record<string, never> }) => void;
  onBack?: (event: { nativeEvent: Record<string, never> }) => void;
  unavailableLabel?: string;
}

export function NativeNotificationsView({
  unavailableLabel = 'Native notifications unavailable. Rebuild the iOS app.',
  ...props
}: NativeNotificationsViewProps) {
  // 首次 render 时 resolve 一次并固定下来：在 render 期现算会被当成"每次渲染新建组件"。
  const [Component] = useState(() =>
    resolveMemohNativeView<NativeNotificationsViewProps>('NativeNotificationsView'),
  );
  if (Component) {
    return <Component {...props} />;
  }
  // Availability notice only; the RN notifications page was removed with the migration.
  return (
    <View style={props.style} testID="native-notifications-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
