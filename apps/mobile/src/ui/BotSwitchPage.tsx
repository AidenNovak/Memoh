/**
 * agent 切换 sheet。
 *
 * ## 为什么不再是 `ActionSheetIOS`
 *
 * 之前那一版是系统 ActionSheet：一行一个名字 + Cancel。它能用，但和桌面端**不是一件事**：
 * 桌面端（`components/sidebar/bot-switcher.vue`）的每一项是"**头像 + 名字 + 当前项打勾**"，
 * 底下还有一行「新建 Bot」。系统 ActionSheet 画不了头像、画不了勾、也塞不下第二组动作。
 *
 * 所以这里用 `present()` 开一张原生 sheet，形状照桌面端那张列表：
 *
 * | 桌面端 | 这里 |
 * | --- | --- |
 * | 头像（`avatar_url`，没有就用首字母） | 同（`expo-image` + 首字母兜底） |
 * | 名字（`display_name \|\| name`） | 同 |
 * | 当前项右侧一个勾 | 同（SF Symbol `checkmark`） |
 * | 列表底部「新建 Bot」 | 同 |
 * | 底部「管理智能体」（跳管理页） | **不搬**——iOS 没有 bot 管理页，也不打算有（规格 §1 修订） |
 *
 * ## 两条与桌面端**有意不同**的地方
 *
 * 1. **不可点的行按 `check_state === 'issue'` 置灰**，不按 `bot.status === 'error'`。
 *    桌面端那句是**死代码**：服务端 `bot.status` 只有 `creating / ready / deleting`
 *    三个值（`internal/bots/types.go`），`error` 永远不会出现；真正表示"有毛病"的是
 *    `check_state`。照抄它等于抄一段永不生效的判断。
 * 2. 桌面的置顶/拖拽排序存在浏览器 localStorage 里（`pinned-bot-ids` / `bot-order`），
 *    **没有对应的服务端字段**——搬过来也只有一个不同步的副本，所以这里不搬。
 */
import React from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Bot } from '../api/types.ts';
import { BotAvatar } from './BotAvatar.tsx';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { useSession } from '../features/session/store.tsx';
import { agentPlaceholderKey } from '../features/bots/label.ts';
import { canManageBot } from '../features/bots/permissions.ts';

/** 结论：选了某个 bot，或者要新建一个。取消就是 `cancelled`（不用另设一种结果）。 */
export type BotSwitchResult = { kind: 'bot'; botId: string } | { kind: 'new' };

export function BotSwitchPage() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const { state, currentBot } = useSession();
  const runtime = usePageRuntime<undefined, BotSwitchResult>();

  const bots = state.bots;
  const currentId = currentBot?.id ?? null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl }}
    >
      <Text
        style={[
          typography.footnote,
          {
            color: palette.secondaryLabel,
            paddingHorizontal: GROUP_INSET,
            marginBottom: spacing.sm,
          },
        ]}
      >
        {t('bots.group')}
      </Text>

      <View style={[styles.card, { backgroundColor: palette.card, marginHorizontal: GROUP_INSET }]}>
        {bots.length === 0 ? (
          // 一个 bot 都没有也要给结论：空态一句话 + 下面的「新建 Bot」就是出路。
          // 但"没拉到"和"真的没有"是两件事，所以这里用与切换器同一处判据
          // （`features/bots/label.ts`）：拉失败时说"没拉到"，不许说"还没有 agent"。
          <Text style={[typography.body, { color: palette.secondaryLabel, padding: spacing.lg }]}>
            {t(agentPlaceholderKey({ loading: state.botsLoading, failure: state.botsError }))}
          </Text>
        ) : (
          bots.map((bot, index) => (
            <BotRow
              key={bot.id}
              bot={bot}
              current={bot.id === currentId}
              last={index === bots.length - 1}
              onPress={() => runtime.finish({ kind: 'bot', botId: bot.id })}
            />
          ))
        )}
      </View>

      {/* 底部动作：与桌面端同一处、同一句话。 */}
      <View style={{ marginTop: spacing.xl, marginHorizontal: GROUP_INSET, gap: spacing.sm }}>
        <Pressable
          testID="bot-switch-new"
          accessibilityRole="button"
          onPress={() => runtime.finish({ kind: 'new' })}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: pressed ? palette.field : palette.card },
          ]}
        >
          <Text style={[typography.body, { color: palette.accent }]}>{t('bots.create')}</Text>
        </Pressable>

        {/*
          当前 agent 的设置入口。桌面端的切换弹层底部就有「管理智能体」这一行
          （`components/sidebar/bot-switcher.vue`），iOS 之前没有可去的地方所以没摆。
          现在有 bot 设置页了，补上——它去的是**当前**那个 bot（不是列表里某一行）。

          **没有 `manage` 的人不出现这一行**：共享 bot 的成员能切到它、能聊，但改不了它，
          这样一个入口只会让人点进一个必然 403 的页面（同一个判断在设置 tab 也用，
          见 `features/bots/permissions.ts`）。
        */}
        {currentId === null || !canManageBot(currentBot) ? null : (
          <Pressable
            testID="bot-switch-settings"
            accessibilityRole="button"
            onPress={() => {
              runtime.finish({ kind: 'bot', botId: currentId });
              router.push(`/bots/edit?botId=${encodeURIComponent(currentId)}`);
            }}
            style={({ pressed }) => [
              styles.action,
              { backgroundColor: pressed ? palette.field : palette.card },
            ]}
          >
            <Text style={[typography.body, { color: palette.accent }]}>
              {t('botSettings.open')}
            </Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

function BotRow({
  bot,
  current,
  last,
  onPress,
}: {
  bot: Bot;
  current: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const t = useT();

  /**
   * 能不能选：只有 `check_state === 'issue'` 的行才置灰。
   *
   * `creating` / `deleting` 也允许点（桌面端同样只挡"有毛病"的行）——一个正在建的 bot
   * 切过去是"看到它还在准备"，而不是一个点不动的死行。
   */
  const blocked = bot.check_state === 'issue';
  const title = bot.display_name !== '' ? bot.display_name : bot.name;

  return (
    <Pressable
      testID={`bot-row-${bot.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: current, disabled: blocked }}
      disabled={blocked}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: spacing.lg,
        paddingVertical: 10,
        backgroundColor: pressed ? palette.field : 'transparent',
        opacity: blocked ? 0.4 : 1,
      })}
    >
      <BotAvatar bot={bot} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[typography.body, { color: palette.label }]} numberOfLines={1}>
          {title}
        </Text>
        {bot.check_state === 'issue' ? (
          <Text style={[typography.footnote, { color: palette.secondaryLabel }]} numberOfLines={1}>
            {t('bots.issue', { count: bot.check_issue_count })}
          </Text>
        ) : null}
      </View>
      {current ? <Text style={[typography.body, { color: palette.accent }]}>✓</Text> : null}
      {!last ? (
        <View
          style={{
            position: 'absolute',
            left: 56,
            right: 0,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: palette.separator,
          }}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.md, overflow: 'hidden' },
  action: {
    minHeight: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export const BotSwitchSheet = definePage<undefined, BotSwitchResult>({
  id: 'botSwitch',
  title: 'Switch agent',
  Component: BotSwitchPage,
  presentation: {
    dismissible: true,
    // 内容自己长（bot 数量不定），所以用 fitToContents 而不是固定 detent——
    // 固定高度会在 1 个 bot 时留一大片空白、在 10 个 bot 时可滚动但看起来像被截断。
    detents: 'fitToContents',
    grabber: true,
    headerShown: false,
  },
});
