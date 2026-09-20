import React, { useState } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

/**
 * 原生设置页（SwiftUI inset-grouped `Form`）的薄壳。
 *
 * 状态所有者仍是 RN：会话/bot、主题模式、i18n 与路由都在这一侧。这里把 RN 用既有 helper
 * 算好的视图模型（JSON）与主题模式下发，原生只画并回事件——**原生不认识 bot、i18n 和路由**。
 */
export interface NativeSettingsAvatar {
  kind: 'mark' | 'builtin' | 'remote';
  /** `builtin` 时的 SF Symbol 名（来自 `features/bots/avatarPresets.ts`）。 */
  symbol?: string;
  /**
   * `remote` 时的图片地址。
   *
   * **不会是 `memoh:` 这类内部标识**：那类值由 `avatarFor` 归一化成 `builtin` 或 `mark`，
   * 原生不会为它发一个注定失败的请求。
   */
  uri?: string;
  /** 当前实时连接是否已恢复；原生远程头像失败后据此最多重试一次。 */
  connectionOpen: boolean;
}

export interface NativeSettingsAgent {
  header: string;
  name: string;
  /** 状态徽章文案；空串 = 不显示徽章。 */
  statusLabel: string;
  statusColor: 'success' | 'warning' | 'muted';
  /** 时区 / 待审批条数，已用 ` · ` 连好；空串 = 不显示副标题。 */
  subtitle: string;
  /** VoiceOver 提示（"这是个按钮，按了能换"）。 */
  hint: string;
  avatar: NativeSettingsAvatar;
}

export interface NativeSettingsViewModel {
  title: string;
  agent: NativeSettingsAgent;
  /** 有 `manage` 权限时才有（`features/bots/permissions.ts`）；null = 不渲染这一行。 */
  botSettingsTitle: string | null;
  appearance: { header: string; title: string; value: string };
  language: {
    header: string;
    options: { id: string; label: string; selected: boolean }[];
  };
  notifications: { title: string; footer: string };
  account: {
    header: string;
    /** 空串 = 不显示身份行。 */
    name: string;
    role: string;
    signOutTitle: string;
    signOutMessage: string;
    cancelLabel: string;
  };
  about: {
    header: string;
    versionLabel: string;
    /** 空串 = 不显示版本行。 */
    versionValue: string;
    serverLabel: string;
    serverValue: string;
  };
}

export interface NativeSettingsViewProps extends ViewProps {
  /** 主题模式 `system | light | dark | oled`；权威状态在 RN `ThemeProvider`。 */
  mode: string;
  viewModelJson: string;
  onOpenAgentSwitcher?: (event: { nativeEvent: Record<string, never> }) => void;
  onOpenBotSettings?: (event: { nativeEvent: Record<string, never> }) => void;
  onOpenAppearance?: (event: { nativeEvent: Record<string, never> }) => void;
  onSelectLocale?: (event: { nativeEvent: { locale?: string } }) => void;
  onOpenNotifications?: (event: { nativeEvent: Record<string, never> }) => void;
  onSignOut?: (event: { nativeEvent: Record<string, never> }) => void;
  unavailableLabel?: string;
}

export function NativeSettingsView({
  unavailableLabel = 'Native settings unavailable. Rebuild the iOS app.',
  ...props
}: NativeSettingsViewProps) {
  // 首次 render 时 resolve 一次并固定下来：在 render 期现算会被当成"每次渲染新建组件"。
  const [Component] = useState(() =>
    resolveMemohNativeView<NativeSettingsViewProps>('NativeSettingsView'),
  );
  if (Component) {
    return <Component {...props} />;
  }
  // Availability notice only; the RN settings list was removed with the migration.
  return (
    <View style={props.style} testID="native-settings-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
