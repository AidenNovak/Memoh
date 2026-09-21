import React, { useState, type ComponentType } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

/**
 * 首启引导（三屏）的原生宿主薄壳。
 *
 * 状态所有者仍是 RN：页序、符号、文案（i18n）、三个按钮标签都在 RN 侧算好，以一份 JSON
 * 契约下发；原生只画、并回事件——**原生不认识 i18n，也不认识路由**。
 *
 * 交互与动效（入场、待机呼吸、翻页淡入上浮、页码点跟着手指连续变化、Reduce Motion 全退化、
 * Dynamic Type 纵向兜底）全在原生侧，判据抄自被替换的 `screens/OnboardingScreen.tsx`。
 */

/** 一页。`symbol` 是 SF Symbol 名，原样过桥（原生不查表）。 */
export interface NativeOnboardingPage {
  id: string;
  symbol: string;
  title: string;
  body: string;
}

export interface NativeOnboardingModel {
  pages: NativeOnboardingPage[];
  /** 右上角「跳过」。最后一页原生不画它。 */
  skipLabel: string;
  nextLabel: string;
  startLabel: string;
  /**
   * 分页器的读屏标签**模板**（`onboarding.progress` 的原文，含 `{{current}}` / `{{total}}`）。
   *
   * 为什么不是拼好的成品：这句话要念出**当前页**，而当前页是原生翻页时才知道的——RN 送不下
   * 一个会自己变的字符串。所以 RN 送模板 + 总页数，由原生替换占位符（契约里唯一一处调整，
   * 两侧都写了原因）。占位符沿用项目自己的 i18n 语法，RN 侧原样下发、不做字符串手术。
   */
  progressFormat: string;
  /** 总页数，与 `pages` 同源（RN 都取 `ONBOARDING_PAGES.length`）。 */
  pageCount: number;
}

export interface NativeOnboardingViewProps extends ViewProps {
  /** 主题模式 `system | light | dark | oled`。 */
  mode: string;
  modelJson: string;
  /** 「跳过」与最后一页的主按钮都发它——下一步去哪由 RN 决定。 */
  onDone?: (event: { nativeEvent: Record<string, never> }) => void;
  unavailableLabel?: string;
}

export function NativeOnboardingView({
  unavailableLabel = 'Native onboarding unavailable. Rebuild the iOS app.',
  ...props
}: NativeOnboardingViewProps) {
  // 首次 render 时 resolve 一次并固定下来：在 render 期现算会被当成"每次渲染新建组件"。
  const [Component] = useState<ComponentType<NativeOnboardingViewProps> | null>(() =>
    resolveMemohNativeView<NativeOnboardingViewProps>('NativeOnboardingView'),
  );
  if (Component) return <Component {...props} />;
  return (
    <View style={props.style} testID="native-onboarding-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
