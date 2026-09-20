/**
 * bot 设置页。
 *
 * ## 与桌面端的关系
 *
 * 桌面端的 bot 详情有**十几个 tab**（overview / container / remote-runtime / memory /
 * channels / access / tool-approval / hooks / email / mcp / compaction / schedule / skills /
 * desktop / network / agents / backup…）。手机上照搬每一个都会变成一堆难用的表单，
 * 所以这一页只保留**手机上真会改**的那几组，但**字段与说法跟桌面端对齐**：
 *
 * | 这一页 | 桌面端对应 | 为什么它值得在手机上 |
 * | --- | --- | --- |
 * | 基本信息 | overview（名字可改） | 名字/头像是最常改的 |
 * | 对话 | settings 的 Global Settings（chat model / reasoning / **language**） | 手机上最需要"换个模型再问"、"让它说中文" |
 * | 桌面 | desktop tab（`display_enabled` 开关） | 开了它 agent 才能用 GUI 工具 |
 * | 检查 | overview 的 "View diagnostics" / `bot-checks-panel` | 切换器上那句"N 项未通过"就指这里 |
 * | 危险操作 | overview 的 Danger Zone | 手机上也想删掉一个用不着的 bot |
 *
 * **不搬**：容器镜像/快照/数据恢复、channels（Telegram 等绑定的表单）、access/ACL 规则编辑器、
 * tool-approval 策略、记忆/压缩/多媒体模型、MCP/connectors、备份导入导出。那些要么是
 * 桌面形态的操作（拖拽、多列表单），要么要凭据，要么手机上"看一眼"就够了——都不该在这里
 * 变成一个半成品表单。
 *
 * ## 保存的语义
 *
 * 只发**改过的字段**（`features/bots/settings.ts` 的 `patchFrom`）：服务端是指针语义，
 * 全量回传会把桌面端同时改的字段覆盖掉。一个字段都没改时按钮是禁用的。
 *
 * 本体（名字/头像/启用）走 `PUT /bots/{id}`，设置（模型/强度/桌面开关）走
 * `POST /bots/{id}/settings`——两条路各自的事务与校验都不同，合成一个请求是客户端的方便、
 * 服务端的麻烦。
 */
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Bot, BotCheck, BotSettings } from '../api/types.ts';
import {
  draftFrom,
  effortsFor,
  modelLabel,
  nextEffort,
  patchFrom,
  type BotSettingsDraft,
} from '../features/bots/settings.ts';
import {
  CHECK_COLOR_ROLE,
  checksPanel,
  checksTechnicalText,
  type CheckTone,
  type ChecksPanel,
} from '../features/bots/checks.ts';
import { copyText } from '../features/files/clipboard.ts';
import { announceForAccessibility } from '../lib/accessibility.ts';
import { effortLabelKey, loadCatalog, type ModelSection } from '../features/chat/models.ts';
import { avatarFor, avatarValueKey } from '../features/bots/avatar.ts';
import { AUTO_LANGUAGE, languageLabel } from '../features/bots/languages.ts';
import { timezoneValue } from '../features/bots/timezones.ts';
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, radius, radiusStyle, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { Group, Row } from '../ui/GroupedList.tsx';
import { BackButton } from '../ui/BackButton.tsx';
import { BotAvatar } from '../ui/BotAvatar.tsx';
import { present } from '../lib/presentation/index.ts';
import { ModelPickerSheet } from '../ui/ModelPickerPage.tsx';
import { AvatarPickerSheet } from '../ui/AvatarPickerPage.tsx';
import { LanguagePickerSheet } from '../ui/LanguagePickerPage.tsx';
import { TimezonePickerSheet } from '../ui/TimezonePickerPage.tsx';
import {
  canRetry,
  presentError,
  reasonKeyOf,
  type ErrorPresentation,
} from '../features/errors/present.ts';
import { ErrorNotice } from '../ui/ErrorNotice.tsx';

export function BotSettingsScreen({ botId }: { botId: string }) {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, refreshBots } = useSession();
  const client = state.client;

  const [bot, setBot] = useState<Bot | null>(null);
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [checks, setChecks] = useState<BotCheck[]>([]);
  const [draft, setDraft] = useState<BotSettingsDraft | null>(null);
  const [catalog, setCatalog] = useState<ModelSection[] | null>(null);
  const [saving, setSaving] = useState(false);
  /**
    失败分三种，标题不同（读不到 / 没保存上 / 没删掉），所以连"是哪一件事"一起记。
    存 `presentError()` 的结论而不是一个字符串：**能不能重试跟着错误的性质走**。
   */
  const [error, setError] = useState<{
    presentation: ErrorPresentation;
    kind: 'load' | 'save' | 'delete';
  } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /**
   检查组的两级展开：**默认都收起**。

   为什么是本地 state 而不是"数据来了就展开"：这是**用户意图**。刷新（重试/重新检查）会
   换掉 `checks` 数组，若展开状态是从数据推出来的，用户刚点开的技术细节会被一次刷新合上
   （原生侧同一条纪律：`ErrorExpansionState` 按块记，见 R51）。
   */
  const [checksExpanded, setChecksExpanded] = useState(false);
  const [checksDetailsOpen, setChecksDetailsOpen] = useState(false);
  /** 复制反馈（"已复制"/"没复制上"）。不自动消失（R33）。 */
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);

  /**
   * 取这一屏要的四份数据。
   *
   * 抽成 callback 而不是写在 effect 里，是为了让失败态的"重试"能真的重拉这一整套
   * ——只重发其中一个请求的话，界面上那两块还是空的，重试看起来就"没用"。
   */
  const load = useCallback(async () => {
    if (client === null || botId === '') return;
    const results = await Promise.allSettled([
      client.getBot(botId),
      client.getBotSettings(botId),
      client.listBotChecks(botId),
    ]);
    const fetchedBot = results[0].status === 'fulfilled' ? results[0].value : null;
    if (fetchedBot !== null) setBot(fetchedBot);
    const fetchedSettings = results[1].status === 'fulfilled' ? results[1].value : null;
    setSettings(fetchedSettings);
    if (results[2].status === 'fulfilled') setChecks(results[2].value.items ?? []);
    if (fetchedBot !== null) {
      setDraft(draftFrom(fetchedBot, fetchedSettings));
      setError(null);
      return;
    }
    // 别把 `results[0].reason` 直接倒出来：那是 `HTTP 500` 这种给开发者看的东西。
    setError({ presentation: presentError(reasonOf(results[0])), kind: 'load' });
  }, [botId, client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void loadCatalog(client)
      .then((sections) => {
        if (!cancelled) setCatalog(sections);
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const patch = useMemo(
    () => (bot === null || draft === null ? null : patchFrom(bot, settings, draft)),
    [bot, draft, settings],
  );

  const update = useCallback((next: Partial<BotSettingsDraft>) => {
    setDraft((previous) => (previous === null ? previous : { ...previous, ...next }));
    setSavedAt(null);
  }, []);

  /**
   把草稿存下去。返回"是不是真的存上了"——离开前那一步要等这个结果才决定走不走。
  */
  const runSave = useCallback(async (): Promise<boolean> => {
    if (client === null || patch === null || saving) return false;
    setSaving(true);
    setError(null);
    try {
      // 只发改过的那部分。两条路各自独立：本体变了才 PUT，设置变了才 POST。
      if (Object.keys(patch.bot).length > 0) {
        const updated = await client.updateBot(botId, patch.bot);
        setBot(updated);
      }
      if (Object.keys(patch.settings).length > 0) {
        const updated = await client.updateBotSettings(botId, patch.settings);
        setSettings(updated);
      }
      await refreshBots();
      setSavedAt(Date.now());
      return true;
    } catch (caught) {
      // 失败就**留在这一页**并把原因摆在上面（`bot-settings-error`）——
      // 静默走掉的话用户以为存上了，而这正是这一轮要修的那件事。
      setError({ presentation: presentError(caught), kind: 'save' });
      return false;
    } finally {
      setSaving(false);
    }
  }, [botId, client, patch, refreshBots, saving]);

  const save = useCallback(() => {
    void runSave();
  }, [runSave]);

  const pickModel = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await present(ModelPickerSheet, {
        modelId: draft.modelId,
        reasoningEffort: draft.reasoningEffort,
      });
      if (outcome.status !== 'completed') return;
      // 这里**保留原样**（不套 verifiedChoice）：用户在设置页选完就想马上看到它，
      // 保存时再核一遍目录（见 save 里的 patchFrom + verifiedModelId）。
      update({ modelId: outcome.value.modelId, reasoningEffort: outcome.value.reasoningEffort });
    })();
  }, [draft, update]);

  /**
   头像：**挑是主路径**（内置选择器），手打网址降级成选择器里的次要分组。

   为什么不再是页面上一个纯手输框：那要求用户**先自己有一个图片地址**——把我们的实现细节
   （"头像是 URL"）当成用户的前提。理由、落库形态（`memoh:avatar/<slug>`）与代价都写在
   `features/bots/avatarPresets.ts` 的文件头。
   */
  const pickAvatar = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await present(AvatarPickerSheet, { avatarUrl: draft.avatarUrl });
      if (outcome.status !== 'completed') return;
      update({ avatarUrl: outcome.value.avatarUrl });
    })();
  }, [draft, update]);

  /**
   语言选择器（桌面端 Global Settings 的第一行）。
   与模型那一条同样是"选完就是草稿"，保存时才发出去——服务端是差分语义，
   中途改主意只要不点保存就什么都没发生。
   */
  const pickLanguage = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await present(LanguagePickerSheet, { language: draft.language });
      if (outcome.status !== 'completed') return;
      update({ language: outcome.value.language });
    })();
  }, [draft, update]);

  const pickTimezone = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await present(TimezonePickerSheet, { timezone: draft.timezone });
      if (outcome.status !== 'completed') return;
      update({ timezone: outcome.value.timezone });
    })();
  }, [draft, update]);

  const confirmDelete = useCallback(() => {
    if (client === null || bot === null || saving) return;
    Alert.alert(
      t('botSettings.delete.title'),
      t('botSettings.delete.confirm', { name: titleOf(bot) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            setSaving(true);
            void (async () => {
              try {
                await client.deleteBot(botId);
                await refreshBots();
                router.back();
              } catch (caught) {
                setError({ presentation: presentError(caught), kind: 'delete' });
                setSaving(false);
              }
            })();
          },
        },
      ],
    );
  }, [bot, botId, client, refreshBots, router, saving, t]);

  const efforts = draft === null ? [] : effortsFor(draft, catalog);
  /** 时区那一行的值（"Asia/Shanghai" 或 "继承（UTC）"）。纯逻辑给的 key + 插值。 */
  const tzValue = draft === null ? null : timezoneValue(draft.timezone);

  /** 有未保存的改动。`patchFrom` 一个字段都没变时给 `null`，所以它就是"脏"的判据。 */
  const dirty = patch !== null;

  /**
   检查组的可见内容（汇总 / 人话明细 / 技术细节的原文）。

   判据全在 `features/bots/checks.ts`（服务端发的是 `ok`、`runtime_id=…`、"Initialization
   finished." 那种给开发看的东西，直接上屏就是真机截图那一版）。这里只把它的结论画出来。
   */
  const checksView: ChecksPanel = checksPanel({
    checks,
    expanded: checksExpanded,
    detailsOpen: checksDetailsOpen,
    t,
  });

  /** 展开/收起。收起时把技术细节也收回去（下一级不该在看不见的地方还开着）。 */
  const toggleChecks = useCallback(() => {
    setChecksExpanded((previous) => {
      if (previous) setChecksDetailsOpen(false);
      return !previous;
    });
  }, []);

  const toggleChecksDetails = useCallback(() => {
    setChecksDetailsOpen((previous) => !previous);
    setCopied(null);
  }, []);

  /**
   复制技术细节。

   为什么要能复制：自托管部署的运维就是用户本人（`docs/research/ios-error-and-feedback.md`
   R47），排障时他要的是把 `runtime_id=…` 那一串贴进日志或反馈里，而不是在手机上看着它。
   结果要**说出来**（读屏也念一遍）——不然用户不知道自己按的那一下有没有生效。
   */
  const copyChecks = useCallback(() => {
    const ok = copyText(checksTechnicalText(checks));
    setCopied(ok ? 'ok' : 'failed');
    announceForAccessibility(t(ok ? 'botSettings.checks.copied' : 'botSettings.checks.copyFailed'));
  }, [checks, t]);

  /**
   走人（返回键与"离开前问一句"里选了走的那条都走这里）。
  */
  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);

  /**
   返回键的前置：**有未保存的改动就先问一句**。

   拦的理由：保存键在长表单最底（改第一栏要滚十几屏），返回键却一直在手边。不拦的话
   用户的真实路径（改一栏 → 返回）就是"改动无声消失"，而且他会在下次打开时才发现。

   返回 `false` = "这一下不让走"；之后去哪由弹窗上选的那一项决定（存完再走 / 直接走 / 留下）。
  */
  const guardLeave = useCallback((): boolean => {
    if (!dirty) return true;
    Alert.alert(t('botSettings.unsaved.title'), t('botSettings.unsaved.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('botSettings.unsaved.discard'), style: 'destructive', onPress: leave },
      {
        text: t('botSettings.unsaved.save'),
        // 存完**确认成功了**才走：存失败就留在这一页把原因摆出来，不许"装作存过"。
        onPress: () => {
          void runSave().then((saved) => {
            if (saved) leave();
          });
        },
      },
    ]);
    return false;
  }, [dirty, leave, runSave, t]);

  /**
   有未保存的改动时**关掉侧滑返回**。

   侧滑是原生手势，不经过我们（`BackButton` 的拦不住它），而它恰好是最容易让改动无声消失的
   一条路。关掉之后这一屏唯一的出口是左上角那颗返回键——它一定会先问一句。
  */
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !dirty });
  }, [navigation, dirty]);

  /**
   这一屏还没读到 bot 时可以叫出名字的那条记录（会话列表已经拉到过的那批）。

   为什么要在这里找：取 `GET /bots/{id}` 失败时手上只剩一个 uuid，而**"this agent" 说不出
   是哪一个**——用户是从某个 agent 点进来的，屏幕却不肯确认是它。列表通常在进这一屏之前
   就已经在内存里了（从设置页/切换器/首页点进来的人都先看过列表），所以这一条基本都能命中；
   真命中不了就退回不带名字的那句，而不是编一个。
  */
  const namedBot = state.bots.find((candidate) => candidate.id === botId) ?? null;

  if (bot === null || draft === null) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: palette.groupedBackground,
          paddingTop: insets.top + spacing.sm,
        }}
      >
        {/*
          头部：**读不到也要有退路**。

          全局 `headerShown: false`，原生返回箭头不存在；改前 `BackButton` 只画在"读到了"
          那一支里，于是这一屏唯一的出路是 iOS 的边缘侧滑手势——不知道这个手势的人就卡在
          这里。服务端 500 也会走这一支；读不到不是用户的错，也不该变成死路。
          加载中同样给（慢的时候更要能退）。
        */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            paddingHorizontal: GROUP_INSET,
            minHeight: 44,
          }}
        >
          <BackButton testID="bot-settings-back" fallback="/settings" />
          {namedBot === null ? null : (
            <Text numberOfLines={1} style={[typography.title3, { color: palette.label, flex: 1 }]}>
              {titleOf(namedBot)}
            </Text>
          )}
        </View>
        <View style={{ paddingHorizontal: GROUP_INSET }}>
          {error === null ? (
            <ActivityIndicator color={palette.secondaryLabel} />
          ) : (
            /* 整页都取不到：这一屏没有可显示的内容，所以错误块占的就是内容的位置。
               能不能重试仍然看错误的性质（只有传输层失败才给）。 */
            <>
              <ErrorNotice
                testID="bot-settings-error"
                title={
                  namedBot === null
                    ? t(FAILURE_TITLE_KEY[error.kind])
                    : t('botSettings.loadFailed.named', { name: titleOf(namedBot) })
                }
                reason={t(reasonKeyOf(error.presentation))}
                action={
                  canRetry(error.presentation)
                    ? { label: t('common.retry'), onPress: () => void load() }
                    : undefined
                }
              />
              {/* 说清"有没有丢东西"：连不上服务端时用户第一反应是"我的 agent 是不是没了"。
                  这句话回答它，并且把两个动作（重试 / 返回）都点出来。 */}
              <Text
                style={[
                  typography.footnote,
                  {
                    color: palette.secondaryLabel,
                    marginTop: spacing.md,
                    marginHorizontal: spacing.xs,
                  },
                ]}
              >
                {t('botSettings.loadFailed.hint')}
              </Text>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1, backgroundColor: palette.groupedBackground }}
        contentContainerStyle={{
          paddingTop: insets.top + spacing.sm,
          paddingBottom: insets.bottom + spacing.xxl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 头部：头像是同一个组件（有自定义头像就用，没有就用吉祥物） */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            paddingHorizontal: GROUP_INSET,
            marginBottom: spacing.lg,
          }}
        >
          <BackButton testID="bot-settings-back" fallback="/settings" guard={guardLeave} />
          {/* 用**草稿**而不是已保存的 bot 画：挑完头像要马上在这里看到结果，否则"点了一下
              什么都没变"，用户只能靠保存后再回列表去确认。 */}
          <BotAvatar bot={{ avatar_url: draft.avatarUrl }} size={44} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[typography.title2, { color: palette.label }]} numberOfLines={1}>
              {titleOf(bot)}
            </Text>
            <Text
              style={[typography.footnote, { color: palette.secondaryLabel }]}
              numberOfLines={1}
            >
              {bot.name}
            </Text>
          </View>
        </View>

        <Group header={t('botSettings.group.basics')}>
          <Row
            testID="bot-settings-display-name"
            title={t('bots.field.displayName')}
            accessory={
              <TextInput
                testID="bot-settings-display-name-input"
                value={draft.displayName}
                onChangeText={(displayName) => update({ displayName })}
                placeholder={t('bots.field.displayName.placeholder')}
                placeholderTextColor={palette.tertiaryLabel}
                style={[
                  typography.body,
                  {
                    color: palette.label,
                    minWidth: 96,
                    // 上限 55%：最大辅助字号下，输入框的内容会把标签挤成 "Nam/e" 这种断词
                    // （真机截图里就是这样）。给输入框一个宽度上限，标签那一列就总有约 45%
                    // 可用；值太长时输入框自己横向滚动（它是可编辑的，这比读不出的标签好）。
                    maxWidth: '55%',
                    textAlign: 'right',
                  },
                ]}
              />
            }
          />
          <Row
            testID="bot-settings-avatar"
            // 这一行**不再叫 "Avatar URL"**：旧名字说的是它的实现（一个字符串字段），而它现在
            // 是一个选择器。两页用的是同一个键与同一个选择器（新建页 2026-09-18 跟上），
            // "Avatar URL" 这个说法整个 App 里已经没有落点了。
            title={t('avatar.row')}
            // 右边只说"选的是哪一种"（默认 / 某一枚内置 / 自定义），不摆值本身：
            // 内置是一个标识、自定义是一串网址，摆上去都会把标签挤没（真机截图上
            // "Avata/r URL" 就是这么来的）。具体长什么样，看页头那枚 44pt 的头像。
            value={t(avatarValueKey(avatarFor({ avatar_url: draft.avatarUrl })))}
            disclosure
            onPress={pickAvatar}
          />
          {/* 链接名只读：它是这个 bot 的**地址**，改它等于把别人手里的链接换掉。
            桌面端也把它和显示名分开（显示名可改、name 是身份）。 */}
          <Row
            testID="bot-settings-name"
            title={t('bots.field.name')}
            subtitle={t('bots.field.name.hint')}
            value={bot.name}
          />
          <Row
            testID="bot-settings-active"
            title={t('botSettings.active')}
            last
            accessory={
              <Switch
                testID="bot-settings-active-switch"
                // 开关自己就是读屏元素，标题在旁边的 <Text> 里——不补 label 的话
                // VoiceOver 只念"开关, 已打开"，说不出在开关哪一项（HIG：控件的标签
                // 要说明它控制什么）。
                accessibilityLabel={t('botSettings.active')}
                value={draft.isActive}
                onValueChange={(isActive) => update({ isActive })}
              />
            }
          />
        </Group>

        <Group header={t('botSettings.group.chat')} footer={t('botSettings.chat.footer')}>
          <Row
            testID="bot-settings-model"
            title={t('botSettings.model')}
            value={draft.modelId === null ? t('chat.model.default') : modelLabel(draft, catalog)}
            disclosure
            onPress={pickModel}
          />
          {efforts.length === 0 ? null : (
            <Row
              testID="bot-settings-effort"
              title={t('chat.model.reasoning')}
              selected={false}
              value={effortLabelOf(draft.reasoningEffort, t)}
              disclosure
              // 强度复用 composer 那套档位（同一份服务端能力），所以这里只切换、不另开页面：
              // 点一下在可选项里循环。桌面端是一个下拉，手机上循环点击更省一次跳转。
              onPress={() =>
                update({ reasoningEffort: nextEffort(draft.reasoningEffort, efforts) })
              }
            />
          )}
          {/* 对话语言 = 桌面端 Global Settings 的第一行（`language`）。放在"对话"这一组，
              因为它和模型一样是"这个 bot 怎么跟你说话"。
              强度那一行可缺（模型不支持思考），所以**最后一行是它或语言行**，
              这里跟着 efforts 的有无决定谁画收尾的发丝线。 */}
          <Row
            testID="bot-settings-language"
            title={t('chatLanguage.label')}
            value={
              draft.language === AUTO_LANGUAGE
                ? t('chatLanguage.auto')
                : languageLabel(draft.language)
            }
            last={false}
            disclosure
            onPress={pickLanguage}
          />
          {/*
            执行时区（bot 记录上的 `timezone`）。

            为什么它必须能在手机上改：服务端的**下一次执行时刻只能按它算**
            （`internal/schedule/service.go` 的 `resolveBotLocation`）。iOS 以前只能**读**
            这一个字段，于是"定时任务里写的 09:00 是哪个 09:00"在手机上既看不到也改不了。
            裁决（`docs/research/lody-desktop-vs-ios-feature-surface.md` §3.1）就是"要做，
            但形态是可搜索的 push 选择页"——419 项摊在设置行上没人找得到。
          */}
          <Row
            testID="bot-settings-timezone"
            title={t('timezone.label')}
            value={tzValue === null ? '' : t(tzValue.key, tzValue.values)}
            last
            disclosure
            onPress={pickTimezone}
          />
        </Group>

        <Group header={t('botSettings.group.desktop')} footer={t('botSettings.desktop.footer')}>
          <Row
            testID="bot-settings-display-enabled"
            title={t('botSettings.displayEnabled')}
            last
            accessory={
              <Switch
                testID="bot-settings-display-switch"
                accessibilityLabel={t('botSettings.displayEnabled')}
                value={draft.displayEnabled}
                onValueChange={(displayEnabled) => update({ displayEnabled })}
              />
            }
          />
        </Group>

        {/*
          运行检查：**默认只有一行汇总**，展开才看明细，技术细节再展开一次。

          改前这一组是服务端原文的三列直排（`summary` / `detail` / `status`），真机上长成
          一列 `ok` + "Initialization finished." + `runtime_id=workspace-…`——那是开发输出，
          不是给用户看的读数（判据见 `features/bots/checks.ts` 的文件头与
          `docs/research/ios-error-and-feedback.md` 的 R23/R45/R47）。

          形态上刻意复用现有的两个组件：汇总行与明细行都是 `Row`（带头的状态符号走它的
          `icon` 槽），所以间距、分隔线、点按高亮与别的分组**完全一致**——这一屏没有自己的样式。
        */}
        <Group header={t('botSettings.group.checks')}>
          <Row
            testID="bot-checks-summary"
            icon={<CheckGlyph glyph={checksView.glyph} tone={checksView.tone} />}
            title={checksView.title}
            subtitle={checksView.hint}
            disclosure={checksView.total > 0}
            last={checksTail(checksView) === 'summary'}
            accessibilityHint={t(
              checksView.expanded ? 'botSettings.checks.collapse' : 'botSettings.checks.expand',
            )}
            onPress={checksView.total > 0 ? toggleChecks : undefined}
          />

          {checksView.lines.map((line) => (
            <Row
              key={line.testID}
              testID={line.testID}
              icon={<CheckGlyph glyph={line.glyph} tone={line.tone} />}
              title={line.title}
              // 未通过的那一条占两份重量：符号 + "下一步"这句话。正常项不摆动作。
              subtitle={line.action}
              destructive={line.tone === 'bad'}
              // 明细行**永远不是最后一行**：它只有在展开时才存在，而展开时后面一定跟着
              // "技术细节"那一行（`checksTail` 只在展开时才可能返回 non-summary）。
              last={false}
            />
          ))}

          {checksView.recheck === undefined ? null : (
            // 下一步是真的能点的：重新拉一次检查（可能与刚才不一样）。
            // 只用 `Row` —— 这一组的动作不需要新控件。
            <Row
              testID={checksView.recheck.testID}
              title={checksView.recheck.label}
              disclosure
              last={false}
              onPress={() => void load()}
            />
          )}

          {checksView.total === 0 || !checksView.expanded ? null : (
            <Row
              testID="bot-checks-technical"
              title={t('botSettings.checks.technical')}
              subtitle={t('botSettings.checks.technical.hint')}
              disclosure
              last={checksTail(checksView) === 'technical'}
              onPress={toggleChecksDetails}
            />
          )}

          {checksView.technical.length === 0 ? null : (
            /* 技术细节：服务端原文（含 `runtime_id=…` 这类标识符）**原样**留着，可选中、可复制。
               它是排障与反馈的入口，所以是"收起来"而不是"删掉"。 */
            <View
              style={{
                paddingHorizontal: GROUP_INSET,
                paddingTop: spacing.sm,
                paddingBottom: spacing.lg,
                gap: spacing.sm,
              }}
            >
              {checksView.technical.map((line) => (
                <Text
                  key={line.testID}
                  testID={line.testID}
                  selectable
                  style={[typography.mono, { color: palette.secondaryLabel }]}
                >
                  {line.text}
                </Text>
              ))}
              <Pressable
                testID="bot-checks-copy"
                accessibilityRole="button"
                accessibilityLabel={t('botSettings.checks.copy')}
                onPress={copyChecks}
                // 与 `ui/ErrorNotice.tsx` 的动作按钮同一套尺寸（描边胶囊、44pt、贴左不撑满）。
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: spacing.lg,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: palette.separator,
                  backgroundColor: pressed ? palette.field : 'transparent',
                  ...radiusStyle(radius.pill),
                  alignSelf: 'flex-start',
                })}
              >
                <Text style={[typography.subhead, { color: palette.accent }]}>
                  {copiedLabel(copied, t)}
                </Text>
              </Pressable>
            </View>
          )}
        </Group>

        {error === null ? null : (
          <View style={{ paddingHorizontal: GROUP_INSET, marginBottom: spacing.sm }}>
            <ErrorNotice
              testID="bot-settings-error"
              title={t(FAILURE_TITLE_KEY[error.kind])}
              reason={t(reasonKeyOf(error.presentation))}
              action={
                /* 保存失败不给按钮：Save 就在下面，再按一次就是重试。
                   读取失败如果是传输层问题才给重试（重拉三个端点）。 */
                error.kind === 'load' && canRetry(error.presentation)
                  ? { label: t('common.retry'), onPress: () => void load() }
                  : undefined
              }
            />
          </View>
        )}

        {/*
          危险操作：与上面的设置**结构性隔开**——`tone="danger"` 给它多一段空白，组头也跟着
          变色，footer 说清后果。改前它只是列表的最后一行（"Delete this bot" 挤在底部），
          区分手段只有一个红字（真机截图的观感）。
        */}
        <Group
          header={t('botSettings.group.danger')}
          footer={t('botSettings.danger.footer')}
          tone="danger"
        >
          <Row
            testID="bot-settings-delete"
            title={t('botSettings.delete.title')}
            destructive
            last
            onPress={confirmDelete}
          />
        </Group>
      </ScrollView>

      {/*
        保存条：**有未保存的改动时才出现**，吸附在屏幕（或键盘）底部。

        为什么不能留在长表单最底：改第一栏要滚十几屏才够得到它，用户不会去找；而
        "改完就走"拿到的是一句**没有落点的静默丢失**。放在这里之后：
        - "有未保存的改动"这件事**看得见**（`botSettings.unsaved`），读屏也念得出来；
        - 保存键**永远在手边**，且措辞是"Save/保存"（提交改动），不再是 iOS 语义里的
          "Done"（我看完了）；
        - 没改动时整条不画——不再有一颗常驻的禁用按钮占位又误导。
        存在 `KeyboardAvoidingView` 里面、`ScrollView` 外面：键盘升起时它跟着抬到键盘上方，
        不会被键盘盖住。
      */}
      {dirty || savedAt !== null ? (
        <View
          testID="bot-settings-save-bar"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
            paddingHorizontal: GROUP_INSET,
            paddingTop: spacing.sm,
            paddingBottom: spacing.sm,
            backgroundColor: palette.groupedBackground,
          }}
        >
          <Text
            style={[typography.footnote, { color: palette.secondaryLabel, flex: 1 }]}
            numberOfLines={1}
          >
            {/* 有改动 / 刚存上，两句话都常驻可见：用户离开前最后看到的就是这一行。 */}
            {dirty ? t('botSettings.unsaved') : t('botSettings.saved')}
          </Text>
          {dirty ? (
            <Pressable
              testID="bot-settings-save"
              accessibilityRole="button"
              accessibilityLabel={t('botSettings.save')}
              accessibilityState={{ disabled: saving }}
              disabled={saving}
              onPress={save}
              /*
                提交动作的样子：**实心品牌色胶囊、宽度跟着字走**。

                改前是一块贴满整行、只有文字是紫色的浅色垫（真机截图里的 "Done" 就是那种
                观感——像一块色块，不像一个按钮）。实心填充 + 胶囊 + 不撑满是本仓库既有的
                "主要动作"画法（`ui/ApprovalPage.tsx` 的允许按钮用同一对颜色 token），
                所以这不是给这一屏发明的样式。
              */
              style={({ pressed }) => ({
                minHeight: 44,
                paddingHorizontal: spacing.xl,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? palette.accentPressed : palette.accent,
                opacity: saving ? 0.5 : 1,
                ...radiusStyle(radius.pill),
              })}
            >
              <Text style={[typography.headline, { color: palette.onAccent }]}>
                {saving ? t('botSettings.saving') : t('botSettings.save')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

/**
 * 失败时标题写哪一句。封闭集合用字典映射，不叠三元（`AGENTS.md`）。
 * "读不到这个 bot" 与 "没保存上" 与 "没删掉" 是三件不同的事——共用一句话会让用户
 * 以为是同一个故障（比如以为整个 bot 都没了）。
 */
const FAILURE_TITLE_KEY: Record<'load' | 'save' | 'delete', string> = {
  load: 'botSettings.loadFailed',
  save: 'botSettings.saveFailed',
  delete: 'botSettings.deleteFailed',
};

/**
 * `Promise.allSettled` 的结果 → 给 `presentError` 的输入。
 *
 * 被拒的那一支的 `reason` 就是原来抛出来的那个值（多半是 `ApiError`）；
 * 这一步只是把类型收窄，不改变"没拿到"这个语义。
 */
function reasonOf(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'rejected' ? result.reason : undefined;
}

function titleOf(bot: Bot): string {
  return bot.display_name !== '' ? bot.display_name : bot.name;
}

function effortLabelOf(effort: string | null, t: (key: string) => string): string {
  if (effort === null || effort === '') return '—';
  const key = effortLabelKey(effort);
  return key === null ? effort : t(key);
}

/**
 * 检查组最后一行是谁——决定要不要画那根发丝线（`Row` 的 `last`）。
 *
 * 行的次序是固定的：汇总 → 明细 → 重新检查 → 技术细节 → 原文块。所以"最后一行"由
 * "哪几块在场"唯一决定。封闭集合用 `if` 依次判，不叠三元（`AGENTS.md`）。
 */
function checksTail(panel: ChecksPanel): 'block' | 'technical' | 'summary' {
  if (!panel.expanded) return 'summary';
  if (panel.technical.length > 0) return 'block';
  return 'technical';
}

/**
 * 错误状态行的符号颜色。语气 → palette 里的语义色（颜色只是第二遍强化，符号才是第一遍）。
 *
 * **符号不跟随动态字号**（`allowFontScaling={false}` + `typography.body` 的 17pt）：
 * 它坐在 `Row` 的 29×29 图标槽里，而那个槽是给固定尺寸的图标用的（同一个槽在通知页里放的是
 * `SymbolView size={17}`）。真机实测（2026-09-17，AX XXXL，`~/tmp/botchecks-shots/after2`）：
 * 跟随字号时 ✕ 会长到 53pt，从 29pt 的槽里溢出来，屏幕上只剩一个被切掉的三角碎片——大字号
 * 下"符号坏了"，而这正是这一轮要修的观感问题。语义由行文字（"检查未通过"）与颜色承担，
 * 符号只做第一眼的强化，所以它固定尺寸是对的。
 */
function CheckGlyph({ glyph, tone }: { glyph: string; tone: CheckTone }) {
  const palette = usePalette();
  return (
    <Text
      allowFontScaling={false}
      style={[typography.body, { color: palette[CHECK_COLOR_ROLE[tone]] }]}
    >
      {glyph}
    </Text>
  );
}

/** 复制按钮上的字：按过之后要**说出来**结果，不靠按钮自己变没变来暗示。 */
function copiedLabel(copied: 'ok' | 'failed' | null, t: (key: string) => string): string {
  if (copied === 'ok') return t('botSettings.checks.copied');
  if (copied === 'failed') return t('botSettings.checks.copyFailed');
  return t('botSettings.checks.copy');
}

/** 路由：`/bots/edit?botId=…`（与 `schedule/edit` 同一个形态）。 */
export function BotSettingsRoute() {
  const params = useLocalSearchParams<{ botId?: string }>();
  const botId = typeof params.botId === 'string' ? params.botId : '';
  return <BotSettingsScreen botId={botId} />;
}
