import React, { useState } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

/**
 * Chat 顶栏（返回 / 标题 / 机器 / 信息）+ notices 横条的 SwiftUI 薄壳。
 *
 * 状态所有者仍是 RN：标题与副标题怎么拼、notices 出哪几条、哪颗按钮可点，都在
 * `screens/ChatScreen.tsx` 一侧算好，以一份 JSON 视图模型下发；原生只画并回事件——
 * **原生不认识 bot、i18n 和路由**。
 *
 * 与那些满屏原生页不同，这条带子是**嵌**在 RN flex 布局里的条带，高度随内容变
 * （notices 增删、Dynamic Type），而 Yoga 不会按原生内容给高。所以它比其它薄壳多一个
 * `onHeight` 回授：宿主拿它设 `style.height`，原生那边算好理想高再报上来。
 */

/** notices 里的一条横条（运行失败、掉线重连之类）。 */
export interface NativeChatChromeNotice {
  /** 回给 RN 用（`onNoticeAction` 的载荷）；同时作为 accessibilityIdentifier。 */
  id: string;
  /** 语气：`info` 走次级字色，`error` 主行走 destructive。 */
  tone: 'info' | 'error';
  text: string;
  /** 第二行细因；空串 = 不画这一行。 */
  detail: string;
  /**
   * 空串 = 整行不可点；非空 = 整行可点（目前只会出现 `retryOlder` / `reconnect`）。
   *
   * 这条是"RN 判好、原生只画"的关键：原生不去猜哪个动作现在有意义。
   */
  action: string;
  /** `action` 非空时行尾显示的按钮文案（accent 色）。 */
  actionLabel: string;
  /** 整行的读屏文案（已由 RN 把 text 与 detail 拼好）。 */
  a11y: string;
}

/**
 * `ChatChromeModel`（spec §2.1）。
 *
 * 所有键都是必填：RN 每次都写全，原生侧另有 `decodeIfPresent ?? 默认` 兜底，坏 JSON 时
 * 保留上一份有效模型。这里不把"原生有默认值"重复表达成可选字段，免得调用方以为可以不写。
 */
export interface NativeChatChromeModel {
  title: string;
  /** 次级行（bot 名 · 生成状态）；空串 = 不画。 */
  subtitle: string;
  /** 标题后的过期提示（warning 色）；空串 = 不占位。 */
  staleLabel: string;
  /** 标题按钮的读屏文案。 */
  titleA11y: string;
  /** 标题按钮的读屏提示（"按了能看会话信息"）。 */
  titleHint: string;
  backLabel: string;
  showMachine: boolean;
  machineLabel: string;
  showInfo: boolean;
  infoLabel: string;
  notices: NativeChatChromeNotice[];
}

export interface NativeChatChromeViewProps extends ViewProps {
  /** 主题模式 `system | light | dark | oled`。 */
  mode: string;
  /** `JSON.stringify(NativeChatChromeModel)`。 */
  modelJson: string;
  onBack?: (event: { nativeEvent: Record<string, never> }) => void;
  onOpenInfo?: (event: { nativeEvent: Record<string, never> }) => void;
  onOpenMachine?: (event: { nativeEvent: Record<string, never> }) => void;
  /** 点了一条可点 notice：`{ id }` 就是那条 notice 的 id。 */
  onNoticeAction?: (event: { nativeEvent: { id?: string } }) => void;
  /**
   * 原生量出的理想高（pt）。宿主据此设 `style.height`——条带不是 `flex: 1`，
   * 不给高就会是 0 或者被压扁。
   */
  onHeight?: (event: { nativeEvent: { height?: number } }) => void;
  unavailableLabel?: string;
}

export function NativeChatChromeView({
  unavailableLabel = 'Native chat header unavailable. Rebuild the iOS app.',
  ...props
}: NativeChatChromeViewProps) {
  // 首次 render 时 resolve 一次并固定下来：在 render 期现算会被当成"每次渲染新建组件"。
  const [Component] = useState(() =>
    resolveMemohNativeView<NativeChatChromeViewProps>('NativeChatChromeView'),
  );
  if (Component) {
    return <Component {...props} />;
  }
  // Availability notice only, never a second renderer for the header.
  return (
    <View style={props.style} testID="native-chat-chrome-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
