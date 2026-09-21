/**
 * 设置 tab 顶部的 agent 卡片。
 *
 * ## 为什么不是一行普通设置行
 *
 * 这个 App 是"多 agent"的：设置的对象首先**是哪个 agent**，然后才是别的。所以这一屏
 * 最上面必须回答"我在配置谁"，而且切换 agent 要在这里就能做——把切换藏在某个 push 进去
 * 的详情页里，等于每次换 agent 都要走三步。
 *
 * ## 头像是同一个组件
 *
 * 卡片上的头像与切换器里的每一个头像走**同一份判断**（`BotAvatar`）：有自定义头像就用
 * 自定义的，没有（或那张图加载失败）就用仓库里那枚真吉祥物。两端同一个位置摆同一枚图标，
 * 不是"这里一枚、那里一个灰方块"。
 *
 * 副标题只放**我们真的知道**的东西（时区、待审批条数）。设计稿那一行还有"workspace ·
 * Telegram 已连接"，需要 channels / workspace 端点，没接之前不写——摆一句编的副标题
 * 比留空更糟。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Bot } from '../api/types.ts';
import { useT } from '../lib/i18n/useT.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { agentPlaceholderKey, agentStatus } from '../features/bots/label.ts';
import { useSession } from '../features/session/store.tsx';
import { BotAvatar } from './BotAvatar.tsx';
import { STATUS_COLOR_KEY } from './BotSwitcher.tsx';

interface Props {
  /** 待审批条数；没有聚合数据时传 null，不显示那一段。 */
  pendingCount: number | null;
  onPress: () => void;
  bot: Bot | null;
}

export function AgentCard({ bot, pendingCount, onPress }: Props) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const t = useT();
  const status = agentStatus(bot, t);
  const { state } = useSession();

  // 与切换器**同一处判据**：没有当前 agent 时不许说"还没有会话"（见 features/bots/label.ts）。
  const name =
    bot === null
      ? t(agentPlaceholderKey({ loading: state.botsLoading, failure: state.botsError }))
      : bot.display_name !== ''
        ? bot.display_name
        : bot.name;

  const statusColor = palette[STATUS_COLOR_KEY[status.color]];

  const parts: string[] = [];
  // 没设时区时服务端连 key 都不返回（`omitempty`），所以这里按"有没有值"判，
  // 不能按"是不是空串"判——那是 undefined 会溜过去的老写法。
  if (bot !== null && bot.timezone !== undefined && bot.timezone.trim() !== '') {
    parts.push(bot.timezone);
  }
  if (pendingCount !== null && pendingCount > 0) {
    parts.push(t('settings.agent.pending', { count: pendingCount }));
  }

  return (
    <Pressable
      testID="agent-card"
      accessibilityRole="button"
      // 标签里必须**带上名字**：只念"切换 agent"的话，VoiceOver 用户不知道现在是谁、
      // 也不知道按下去会切到哪儿。名字 + 提示（提示才是"这是个按钮，按了能换"）。
      accessibilityLabel={status.label === null ? name : `${name}, ${status.label}`}
      accessibilityHint={t('home.bot.switch')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? palette.field : palette.card,
          borderRadius: 14,
          padding: spacing.md,
          gap: spacing.md,
        },
      ]}
    >
      <BotAvatar bot={bot} size={38} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text style={[typography.headline, { color: palette.label }]} numberOfLines={1}>
            {name}
          </Text>
          {status.label === null ? null : (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: palette.field,
              }}
            >
              <View
                style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor }}
              />
              <Text style={[typography.caption, { color: palette.secondaryLabel }]}>
                {status.label}
              </Text>
            </View>
          )}
        </View>
        {parts.length > 0 ? (
          <Text style={[typography.footnote, { color: palette.secondaryLabel }]} numberOfLines={1}>
            {parts.join(' · ')}
          </Text>
        ) : null}
      </View>
      <Text style={[typography.body, { color: palette.tertiaryLabel }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center' },
});
