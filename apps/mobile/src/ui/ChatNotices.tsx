/**
 * 消息流上方那几条**状态横条**（连接 / run 失败 / 历史没拉到 / 复制成功）。
 *
 * ## 为什么它们合成一个组件
 *
 * 它们不共享状态，共享的是**位置与秩序**：都在消息流上沿、都在讲"刚刚发生了一件事"
 * 而不是内容本身，而且**顺序有意义**——连接是最外层的环境，run 失败是这一轮的结局，
 * 历史失败是翻页的结果，复制成功是一次瞬时确认。以前这五段 JSX 散在 `ChatScreen`
 * 的返回里，中间隔着别的块；现在顺序在这一个文件里一眼看得完。
 *
 * ## 每一条为什么长这样
 *
 * - **已经确认没有实时权限**：只说一句（`chat.readOnly`）。这是权限层面的缺失，不是故障。
 *   bot 还没拉到时保持静默，不能把“权限未知”说成“此账号不能发起实时对话”。
 * - **有实时权限**：挂 `ConnectionBadge`。以前只有首页/会话列表有连接指示，于是掉线时
 *   用户盯着的是一屏停在几秒前的内容、副标题还写着 "Thinking"——弱网下最难受的从来
 *   不是报错，是**安静的旧数据**。放在标题行下面（而不是塞进标题行）：标题行里已经有
 *   标题 + 副标题 + "Refreshing…"，再加一段会把标题挤到只剩两个字（实测就是这么截断的）。
 * - **run 失败**：一行标题 + 一行原因，**就地**贴在消息流上方。它不是"必须打断"的事
 *   （agent 已经停了，没有数据会丢），所以不进 alert（规则 R4/R10）。出现时读屏要念一次
 *   ——用户没按任何东西，它是自己出现的（规则 R28），播报由调用方接 `runFailure.label`。
 * - **更早的历史没拉到**：说一句，并给一个**能执行**的动作。翻页失败如果什么都不说，
 *   用户看到的就是"往上滑，没反应"——而那和"已经到第 1 轮了"长得一模一样（评审 A2 的
 *   原话是"静默失败"）。游标在失败时是**留着**的（见 `olderHistoryFailed`），所以
 *   那个动作是真的有用。
 * - **复制成功**：一行轻提示。原生那边贴着消息的 `Copied` 胶囊负责"哪一条被复制了"，
 *   这一行负责"这件事在 App 自己的文案体系里被确认过"，并给验收一个可断言的落点
 *   （`chat-copied-notice`）。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RunFailureNotice } from '../features/chat/copy.ts';
import { ConnectionBadge } from './ConnectionBadge.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export function ChatNotices({
  permissionsKnown,
  realtimeEnabled,
  runFailure,
  olderError,
  copied,
  onRetryOlder,
}: {
  /** bot 已经拉到；false 时权限仍未知，不能展示只读结论。 */
  permissionsKnown: boolean;
  /** 这个 bot 有没有实时通道的权限（没有就只说一句，不挂连接徽标）。 */
  realtimeEnabled: boolean;
  /** run 失败那一块；`null` = 这一轮没失败。判据在 `features/chat/copy.ts`。 */
  runFailure: RunFailureNotice | null;
  /** 更早的历史没拉到的原因（i18n key）；`null` = 没这回事。 */
  olderError: string | null;
  /** 复制成功提示此刻该不该出现（存的是时刻，见 `ChatScreen` 的 `copiedAt`）。 */
  copied: boolean;
  onRetryOlder: () => void;
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const t = useT();

  return (
    <>
      {!permissionsKnown || realtimeEnabled ? null : (
        <View
          testID="chat-read-only"
          accessible
          accessibilityLabel={t('chat.readOnly')}
          style={{ backgroundColor: palette.field, padding: spacing.md }}
        >
          <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
            {t('chat.readOnly')}
          </Text>
        </View>
      )}

      {realtimeEnabled ? (
        <View style={{ backgroundColor: palette.field, paddingHorizontal: spacing.lg }}>
          <ConnectionBadge />
        </View>
      ) : null}

      {runFailure === null ? null : (
        /* 出现时读屏要念一次——用户没按任何东西，它是自己出现的（规则 R28）。
           标签由调用方从 `runFailure.label` 接给 `useAnnounceOnAppear`。 */
        <View
          testID="chat-run-failed"
          accessible
          accessibilityLabel={runFailure.label}
          style={{
            backgroundColor: palette.field,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: palette.separator,
          }}
        >
          <Text style={[typography.subhead, { color: palette.destructive }]}>
            {t('chat.run.failed')}
          </Text>
          {runFailure.reason === null ? null : (
            <Text style={[typography.footnote, { color: palette.secondaryLabel, marginTop: 2 }]}>
              {runFailure.reason}
            </Text>
          )}
        </View>
      )}

      {olderError === null ? null : (
        <Pressable
          testID="chat-older-failed"
          accessibilityRole="button"
          accessibilityLabel={`${t('chat.history.failed')} · ${t(olderError)}`}
          accessibilityHint={t('chat.history.retry.hint')}
          onPress={onRetryOlder}
          style={{
            backgroundColor: palette.field,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: palette.separator,
          }}
        >
          <Text style={[typography.footnote, { color: palette.destructive }]}>
            {t('chat.history.failed')}
          </Text>
          <Text style={[typography.caption, { color: palette.secondaryLabel }]}>
            {`${t(olderError)} · ${t('common.retry')}`}
          </Text>
        </Pressable>
      )}

      {copied ? (
        <View
          testID="chat-copied-notice"
          style={{
            backgroundColor: palette.field,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: palette.separator,
          }}
        >
          <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
            {t('chat.message.copied')}
          </Text>
        </View>
      ) : null}
    </>
  );
}
