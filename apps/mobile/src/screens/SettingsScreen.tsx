/**
 * 设置页的 RN 薄桥。
 *
 * ## 边界
 *
 * **原生持有**可见 UI 与直接交互：设置列表（SwiftUI inset-grouped `Form`）、agent 卡片、
 * 语言勾选、登出的原生确认框。**RN 暂时保留**路由（expo-router）、会话/bot 状态、
 * 主题模式、i18n 文案，以及真正执行 `signOut()`。
 *
 * 这一版把内容算好后以一份 JSON 视图模型下发（`NativeSettingsViewModel`）：名字、状态、
 * 副标题仍走既有的 helper（`features/bots/*`、`ui/BotSwitcher.tsx`），头像走
 * `features/bots/avatar.ts` 的归一化计划——原生**不复制**这些判据。
 *
 * ## 为什么文案要按语言重算
 *
 * `t` 绑定 locale（见 `lib/i18n/useT.ts` 的文件头），所以语言一变这一份视图模型就换成
 * 新的字符串；原生那侧的列表里没有一条自己写死的文案。
 *
 * ## 顺序（与上一版一致，未改判据）
 *
 * | 分组 | 回答的问题 |
 * | --- | --- |
 * | Agent | 我在跟谁说话 / 换一个 / 新建一个 |
 * | Appearance / Language | 它长什么样、说什么话 |
 * | Notifications | 它什么时候来找我（入口，不是开关） |
 * | Account | 我是谁（以及怎么登出） |
 * | About | 哪个版本、连的是哪台服务器 |
 */
import { NativeSettingsView, symbolName, type NativeSettingsViewModel } from '@memoh-ios/kit';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import React, { useCallback } from 'react';

import type { Bot } from '../api/types.ts';
import { getSession } from '../api/credentials.ts';
import { localeDisplayName, setLocale, SUPPORTED_LOCALES, type Locale } from '../lib/i18n/index.ts';
import { useT } from '../lib/i18n/useT.ts';
import { useLocale } from '../lib/i18n/useLocale.ts';
import { useTheme } from '../lib/theme/context.tsx';
import { accountNameOf } from '../features/session/account.ts';
import { canManageBot } from '../features/bots/permissions.ts';
import { useSessionActivity } from '../features/activity/useSessionActivity.ts';
import { useConnectionState, useSession } from '../features/session/store.tsx';
import { avatarFor } from '../features/bots/avatar.ts';
import { builtinAvatarBySlug } from '../features/bots/avatarPresets.ts';
import { agentPlaceholderKey, agentStatus } from '../features/bots/label.ts';
import { useAgentSwitcher } from '../ui/BotSwitcher.tsx';
import { appearanceLabelKey } from './AppearanceScreen.tsx';

const SUPPORTED_LOCALE_IDS: readonly string[] = SUPPORTED_LOCALES;

/**
 * 头像计划 → 原生要画的东西。
 *
 * `avatarFor` 已经把"有 url 但不是地址"的形状（`memoh:avatar/...`、认不出的 slug）
 * 归一化过了，所以原生那一侧**不会**为这类值发请求。内置头像的 SF Symbol 名来自
 * `avatarPresets`（原生不复制那张表）；取不到就退回吉祥物。
 */
function nativeAvatar(
  bot: Bot | null,
  connectionOpen: boolean,
): NativeSettingsViewModel['agent']['avatar'] {
  const plan = avatarFor(bot);
  if (plan.kind === 'remote') return { kind: 'remote', uri: plan.uri, connectionOpen };
  if (plan.kind === 'builtin') {
    const preset = builtinAvatarBySlug(plan.slug);
    if (preset !== undefined) {
      return { kind: 'builtin', symbol: symbolName(preset.symbol), connectionOpen };
    }
  }
  return { kind: 'mark', connectionOpen };
}

/**
 * 当前 agent 的显示名。
 *
 * 没有 bot 时要说**占位**那句话（"正在加载" / "没拉到" / "还没有 agent"），不许说"还没有
 * 会话"——判据在 `features/bots/label.ts`。用 `if` 而不是嵌套三元（`AGENTS.md`）。
 */
function agentDisplayName(bot: Bot | null, placeholder: string): string {
  if (bot === null) return placeholder;
  if (bot.display_name !== '') return bot.display_name;
  return bot.name;
}

export function SettingsScreen() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { state, currentBot, signOut } = useSession();
  const connectionOpen = useConnectionState() === 'open';
  const { mode } = useTheme();
  const openAgentSwitcher = useAgentSwitcher();
  // 和首页用同一份聚合：两处数字不一致比不显示更糟。
  const { pending } = useSessionActivity(state.client, state.bots);
  const pendingCount = pending.length;

  // 身份来自 Keychain 里那份 profile（`/auth/login` 才有，refresh 不回传）。
  const session = getSession();
  const accountName = accountNameOf(session);

  const status = agentStatus(currentBot, t);
  const placeholder = t(
    agentPlaceholderKey({ loading: state.botsLoading, failure: state.botsError }),
  );
  const agentName = agentDisplayName(currentBot, placeholder);

  // 副标题只放**我们真的知道**的东西（时区、待审批条数）。没设时区时服务端连 key 都不返回。
  const timezone = currentBot?.timezone?.trim() ?? '';
  const subtitleParts: string[] = [];
  if (timezone !== '') subtitleParts.push(timezone);
  if (pendingCount > 0) subtitleParts.push(t('settings.agent.pending', { count: pendingCount }));

  const viewModel: NativeSettingsViewModel = {
    title: t('settings.title'),
    agent: {
      header: t('settings.agent'),
      name: agentName,
      statusLabel: status.label ?? '',
      statusColor: status.color,
      subtitle: subtitleParts.join(' · '),
      hint: t('home.bot.switch'),
      avatar: nativeAvatar(currentBot, connectionOpen),
    },
    // 共享过来的 bot 是"能看能聊、不能改"：没有 `manage` 就不给一个按下去必然 403 的入口。
    botSettingsTitle:
      currentBot !== null && canManageBot(currentBot) ? t('botSettings.open') : null,
    appearance: {
      header: t('settings.appearance'),
      title: t('settings.appearance'),
      value: t(appearanceLabelKey(mode)),
    },
    language: {
      header: t('settings.language'),
      // 语言名一律用**它自己的语言**写（English / 简体中文），不翻译。
      options: SUPPORTED_LOCALES.map((option: Locale) => ({
        id: option,
        label: localeDisplayName(option),
        selected: locale === option,
      })),
    },
    // 这一行是**入口**，不是开关：真正的权限由 iOS 持有，App 只能解释 + 给路径。
    notifications: {
      title: t('settings.notifications'),
      footer: t('settings.notifications.footer'),
    },
    account: {
      header: t('settings.account'),
      name: accountName,
      role: session?.role ?? '',
      signOutTitle: t('settings.signOut'),
      signOutMessage: t('settings.signOut.confirm'),
      cancelLabel: t('common.cancel'),
    },
    about: {
      header: t('settings.about'),
      versionLabel: t('settings.version'),
      versionValue: Constants.expoConfig?.version ?? '',
      serverLabel: t('settings.server'),
      serverValue: state.client?.url ?? '',
    },
  };

  const handleSelectLocale = useCallback((event: { nativeEvent: { locale?: string } }) => {
    const next = event.nativeEvent.locale;
    // 桥两侧都校验：未知载荷不许污染 locale 状态。
    if (next !== undefined && SUPPORTED_LOCALE_IDS.includes(next)) {
      setLocale(next as Locale);
    }
  }, []);

  const handleOpenBotSettings = useCallback(() => {
    if (currentBot === null) return;
    router.push(`/bots/edit?botId=${encodeURIComponent(currentBot.id)}`);
  }, [currentBot, router]);

  const handleOpenAppearance = useCallback(() => {
    router.push('/appearance');
  }, [router]);

  const handleOpenNotifications = useCallback(() => {
    router.push('/notifications');
  }, [router]);

  /**
   * 退出登录。
   *
   * 原生那句确认框已经问过了（**只发一次事件**）。这里**只调 `signOut()`**：清凭据与
   * "回登录页"由闸门那一侧的唯一出口做（见 `SessionSeed` 的 `endSession` /
   * `features/auth/sessionLoss.ts`）——同一个结果有两套实现，就必然有一套先坏。
   *
   * `router.replace('/')` 保留：退出之后不该留在设置这一屏。
   */
  const handleSignOut = useCallback(() => {
    signOut();
    router.replace('/');
  }, [router, signOut]);

  return (
    <NativeSettingsView
      style={{ flex: 1 }}
      mode={mode}
      viewModelJson={JSON.stringify(viewModel)}
      onOpenAgentSwitcher={openAgentSwitcher}
      onOpenBotSettings={handleOpenBotSettings}
      onOpenAppearance={handleOpenAppearance}
      onSelectLocale={handleSelectLocale}
      onOpenNotifications={handleOpenNotifications}
      onSignOut={handleSignOut}
    />
  );
}
