import { requireNativeView, requireOptionalNativeModule } from 'expo';
import React, { useState, type ComponentType } from 'react';
import { Platform, Text, View, type ViewProps } from 'react-native';

/**
 * 原生外观页（SwiftUI Form）的薄壳。
 *
 * 状态所有者仍是 RN 侧 `ThemeProvider`：这里把 `mode` 与全部可见文案作为 prop 下发，
 * 原生只回事件。`onModeChange` 的载荷只会是 `system | light | dark | oled` 之一
 * （原生侧出口已过滤），但调用方仍应校验后再交给 `setMode`。
 */
export interface NativeAppearanceViewProps extends ViewProps {
  mode: string;
  /** 页标题（导航栏大标题）。 */
  title: string;
  /** 明暗三选一的分组标题。 */
  sectionTitle: string;
  /** 返回按钮的 VoiceOver 标签。 */
  backLabel: string;
  systemLabel: string;
  lightLabel: string;
  darkLabel: string;
  trueBlackLabel: string;
  trueBlackFooter: string;
  onModeChange?: (event: { nativeEvent: { mode?: string } }) => void;
  onBack?: (event: { nativeEvent: Record<string, never> }) => void;
  unavailableLabel?: string;
}

let resolved = false;
let NativeView: ComponentType<NativeAppearanceViewProps> | null = null;

function resolveView() {
  if (resolved) return NativeView;
  resolved = true;
  if (Platform.OS !== 'ios') return null;
  try {
    const module = requireOptionalNativeModule('MemohKit');
    // Expo registers host views lazily: module presence alone cannot prove a view exists.
    const runtime = globalThis as typeof globalThis & {
      expo?: { getViewConfig?: (module: string, view: string) => unknown };
    };
    if (module && runtime.expo?.getViewConfig?.('MemohKit', 'NativeAppearanceView')) {
      NativeView = requireNativeView('MemohKit', 'NativeAppearanceView');
    }
  } catch {
    // An older dev client may not contain the native module yet.
  }
  return NativeView;
}

export function NativeAppearanceView({
  unavailableLabel = 'Native appearance unavailable. Rebuild the iOS app.',
  ...props
}: NativeAppearanceViewProps) {
  // Resolve once on first render: resolving during render would look like a new component type.
  const [Component] = useState(() => resolveView());
  if (Component) {
    return <Component {...props} />;
  }
  // Availability notice only; the RN appearance UI was removed with the migration.
  return (
    <View style={props.style} testID="native-appearance-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
