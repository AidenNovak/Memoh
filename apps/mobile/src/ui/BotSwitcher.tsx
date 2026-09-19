/**
 * Bot（agent）切换器。
 *
 * Memoh 是"多 bot"的：一个用户可以有好几个 agent，各自有自己的云电脑和记忆。
 * 所以在列表页顶部需要一个轻量的切换入口。用原生 ActionSheet 语义（底部弹出），
 * 而不是自己画一个下拉菜单。
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActionSheetIOS, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { present } from '../lib/presentation/present.ts';
import { useT } from '../lib/i18n/useT.ts';
import { BotSwitchSheet } from './BotSwitchPage.tsx';
import { PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import type { Bot } from '../api/types.ts';
import { agentPlaceholderKey } from '../features/bots/label.ts';
import { useSession } from '../features/session/store.tsx';

/**
 * 弹出 agent 切换。
 *
 * 抽成 hook 是因为**两个地方都要它**：会话页的 agent 行、设置 tab 的 agent 卡片。
 *
 * 形态从系统 ActionSheet 换成了 `present()` 出来的原生 sheet（`BotSwitchSheet`）——
 * 原因见那个文件：桌面端每一项是"头像 + 名字 + 当前项打勾"，底下还有「新建 Bot」，
 * 这两样 ActionSheet 都画不出来。
 *
 * 结论分支：选了某个 bot → `selectBot`；选了「新建 Bot」→ push 建 bot 表单；
 * 侧滑关掉 → 什么都不做（`present` 永远不会 reject）。
 */
export function useAgentSwitcher(): () => void {
  const router = useRouter();
  const { state, currentBot, selectBot } = useSession();
  const [busy, setBusy] = useState(false);

  const open = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        const outcome = await present(BotSwitchSheet);
        if (outcome.status !== 'completed') return;
        if (outcome.value.kind === 'new') {
          router.push('/bots/new');
          return;
        }
        if (outcome.value.botId !== (currentBot?.id ?? null)) selectBot(outcome.value.botId);
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, currentBot?.id, router, selectBot]);

  return open;
}

/** 状态色：封闭集合用字典，不用链式三元（AGENTS.md）。 */
export const STATUS_COLOR_KEY = {
  success: 'success',
  warning: 'warning',
  muted: 'tertiaryLabel',
} as const;

/**
 * agent 自己的状态（不是我们这条连接的状态——那是 `ConnectionBadge` 的事）。
 *
 * 服务端 `status` 的取值域没有文档，这里只认我们已知的三个；认不出来就退回
 * `is_active`（"这个 bot 是启用的"）。宁可说得保守，也不要凭一个不认识的字符串
 * 编出一个状态。
 */
export function agentStatus(
  bot: Bot | null,
  t: (key: string) => string,
): { label: string | null; color: 'success' | 'warning' | 'muted' } {
  if (bot === null) return { label: null, color: 'muted' };
  if (bot.status === 'starting') return { label: t('bot.status.starting'), color: 'warning' };
  if (bot.status === 'online') return { label: t('bot.status.online'), color: 'success' };
  if (bot.status === 'offline') return { label: t('bot.status.offline'), color: 'muted' };
  return bot.is_active
    ? { label: t('bot.status.online'), color: 'success' }
    : { label: t('bot.status.offline'), color: 'muted' };
}

/**
 * 两种形态：
 *
 * - `pill`：自成一行的胶囊（旧形态，仍保留给"还没有 agent 行"的场合）。
 * - `row`：会话页的 agent 行——**真图标 + 名字 + ⌄**，占满左侧，右边留给这一屏的动作。
 *   图标用仓库里那枚真吉祥物（`brand-mark.png`，透明底），**不是字母占位**：一个字母
 *   方块在这里既不是品牌也不是标识，只是"我们还没画完"的痕迹。
 *
 * `stacked`（只对 `row` 有意义）：状态徽章放到**第二行**。最大辅助字号下"头像 + 名字 +
 * ⌄ + 徽章"一行要 400pt 以上，屏宽放不下——继续挤的结果是名字被截成 `Assist…`、
 * 徽章的标签被截成 `O…`（2026-09-18 实测）。这一档改形态：名字那一行只剩
 * 头像 + 名字 + ⌄（约 276pt，放得下、不截断），徽章自己一行、完整可读。
 */
export function BotSwitcher({
  variant = 'pill',
  stacked = false,
}: { variant?: 'pill' | 'row'; stacked?: boolean } = {}) {
  const palette = usePalette();
  const { spacing, typography, radius } = useTheme();
  const t = useT();
  const { state, currentBot } = useSession();

  const open = useAgentSwitcher();
  const status = agentStatus(currentBot, t);
  const statusColor = palette[STATUS_COLOR_KEY[status.color]];

  /**
   没有当前 agent 时**不许**写"还没有会话"。

   这里以前是 `t('home.empty.title')`，于是 `/bots` 拉不到（或还没拉到）的那一刻，切换器
   会念出"还没有会话"——一句关于**会话**的话，用来解释**agent** 的问题，而且是空态的语气
   （判据见 `features/bots/label.ts` 与规则 R41）。
   */
  const title =
    currentBot === null
      ? t(agentPlaceholderKey({ loading: state.botsLoading, failure: state.botsError }))
      : currentBot.display_name !== ''
        ? currentBot.display_name
        : currentBot.name;

  if (variant === 'row') {
    const badge =
      status.label === null ? null : (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: radius.pill,
            backgroundColor: palette.field,
            // 默认档先收徽章：`flexShrink` 给得比名字大，“还可读的名字 + 截短的徽章”
            // 比反过来有用（状态在读屏标签里仍是完整的，见上面的 accessibilityLabel）。
            // 辅助档（`stacked`）用不着它——徽章自己一行，没人跟它抢。
            flexShrink: stacked ? 0 : 3,
          }}
        >
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor }} />
          <Text
            style={[typography.caption, { color: palette.secondaryLabel, flexShrink: 1 }]}
            numberOfLines={1}
          >
            {status.label}
          </Text>
        </View>
      );

    /* 名字与状态徽章**可以收缩**（`flexShrink`）：默认档下这一行的宽度是
       "头像 + 名字 + ⌄ + 徽章"，加起来约 1.2 屏宽——不让步的话整行被屏幕切掉，
       连右边的 `＋`（新建会话的唯一入口）都会被挤出去。让步的顺序是**徽章先于名字**：
       名字是"这是哪个 agent"，徽章是补充。 */
    const name = (
      <>
        <Image
          source={require('../../assets/images/brand-mark.png')}
          style={{ width: 26, height: 26, borderRadius: 7 }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        <Text
          style={[typography.callout, { color: palette.label, flexShrink: 1 }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {/* ⌄ 常显：桌面端一直是"名字 + 上下箭头"，而"只有一个 bot 就不给箭头"会让
            用户以为这个入口在他这里不存在（他照样需要"新建 Bot"那一行）。 */}
        <Text style={[typography.footnote, { color: palette.tertiaryLabel }]}>⌄</Text>
      </>
    );

    if (stacked) {
      return (
        <Pressable
          testID="bot-switcher"
          accessibilityRole="button"
          accessibilityLabel={status.label === null ? title : `${title}, ${status.label}`}
          accessibilityHint={t('home.bot.switch')}
          onPress={open}
          hitSlop={6}
          style={({ pressed }) => ({
            flexShrink: 1,
            paddingVertical: 4,
            paddingLeft: spacing.lg,
            gap: spacing.xs,
            opacity: pressed ? PRESS_OPACITY.control : 1,
          })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            {name}
          </View>
          {badge === null ? null : (
            // 包一层：徽章在列方向里会被拉满宽，而它该是"内容多宽就多宽"。
            <View style={{ flexDirection: 'row' }}>{badge}</View>
          )}
        </Pressable>
      );
    }

    return (
      <Pressable
        testID="bot-switcher"
        accessibilityRole="button"
        accessibilityLabel={status.label === null ? title : `${title}, ${status.label}`}
        accessibilityHint={t('home.bot.switch')}
        onPress={open}
        hitSlop={6}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            flexShrink: 1,
            paddingVertical: 4,
            paddingLeft: spacing.lg,
            opacity: pressed ? PRESS_OPACITY.control : 1,
          },
        ]}
      >
        {name}
        {badge}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={status.label === null ? title : `${title}, ${status.label}`}
      accessibilityHint={t('home.bot.switch')}
      onPress={open}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: pressed ? palette.field : palette.card,
          borderRadius: radius.pill,
          marginHorizontal: spacing.lg,
          marginBottom: spacing.sm,
          paddingHorizontal: spacing.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.separator,
        },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor:
              currentBot?.is_active === true ? palette.success : palette.tertiaryLabel,
          }}
        />
        <Text style={[typography.callout, { color: palette.label }]} numberOfLines={1}>
          {title}
        </Text>
        {/* ⌄ 常显：桌面端一直是"名字 + 上下箭头"，而"只有一个 bot 就不给箭头"会让
            用户以为这个入口在他这里不存在（他照样需要"新建 Bot"那一行）。 */}
        <Text style={[typography.footnote, { color: palette.tertiaryLabel }]}>⌄</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 36,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingVertical: 6,
  },
});
