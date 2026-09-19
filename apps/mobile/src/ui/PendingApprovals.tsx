/**
 * 待审批横幅。
 *
 * 放在首页最上方——比会话列表更醒目，因为"有 agent 在等你"是**有时限**的信息，
 * 而会话列表随时都在。用户点一下就直接进那个会话的对话页，审批 sheet 会自己弹出来。
 *
 * 没有待办时**完全不占位置**（返回 null），不要留一个"暂无待办"的空块去占屏幕。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { SessionActivity } from '../features/activity/useSessionActivity.ts';
import { useT } from '../lib/i18n/useT.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export function PendingApprovals({
  entries,
  onOpen,
}: {
  entries: SessionActivity[];
  onOpen: (entry: SessionActivity) => void;
}) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  const t = useT();

  if (entries.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
      <Text
        style={[
          typography.footnote,
          { color: palette.warning, marginBottom: spacing.xs, textTransform: 'uppercase' },
        ]}
      >
        {t('home.approvals.title')}
      </Text>
      <View style={{ backgroundColor: palette.card, borderRadius: radius.md, overflow: 'hidden' }}>
        {entries.map((entry, index) => (
          <Pressable
            key={entry.sessionId}
            accessibilityRole="button"
            accessibilityLabel={`${entry.botName} · ${entry.sessionTitle} · ${t('approval.title')}`}
            onPress={() => onOpen(entry)}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? palette.field : palette.card,
                borderBottomColor: palette.separator,
                borderBottomWidth: index === entries.length - 1 ? 0 : StyleSheet.hairlineWidth,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
              },
            ]}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[typography.callout, { color: palette.label }]} numberOfLines={1}>
                {entry.sessionTitle}
              </Text>
              <Text
                style={[typography.footnote, { color: palette.secondaryLabel }]}
                numberOfLines={1}
              >
                {entry.botName}
              </Text>
            </View>
            {/* 右侧的箭头说明"点进去有事要做"，而不是一个装饰。 */}
            <Text style={[typography.body, { color: palette.tertiaryLabel }]}>›</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    gap: 8,
  },
});
