import React, { useState } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

/**
 * bot 设置 / 新建 / 新建进度三屏共用的原生表单（SwiftUI inset-grouped `Form`）薄壳。
 *
 * 状态所有者仍是 RN：取数、差分保存、删除、名称查重、选择器与路由都在 RN 侧算好，
 * 以一份 JSON 视图模型下发；原生只画并回事件——**原生不认识 bot、i18n 和路由**。
 */

/** 头像计划：与 `features/bots/avatar.ts` 的归一化结果一一对应（同设置页）。 */
export interface NativeBotAvatar {
  kind: 'mark' | 'builtin' | 'remote';
  symbol?: string;
  uri?: string;
  connectionOpen: boolean;
}

/** 确认框（返回拦截 / 删除确认）。 */
export interface NativeBotFormConfirm {
  title: string;
  body: string;
  /** 破坏性确认键（Discard / Delete）。 */
  confirmLabel: string;
  /** 中性第三键（Save and leave）；空串 = 没有这一键。 */
  saveLabel: string;
  cancelLabel: string;
}

export interface NativeBotFormRow {
  /** 行 id，同时作为 accessibilityIdentifier（沿用原 testID 值）。 */
  id: string;
  kind: 'text' | 'toggle' | 'nav' | 'radio' | 'info' | 'button' | 'glyph';
  label?: string;
  /** `text` 的当前值 / `nav` 的右侧值 / `info` 的正文 / `radio` 的选项值。 */
  value?: string;
  /** 标题下的次级说明。 */
  hint?: string;
  placeholder?: string;
  /** 事件字段键（text / toggle / radio 用）。 */
  key?: string;
  on?: boolean;
  selected?: boolean;
  /** 行尾 spinner（名称查重中）。 */
  busy?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** `glyph` 的状态符号（✓ ⚠ ✕ ·）。 */
  glyph?: string;
  /** 语气：`ok | warn | bad | muted`。 */
  tone?: string;
  /** 等宽正文（技术细节原文），可选中复制。 */
  mono?: boolean;
  /** `nav` / `button` 的动作 id。 */
  action?: string;
}

export interface NativeBotFormSection {
  id: string;
  header?: string;
  footer?: string;
  /** 危险组：组头标红。 */
  danger?: boolean;
  rows: NativeBotFormRow[];
}

export interface NativeBotFormModel {
  status: 'loading' | 'error' | 'ready';
  title: string;
  /** 页头次级行（bot 的 URL 名）；空串不显示。 */
  subtitle?: string;
  /** 页头头像；缺省 = 没有页头块。 */
  avatar?: NativeBotAvatar;
  /** 标题旁的 spinner（创建进度页）。 */
  spinner?: boolean;
  /** 整页错误态（status === 'error'）。 */
  errorTitle?: string;
  errorBody?: string;
  errorCanRetry?: boolean;
  retryLabel?: string;
  sections?: NativeBotFormSection[];
  /** 底部吸附保存条。 */
  saveBarVisible?: boolean;
  saveBarLabel?: string;
  /** 空串 = 只画提示文字不画按钮。 */
  saveBarButton?: string;
  saveBarBusy?: boolean;
  /** 返回拦截（未保存改动）；缺省 = 直接回。 */
  backGuard?: NativeBotFormConfirm;
  /** action === 'delete' 的按钮行按下时弹的确认框。 */
  deleteConfirm?: NativeBotFormConfirm;
  /** 缺省 true；进度页传 false。 */
  showBack?: boolean;
}

export interface NativeBotFormViewProps extends ViewProps {
  /** 主题模式 `system | light | dark | oled`。 */
  mode: string;
  modelJson: string;
  /** 文本 / 开关 / 单选的变化：`{ key, value }`（开关为 "true" / "false"）。 */
  onField?: (event: { nativeEvent: { key?: string; value?: string } }) => void;
  /** 行动作与确认结果：`save`、`delete`、`back:save`、`back:discard` 或自定义 id。 */
  onAction?: (event: { nativeEvent: { action?: string } }) => void;
  onBack?: (event: { nativeEvent: Record<string, never> }) => void;
  onRetry?: (event: { nativeEvent: Record<string, never> }) => void;
  unavailableLabel?: string;
}

export function NativeBotFormView({
  unavailableLabel = 'Native bot form unavailable. Rebuild the iOS app.',
  ...props
}: NativeBotFormViewProps) {
  // 首次 render 时 resolve 一次并固定下来：在 render 期现算会被当成"每次渲染新建组件"。
  const [Component] = useState(() =>
    resolveMemohNativeView<NativeBotFormViewProps>('NativeBotFormView'),
  );
  if (Component) {
    return <Component {...props} />;
  }
  return (
    <View style={props.style} testID="native-bot-form-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
