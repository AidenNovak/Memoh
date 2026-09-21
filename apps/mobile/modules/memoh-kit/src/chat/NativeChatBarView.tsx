import React, { useState } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

/**
 * Chat 底栏（队列条 + 待发条 + 斜杠菜单 + 模型胶囊 + 输入行）的 SwiftUI 薄壳。
 *
 * 状态所有者仍是 RN：队列里是哪几条、能不能插话、斜杠菜单命中什么、草稿与发送/停止的
 * 判据，都在 `screens/ChatScreen.tsx` 一侧算好，以一份 JSON 视图模型下发；原生只画并
 * 回事件——**原生不认识 bot、i18n、路由和服务端协议**。
 *
 * 与顶栏同理：它是嵌入条带，高度随内容变（输入框 1→5 行、队列增删），Yoga 不会按原生
 * 内容给高，所以要靠 `onHeight` 把理想高报回来给宿主设 `style.height`。
 */

/** 队列里的一条待发内容。 */
export interface NativeChatBarQueueItem {
  /** 回给 RN 用（`onQueueSteer` / `onQueueRemove` 的载荷）。 */
  id: string;
  /** 类别标签（"插队"之类）；空串 = 不画。 */
  kindLabel: string;
  /** 正文，原生最多画 2 行。 */
  text: string;
  /** 这条现在能不能插话；false 时原生不画插话按钮。 */
  canSteer: boolean;
  steerLabel: string;
  /** 删除钮的读屏文案（✕ 本身没有文字）。 */
  removeLabel: string;
}

/** 队列块；整个 `queue` 键缺省或为 null = 这块不画。 */
export interface NativeChatBarQueue {
  items: NativeChatBarQueueItem[];
  /** "还有 N 条"之类；空串 = 没有这一行。 */
  hiddenLabel: string;
  /** 队列自己的错误行；空串 = 不画。 */
  error: string;
}

/** 待发块（等确认 / 等重连）；整个 `pending` 键缺省或为 null = 这块不画。 */
export interface NativeChatBarPending {
  text: string;
  /** 细因；空串 = 不画第二行。 */
  reason: string;
  /** 空串 = 没有可点的动作按钮。 */
  action: 'retry' | 'reconnect' | '';
  actionLabel: string;
  actionHint: string;
  /** `error` = 发送失败（主行与动作改红色）；缺省按 `info`。 */
  tone?: 'info' | 'error';
}

/** 斜杠菜单里的一项。 */
export interface NativeChatBarSlashItem {
  /** 菜单项的 id（`skill:xxx` 之类），原生只当 key 用。 */
  id: string;
  /** 选中时回传的值（`SlashItem.name`，**不带** `/`；内置动作也是它）。 */
  name?: string;
  /** 主文案（含 `/`）。 */
  label: string;
  description: string;
}

/** 斜杠块；整个 `slash` 键缺省或为 null = 这块不画。 */
export interface NativeChatBarSlash {
  items: NativeChatBarSlashItem[];
  /** 清单拉取失败时的标题；空串 = 不画失败块。 */
  failureTitle: string;
  failureBody: string;
  retryLabel: string;
}

/**
 * `ChatBarModel`（spec §2.2）。
 *
 * `queue` / `pending` / `slash` 三个块**可整块缺省或为 null**（原生 `decodeIfPresent`）：
 * 缺省 = 那块不画。其余键必填——RN 每次都写全。
 */
export interface NativeChatBarModel {
  queue?: NativeChatBarQueue | null;
  pending?: NativeChatBarPending | null;
  slash?: NativeChatBarSlash | null;
  /** 模型胶囊文案（当前模型名）。 */
  pillLabel: string;
  /** 胶囊的读屏文案（RN 拼好"选择模型，X"）。 */
  pillA11y: string;
  /** false = 整条输入行不画（胶囊行还在）。 */
  inputVisible: boolean;
  /** 受控草稿：输入框的值来自这里，击键通过 `onField` 回去。 */
  draft: string;
  placeholder: string;
  /** 发送错误就地一行；空串 = 不画。 */
  sendError: string;
  /** false 时发送钮是禁用样式（原生不判，照 `buttonGlyph` 画）。 */
  canSend: boolean;
  /** 只可能是 `↑`（发送/排队）或 `■`（停止）——RN 已判好。 */
  buttonGlyph: '↑' | '■';
  buttonA11y: string;
}

export interface NativeChatBarViewProps extends ViewProps {
  /** 主题模式 `system | light | dark | oled`。 */
  mode: string;
  /** `JSON.stringify(NativeChatBarModel)`。 */
  modelJson: string;
  /** 输入框每次击键：`{ draft }`。 */
  onField?: (event: { nativeEvent: { draft?: string } }) => void;
  onSend?: (event: { nativeEvent: Record<string, never> }) => void;
  onStop?: (event: { nativeEvent: Record<string, never> }) => void;
  /** 点模型胶囊。 */
  onPill?: (event: { nativeEvent: Record<string, never> }) => void;
  onQueueRemove?: (event: { nativeEvent: { id?: string } }) => void;
  onQueueSteer?: (event: { nativeEvent: { id?: string } }) => void;
  /** 待发块的动作：`{ action }` 为 `retry` / `reconnect`。 */
  onPendingAction?: (event: { nativeEvent: { action?: string } }) => void;
  /** 选中一条斜杠命令：`{ name }` 是 `SlashItem.name`，**不带** `/`。 */
  onSlashPick?: (event: { nativeEvent: { name?: string } }) => void;
  onSlashRetry?: (event: { nativeEvent: Record<string, never> }) => void;
  /**
   * 原生量出的理想高（pt）。宿主据此设 `style.height`——条带不是 `flex: 1`，
   * 不给高就会是 0 或者被压扁。
   */
  onHeight?: (event: { nativeEvent: { height?: number } }) => void;
  unavailableLabel?: string;
}

export function NativeChatBarView({
  unavailableLabel = 'Native chat composer unavailable. Rebuild the iOS app.',
  ...props
}: NativeChatBarViewProps) {
  // 首次 render 时 resolve 一次并固定下来：在 render 期现算会被当成"每次渲染新建组件"。
  const [Component] = useState(() =>
    resolveMemohNativeView<NativeChatBarViewProps>('NativeChatBarView'),
  );
  if (Component) {
    return <Component {...props} />;
  }
  // Availability notice only, never a second renderer for the composer.
  return (
    <View style={props.style} testID="native-chat-bar-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
