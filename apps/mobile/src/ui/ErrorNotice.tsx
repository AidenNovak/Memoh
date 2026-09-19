/**
 * 就地错误块：**本 App 里"一个失败长什么样"的唯一形状**。
 *
 * ## 为什么要有这么一个组件
 *
 * 以前每屏自己拼一段 `<Text color={destructive}>`：有的只有标题、有的直接把
 * `caught.message` 打上去、有的给重试、有的不给。用户看到的是"同一件事三种说法"，
 * 而我们要的是一眼能认出来："这是一次故障，它说了原因，这里有一个我能做的动作。"
 *
 * 形状照 Apple 的错误对象：**标题（发生了什么）+ 补充说明（为什么）+ 动作（下一步）**
 * （`localizedDescription` + `localizedRecoverySuggestion` + `localizedRecoveryOptions`，
 * 见 `docs/research/ios-error-and-feedback.md` R13/R14）。所以它不是设计品味，是照系统。
 *
 * ## 两个必须成立的约束
 *
 * 1. **整块是一个无障碍元素**：读屏只会读容器自己的标签，里面那几行字对读屏是**看不见**的
 *    （同 `ui/ConnectionBadge.tsx` 里记过的那个坑）。所以标签要把三样都串起来，
 *    读屏用户听到的是一句完整的话，而不是三行碎片。
 * 2. **出现时播报一次**（`useAnnounceOnAppear`）。iOS 上 `accessibilityLiveRegion` 是空转的
 *    （见 `lib/accessibility.ts` 的说明），不主动播报就等于"屏幕上出现了错误，读屏用户
 *    完全不知道"。
 *
 * 不做的事：不吃颜色语义（文案本身说清状态，不靠红字）；不自动消失（Apple 明确反对
 * 定时消失的界面元素，而且用户可能正读到一半）。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAnnounceOnAppear } from '../lib/accessibility.ts';
import { radius, spacing } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export interface ErrorNoticeAction {
  label: string;
  onPress: () => void;
}

export function ErrorNotice({
  testID,
  title,
  reason,
  action,
}: {
  /** 断言用。约定：`<屏>-error`，动作按钮是 `<屏>-error-action`。 */
  testID: string;
  /** 发生了什么。要具体（"拉不到会话列表"），不要写 "Error"（HIG 点名的反例）。 */
  title: string;
  /** 为什么。没有可说的就不传——留空比编一句好。 */
  reason?: string;
  /**
   * 下一步。**只在真的有用时才传**：判据是 `features/errors/present.ts` 的
   * `canRetry()`——不可重试的错误给重试按钮等于让用户去做一件我们已知不会成的事。
   */
  action?: ErrorNoticeAction;
}) {
  const palette = usePalette();
  const { typography } = useTheme();

  const hasReason = reason !== undefined && reason.trim() !== '';
  // 读屏听到的是这一整句：发生了什么 → 为什么 → 能做什么。
  // 用 if 拼而不是三元：这里有三段可选内容（封闭集合不为空但组合多），三元一叠就
  // 变成链式三元（AGENTS.md 禁止），而且读起来是在解谜。
  const parts = [title];
  if (hasReason) parts.push(reason);
  if (action !== undefined) parts.push(action.label);
  const label = parts.join(' ');
  useAnnounceOnAppear(label);

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={label}
      style={[styles.card, { backgroundColor: palette.card }]}
    >
      <Text style={[typography.subhead, { color: palette.label }]}>{title}</Text>
      {hasReason ? (
        <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>{reason}</Text>
      ) : null}
      {action === undefined ? null : (
        /* 整块的 44pt 触控目标，而不是一行小字链接（Accessibility §Mobility 的最小尺寸）。 */
        <Pressable
          testID={`${testID}-action`}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.action,
            {
              borderColor: palette.separator,
              backgroundColor: pressed ? palette.field : 'transparent',
            },
          ]}
        >
          <Text style={[typography.subhead, { color: palette.accent }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.md,
  },
  action: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
    minWidth: 120,
  },
});
