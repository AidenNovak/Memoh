/**
 * 待发队列条（运行中排下的话）。
 *
 * ## 为什么它在 composer **上方**而不是消息流里
 *
 * 队列里的东西**还没有发出去**——它们不是历史，是"计划"。放进消息流会让人读成
 * "agent 已经收到了"，而这个误解的代价是用户不再确认、以为事情在推进。
 * 放在输入框正上方，读起来就是"这些还等在门口"。
 *
 * ## 为什么每行都可以删
 *
 * 排队的场景是"agent 还在跑，我先补两句"——最常见的后续动作是**改主意**。
 * 没有删除就得等它跑完再说一句"别管刚才那句"，那更糟。
 *
 * ## 为什么"插话"可能不出现
 *
 * 服务端只在运行形态允许时才给 `steer_supported`（不是所有 agent 都能被打断）。
 * 宁可不给这个入口，也不要给一个必然失败的按钮。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { QueueItem } from '../models/chat.ts';
import type { QueueView } from '../features/session/store.tsx';
import { queuePreview } from '../features/chat/queue.ts';
import { useT } from '../lib/i18n/useT.ts';
import { PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export function QueueStrip({
  queue,
  onRemove,
  onPromote,
}: {
  queue: QueueView;
  onRemove: (item: QueueItem) => void;
  onPromote: (item: QueueItem) => void;
}) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  const t = useT();

  // 队列和错误都没有就整块不出现——空容器会白占一行高度。
  if (queue.items.length === 0 && queue.error === null) return null;

  // 只摊开前几条：这一块钉在输入框上方，它越长，正在读的正文被顶掉得越多。
  const { visible, hidden } = queuePreview(queue.items);

  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        gap: spacing.xs,
        borderTopWidth: queue.items.length > 0 ? StyleSheet.hairlineWidth : 0,
        borderTopColor: palette.separator,
        backgroundColor: palette.card,
      }}
    >
      {hidden > 0 ? (
        <Text style={[typography.caption2, { color: palette.secondaryLabel }]}>
          {t('queue.hidden', { count: hidden })}
        </Text>
      ) : null}
      {visible.map((item) => (
        <View
          key={item.itemId}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            backgroundColor: palette.field,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            minHeight: 44,
          }}
        >
          {/* kind 是给用户的语义：steer 现在就会看到，follow-up 要等这轮跑完。 */}
          <Text style={[typography.caption2, { color: palette.secondaryLabel }]}>
            {item.kind === 'steer' ? t('queue.steer') : t('queue.followUp')}
          </Text>
          <Text style={[typography.footnote, { color: palette.label, flex: 1 }]} numberOfLines={2}>
            {item.text}
          </Text>
          {/* 只有 follow-up 能提成 steer：steer 已经在被取用了，没有"更早"可提。 */}
          {item.kind === 'follow-up' && queue.steerSupported ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('queue.steerNow')}
              onPress={() => onPromote(item)}
              hitSlop={8}
              style={({ pressed }) => ({
                opacity: pressed ? PRESS_OPACITY.control : 1,
                minWidth: 44,
                alignItems: 'center',
              })}
            >
              <Text style={[typography.footnote, { color: palette.accent }]}>
                {t('queue.steerNow')}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('queue.remove')}
            onPress={() => onRemove(item)}
            hitSlop={8}
            style={({ pressed }) => ({
              opacity: pressed ? PRESS_OPACITY.control : 1,
              minWidth: 44,
              alignItems: 'center',
            })}
          >
            <Text style={[typography.body, { color: palette.secondaryLabel }]}>✕</Text>
          </Pressable>
        </View>
      ))}

      {/* 队列写失败必须说出来：用户以为排上了、实际没有，比报错更坏。 */}
      {queue.error !== null ? (
        <Text style={[typography.caption2, { color: palette.destructive }]}>
          {t('queue.failed')}
        </Text>
      ) : null}
    </View>
  );
}
