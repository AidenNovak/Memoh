/**
 * 待发那一帧的可见表达（"发出去了但看不见"的补丁）。
 *
 * ## 为什么它在 composer 正上方
 *
 * 与 `QueueStrip` 同一个位置、同一条理由：它说的是"这一句话现在在哪儿"，
 * 而用户刚把它从输入框里送出去——盯着输入框上方那一条是最自然的反应。
 * 会话信息、连接状态都在别处，这里只回答这一个问题。
 *
 * ## 三条判据（照 Lody，见 `features/chat/pending.ts` 的文件头）
 *
 * 1. **给文字，不给转圈。** 未确认 ≠ 进行中：这一帧可能已经在服务端了，
 *    转圈会让人以为"它在跑"，而实际上我们只是没收到回显。
 * 2. **每个阶段有名字。** 等网络 / 等确认 / 没发出去，三句话不同。
 * 3. **"重试"与"重连"是两件事**，文案与无障碍提示都分开：
 *    重连只是把管子接回来（不会重发任何东西），重试是真的再发一次这句话。
 *    两者对服务端的效果完全不同，所以不能共用一个词。
 *
 * ## 为什么不是消息行上的状态
 *
 * 转录是原生列表（`memoh-kit` 的 `MessageCells`），行的身份与状态都归它管；
 * 这一条是**发送这一侧**的状态，改它不该动消息渲染。等原生那一侧要支持
 * "行内状态 + 动作"时，这里就是它的模型（`pendingSendView`）。
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import type { PendingSendView } from '../features/chat/pending.ts';
import { useT } from '../lib/i18n/useT.ts';
import { PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

/**
 * 动作 → 回调。
 *
 * 只有两种，用一个三元（AGENTS.md 允许单层三元）；两边的**语义**差别写在
 * `features/chat/pending.ts` 里，这里只负责把它们接到各自的入口上。
 */
interface Handlers {
  onRetry: () => void;
  onReconnect: () => void;
}

export function PendingSendStrip({ view, ...handlers }: { view: PendingSendView } & Handlers) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  const t = useT();
  const action = view.action;

  return (
    <View
      testID="pending-send"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.lg,
        marginBottom: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        minHeight: 44,
        borderRadius: radius.md,
        backgroundColor: palette.field,
      }}
    >
      <View style={{ flex: 1 }}>
        {/* 一行状态 + 一行原因（原因只有失败那一档会有，而且是服务端给的原文）。 */}
        <Text
          testID="pending-send-state"
          style={[
            typography.footnote,
            { color: view.phase === 'failed' ? palette.destructive : palette.secondaryLabel },
          ]}
        >
          {t(view.textKey)}
        </Text>
        {view.reason === null ? null : (
          <Text
            testID="pending-send-reason"
            style={[typography.caption2, { color: palette.secondaryLabel }]}
          >
            {view.reason}
          </Text>
        )}
      </View>

      {/* 没动作就不画按钮。`awaiting` 没有动作是有意的：那一帧可能已经进了服务端，
          再发一次就是重复一轮（见 features/chat/pending.ts）。 */}
      {action === null ? null : (
        <Pressable
          testID={`pending-send-${action.id}`}
          accessibilityRole="button"
          accessibilityLabel={t(action.labelKey)}
          // 两个动作的效果不同，只念标签会让读屏用户以为它们是一回事。
          accessibilityHint={t(action.hintKey)}
          onPress={action.id === 'retry' ? handlers.onRetry : handlers.onReconnect}
          hitSlop={8}
          style={({ pressed }) => ({
            minWidth: 44,
            minHeight: 44,
            alignItems: 'flex-end',
            justifyContent: 'center',
            opacity: pressed ? PRESS_OPACITY.control : 1,
          })}
        >
          <Text
            style={[
              typography.footnote,
              { color: view.phase === 'failed' ? palette.destructive : palette.accent },
            ]}
          >
            {t(action.labelKey)}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
