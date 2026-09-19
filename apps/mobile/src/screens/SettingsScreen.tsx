/**
 * 设置页。
 *
 * ## 这一版为什么重排
 *
 * 上一版的顺序是：agent 卡片 / Account（组头"Account" + 行标题也是"Account"，值是 bot 名）
 * / Appearance（四项并列）/ Language / Sign Out / Debug。它"不太 make sense"的地方是具体的：
 *
 * 1. **组头与行标题同名**：`Account` 分组里一行也叫 `Account`，读起来像个 bug。而且那一行
 *    的值给的是 **agent 名字**、副标题给的是**服务器地址**——"我是谁登录的"这件事整页都没说。
 * 2. **`True black` 与 System/Light/Dark 并列**：它不是第四种并列的明暗模式，它是**暗色的
 *    一个变体**。四个等权重的选项里混进一个修饰项，用户会以为选它就是"真黑模式"而丢掉明暗自动。
 * 3. **服务器地址是调试信息**，摆在 Account 的副标题上；而真正该在这里的版本号没有。
 * 4. **底部被悬浮 tab 栏压住**：Debug 分组半截在 tab 栏下面（`TAB_BAR_CLEARANCE` 漏抄）。
 *
 * 新的顺序按"用户在这一屏要回答的问题"排：
 *
 * | 分组 | 回答的问题 |
 * | --- | --- |
 * | Agent | 我在跟谁说话 / 换一个 / 新建一个 |
 * | Appearance / Language | 它长什么样 |
 * | Notifications | 它什么时候来找我（入口，不是开关——见 `NotificationsScreen`） |
 * | Account | 我是谁（以及怎么登出） |
 * | About | 我在用哪个版本、连的是哪台服务器（Memoh 是自托管的，"连哪台"是真信息） |
 * | Development（仅 DEV） | 场景台与调试入口 |
 *
 * ## 形态
 *
 * 仍然是"滚动内容自己当标题栏"（`headerShown: false` 的路由，见文件末尾的注释）。
 * 外观选项下沉到 `/appearance` 子页：那里才有地方把"真黑"做成一个开关并解释它，
 * 主页面也就不会被六行一次性偏好占满。
 */
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import React from 'react';
import { Alert, ScrollView, Text, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getSession } from '../api/credentials.ts';
import { localeDisplayName, setLocale, SUPPORTED_LOCALES, type Locale } from '../lib/i18n/index.ts';
import { useT } from '../lib/i18n/useT.ts';
import { useLocale } from '../lib/i18n/useLocale.ts';
import {
  ACCESSIBILITY_FONT_SCALE,
  GROUP_INSET,
  spacing,
  TAB_BAR_CLEARANCE,
  typography,
} from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { accountNameOf } from '../features/session/account.ts';
import { canManageBot } from '../features/bots/permissions.ts';
import { useSessionActivity } from '../features/activity/useSessionActivity.ts';
import { useSession } from '../features/session/store.tsx';
import { AgentCard } from '../ui/AgentCard.tsx';
import { useAgentSwitcher } from '../ui/BotSwitcher.tsx';
import { Group, Row } from '../ui/GroupedList.tsx';
import { appearanceLabelKey } from './AppearanceScreen.tsx';

export function SettingsScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { state, currentBot, signOut } = useSession();
  const { mode } = useTheme();
  // 与「会话」tab 的外壳同一条门槛（`SessionsHubScreen.ACCESSIBILITY_FONT_SCALE`）：
  // 最大辅助字号下大标题必须一行读完，放不下就缩字号——`Settings` 会被从单词中间
  // 拆成 `Settin` / `gS`，那是视觉评审 §3.3 点名的缺陷。
  const { fontScale } = useWindowDimensions();
  const accessibilityText = fontScale >= ACCESSIBILITY_FONT_SCALE;

  const openAgentSwitcher = useAgentSwitcher();
  // 和首页用同一份聚合：两处数字不一致比不显示更糟。
  const { pending } = useSessionActivity(state.client, state.bots);
  const pendingCount = pending.length;

  // 身份来自 Keychain 里那份 profile（`/auth/login` 才有，refresh 不回传）。
  const session = getSession();
  const accountName = accountNameOf(session);

  const version = Constants.expoConfig?.version ?? '';

  /**
   * 退出登录。
   *
   * **只调 `signOut()`**：清凭据与"回登录页"由闸门那一侧的唯一出口做（见 `SessionSeed`
   * 的 `endSession` / `features/auth/sessionLoss.ts`）。这里以前自己 `clearSession()`
   * 然后重置 store——凭据是清了，但闸门的 `phase` 还停在 `signedIn`，于是人落在空壳
   * 界面上而不是登录页；同一个结果有两套实现，就必然有一套先坏。
   *
   * `router.replace('/')` 保留：退出之后不该留在设置这一屏（下一屏由闸门决定，
   * 这里是"没有凭据就回根路由"的老行为）。
   */
  const confirmSignOut = () => {
    Alert.alert(t('settings.signOut'), t('settings.signOut.confirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.signOut'),
        style: 'destructive',
        onPress: () => {
          signOut();
          router.replace('/');
        },
      },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.sm,
        // 让开悬浮的 tab 栏（见 tokens 里的 TAB_BAR_CLEARANCE）。
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        paddingHorizontal: GROUP_INSET,
      }}
    >
      {/* 这一屏是底部 tab 的根，不是被 push 进来的页——所以**没有返回箭头**。
          之前它带一个 `‹`，那是"设置还是一个 push 目标"时代的残留：tab 根上的返回箭头
          会把人送去一个他没来过的地方。 */}
      {/* 最大辅助字号下大标题**一行读完**：`Settings` 在这一档宽过屏宽，允许折行就是
          从单词中间硬拆成 `Settin` / `gS`（视觉评审 §3.3 点名的缺陷）。缩到一行放得下
          （`adjustsFontSizeToFit`）仍远大于默认档，而"拆词"没有任何一档能解释。 */}
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit={accessibilityText}
        minimumFontScale={accessibilityText ? 0.55 : undefined}
        style={[typography.largeTitle, { color: palette.label, marginBottom: spacing.lg }]}
      >
        {t('settings.title')}
      </Text>

      <Group header={t('settings.agent')}>
        <AgentCard bot={currentBot} pendingCount={pendingCount} onPress={openAgentSwitcher} />
        {/*
          bot 设置的第二个入口（切换器底部那一个是第一个）。
          卡片本身是"换一个"、不是"改这个"——两个动作合成一个目标，用户点哪个都是猜；
          桌面端也是分开的（点名字进设置、下拉换 agent）。

          **没有 `manage` 的人不出现这一行**：共享过来的 bot 是"能看能聊、不能改"，
          给他一个按下去必然 403 的入口比不给更糟（判据见 `features/bots/permissions.ts`；
          切换器那一处是同一个判断）。
        */}
        {currentBot === null || !canManageBot(currentBot) ? null : (
          <Row
            testID="settings-bot-settings"
            title={t('botSettings.open')}
            disclosure
            last
            onPress={() => router.push(`/bots/edit?botId=${encodeURIComponent(currentBot.id)}`)}
          />
        )}
      </Group>

      <Group header={t('settings.appearance')}>
        <Row
          testID="settings-appearance"
          title={t('settings.appearance')}
          value={t(appearanceLabelKey(mode))}
          disclosure
          onPress={() => router.push('/appearance')}
        />
      </Group>

      {/* 语言**单独一组**：它和外观不是同一个问题（一个管长什么样，一个管说什么话），
          组头各说各的。以前这里把两种行塞进了同一个组里，屏幕上就会出现
          「Language」组头下面接着一行「Appearance」。 */}
      <Group header={t('settings.language')}>
        {SUPPORTED_LOCALES.map((option: Locale, index) => (
          <Row
            key={option}
            testID={`settings-language-${option}`}
            // 语言名一律用**它自己的语言**写（English / 简体中文），不翻译：
            // 把 "Chinese" 翻译成"中文"给一个只看英文的人，他反而找不到自己要的那一项。
            title={localeDisplayName(option)}
            selected={locale === option}
            last={index === SUPPORTED_LOCALES.length - 1}
            onPress={() => setLocale(option)}
          />
        ))}
      </Group>

      {/* 通知**单独一组**：它回答的是第三个问题——"它什么时候来找我"。
          塞进外观或语言里都会让组头与内容对不上。这一组**不给组头**：组头写「Notifications」、
          行标题也写「Notifications」正是这个文件开头批评过的那种读起来像 bug 的形态，
          所以这里改用脚注说明它的边界。
          这一行是**入口**，不是开关：真正的权限由 iOS 持有，App 只能解释 + 给路径，
          冷启动弹一次系统框那种做法在 HIG 里是明确的反例。 */}
      <Group footer={t('settings.notifications.footer')}>
        <Row
          testID="settings-notifications"
          title={t('settings.notifications')}
          disclosure
          last
          onPress={() => router.push('/notifications')}
        />
      </Group>

      <Group header={t('settings.account')}>
        {accountName === '' ? null : (
          <Row
            title={accountName}
            subtitle={session?.role ?? undefined}
            testID="settings-account"
          />
        )}
        <Row
          testID="settings-sign-out"
          title={t('settings.signOut')}
          destructive
          last
          onPress={confirmSignOut}
        />
      </Group>

      <Group header={t('settings.about')}>
        {version === '' ? null : <Row title={t('settings.version')} value={version} />}
        <Row
          testID="settings-server"
          title={t('settings.server')}
          value={state.client?.url ?? ''}
          last
        />
      </Group>

      {__DEV__ ? (
        <Group header={t('settings.debug')}>
          <Row
            testID="settings-scenes"
            title="Scenes"
            subtitle="固定场景截图"
            disclosure
            onPress={() => router.push('/debug/scene')}
          />
          <Row
            title="Debug"
            testID="settings-debug"
            last
            disclosure
            onPress={() => router.push('/debug')}
          />
        </Group>
      ) : null}
    </ScrollView>
  );
}
