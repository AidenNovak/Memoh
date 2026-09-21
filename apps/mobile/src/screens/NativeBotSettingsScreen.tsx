/**
 * bot 设置页的 RN 薄桥（模块 7）。
 *
 * ## 边界
 *
 * **原生持有**可见 UI 与直接交互：分组表单（SwiftUI inset-grouped `Form`）、页头、
 * 底部保存条、删除确认框与"未保存改动"返回拦截。**RN 保留**：取数（bot/settings/checks/
 * 模型目录）、差分保存（`patchFrom` 只发改过的字段）、删除、名称与权限判据、选择器
 * （模型/头像/语言/时区已改成**原生 sheet**：RN 只组装请求与判结论，见
 * `features/*Picker.ts`）、i18n、路由与侧滑手势开关。
 *
 * 原生侧是一份通用表单模型（`NativeBotFormModel`），本页把 `features/bots/*` 算好的
 * 结果映射成分组与行；原生不认识 bot、i18n 和路由。
 */
import {
  NativeBotFormView,
  type NativeBotFormModel,
  type NativeBotFormRow,
  type NativeBotFormSection,
} from '@memoh-ios/kit';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import type { Bot, BotCheck, BotSettings } from '../api/types.ts';
import {
  draftFrom,
  effortsFor,
  modelLabel,
  nextEffort,
  patchFrom,
  type BotSettingsDraft,
} from '../features/bots/settings.ts';
import { checksPanel, checksTechnicalText, type CheckTone } from '../features/bots/checks.ts';
import { copyText } from '../features/files/clipboard.ts';
import { announceForAccessibility } from '../lib/accessibility.ts';
import { effortLabelKey, loadCatalog, type ModelSection } from '../features/chat/models.ts';
import { avatarFor, avatarValueKey } from '../features/bots/avatar.ts';
import { nativeAvatarPlan } from '../features/bots/nativeAvatar.ts';
import { AUTO_LANGUAGE, languageLabel } from '../features/bots/languages.ts';
import { timezoneValue } from '../features/bots/timezones.ts';
import { useConnectionState, useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';
import { presentModelPicker } from '../features/chat/modelPicker.ts';
import { presentAvatarPicker } from '../features/bots/avatarPicker.ts';
import { presentLanguagePicker } from '../features/bots/languagePicker.ts';
import { presentTimezonePicker } from '../features/bots/timezonePicker.ts';
import {
  canRetry,
  presentError,
  reasonKeyOf,
  type ErrorPresentation,
} from '../features/errors/present.ts';

/** 失败时标题写哪一句：读不到 / 没保存上 / 没删掉是三件不同的事。 */
const FAILURE_TITLE_KEY: Record<'load' | 'save' | 'delete', string> = {
  load: 'botSettings.loadFailed',
  save: 'botSettings.saveFailed',
  delete: 'botSettings.deleteFailed',
};

/** 检查语气 → 表单行语气（同一套字面量，直接透传）。 */
function toneOf(tone: CheckTone): string {
  return tone;
}

function titleOf(bot: Bot): string {
  return bot.display_name !== '' ? bot.display_name : bot.name;
}

function effortLabelOf(effort: string | null, t: (key: string) => string): string {
  if (effort === null || effort === '') return '—';
  const key = effortLabelKey(effort);
  return key === null ? effort : t(key);
}

/** 复制按钮上的字：按过之后要**说出来**结果（与原 RN 版同一纪律）。 */
function copiedLabel(copied: 'ok' | 'failed' | null, t: (key: string) => string): string {
  if (copied === 'ok') return t('botSettings.checks.copied');
  if (copied === 'failed') return t('botSettings.checks.copyFailed');
  return t('botSettings.checks.copy');
}

/** `Promise.allSettled` 的结果 → 给 `presentError` 的输入。 */
function reasonOf(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'rejected' ? result.reason : undefined;
}

export function NativeBotSettingsScreen({ botId }: { botId: string }) {
  const t = useT();
  const router = useRouter();
  const { mode } = useTheme();
  const { state, refreshBots } = useSession();
  const connectionOpen = useConnectionState() === 'open';
  const client = state.client;

  const [bot, setBot] = useState<Bot | null>(null);
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [checks, setChecks] = useState<BotCheck[]>([]);
  const [draft, setDraft] = useState<BotSettingsDraft | null>(null);
  const [catalog, setCatalog] = useState<ModelSection[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{
    presentation: ErrorPresentation;
    kind: 'load' | 'save' | 'delete';
  } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** 检查组展开是**用户意图**（本地 state），不由数据推（与原 RN 版同一条纪律）。 */
  const [checksExpanded, setChecksExpanded] = useState(false);
  const [checksDetailsOpen, setChecksDetailsOpen] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);

  /** 取这一屏要的四份数据：失败态的重试也重拉这一整套。 */
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

  /** 把草稿存下去。返回"是不是真的存上了"——离开前那一步要等这个结果才决定走不走。 */
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
      // 失败就**留在这一页**并把原因摆出来——静默走掉的话用户以为存上了。
      setError({ presentation: presentError(caught), kind: 'save' });
      return false;
    } finally {
      setSaving(false);
    }
  }, [botId, client, patch, refreshBots, saving]);

  const pickModel = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await presentModelPicker({
        client: state.client,
        choice: { modelId: draft.modelId, reasoningEffort: draft.reasoningEffort },
      });
      if (outcome.status !== 'completed') return;
      update({ modelId: outcome.value.modelId, reasoningEffort: outcome.value.reasoningEffort });
    })();
  }, [draft, state.client, update]);

  const pickAvatar = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await presentAvatarPicker({ avatarUrl: draft.avatarUrl, connectionOpen });
      if (outcome.status !== 'completed') return;
      update({ avatarUrl: outcome.value.avatarUrl });
    })();
  }, [connectionOpen, draft, update]);

  const pickLanguage = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await presentLanguagePicker({ language: draft.language });
      if (outcome.status !== 'completed') return;
      update({ language: outcome.value.language });
    })();
  }, [draft, update]);

  const pickTimezone = useCallback(() => {
    if (draft === null) return;
    void (async () => {
      const outcome = await presentTimezonePicker({ timezone: draft.timezone });
      if (outcome.status !== 'completed') return;
      update({ timezone: outcome.value.timezone });
    })();
  }, [draft, update]);

  /** 真正删：确认框在原生侧，确认后回到这里。 */
  const runDelete = useCallback(() => {
    if (client === null || saving) return;
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
  }, [botId, client, refreshBots, router, saving]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);

  const copyChecks = useCallback(() => {
    const ok = copyText(checksTechnicalText(checks));
    setCopied(ok ? 'ok' : 'failed');
    announceForAccessibility(t(ok ? 'botSettings.checks.copied' : 'botSettings.checks.copyFailed'));
  }, [checks, t]);

  /** 有未保存的改动。`patchFrom` 一个字段都没变时给 `null`，所以它就是"脏"的判据。 */
  const dirty = patch !== null;

  /**
   * 有未保存的改动时**关掉侧滑返回**：侧滑不经过确认框，是最容易让改动无声消失的一条路
   * （与原 RN 版同一条纪律）。关掉之后唯一出口是左上角返回键——它一定会先问一句。
   */
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !dirty });
  }, [navigation, dirty]);

  /** 读不到时还能叫出名字的那条记录（会话列表已经拉到过的那批）。 */
  const namedBot = state.bots.find((candidate) => candidate.id === botId) ?? null;
  const checksView = checksPanel({
    checks,
    expanded: checksExpanded,
    detailsOpen: checksDetailsOpen,
    t,
  });

  const model = useMemo<NativeBotFormModel>(() => {
    const efforts = draft === null ? [] : effortsFor(draft, catalog);
    /** 还没读到 bot：整页 loading 或整页错误（带名字与否、能不能重试都判好）。 */
    if (bot === null || draft === null) {
      if (error === null) return { status: 'loading', title: '' };
      const title =
        namedBot === null
          ? t(FAILURE_TITLE_KEY[error.kind])
          : t('botSettings.loadFailed.named', { name: titleOf(namedBot) });
      return {
        status: 'error',
        title,
        errorTitle: title,
        errorBody: `${t(reasonKeyOf(error.presentation))}\n\n${t('botSettings.loadFailed.hint')}`,
        errorCanRetry: canRetry(error.presentation),
        retryLabel: t('common.retry'),
      };
    }

    const sections: NativeBotFormSection[] = [];
    sections.push({
      id: 'basics',
      header: t('botSettings.group.basics'),
      rows: [
        {
          id: 'bot-settings-display-name',
          kind: 'text',
          label: t('bots.field.displayName'),
          key: 'displayName',
          value: draft.displayName,
          placeholder: t('bots.field.displayName.placeholder'),
        },
        {
          id: 'bot-settings-avatar',
          kind: 'nav',
          label: t('avatar.row'),
          value: t(avatarValueKey(avatarFor({ avatar_url: draft.avatarUrl }))),
          action: 'pickAvatar',
        },
        {
          id: 'bot-settings-name',
          kind: 'info',
          label: t('bots.field.name'),
          value: bot.name,
          hint: t('bots.field.name.hint'),
        },
        {
          id: 'bot-settings-active',
          kind: 'toggle',
          label: t('botSettings.active'),
          key: 'isActive',
          on: draft.isActive,
        },
      ],
    });

    const tzValue = timezoneValue(draft.timezone);
    const chatRows: NativeBotFormRow[] = [
      {
        id: 'bot-settings-model',
        kind: 'nav',
        label: t('botSettings.model'),
        value: draft.modelId === null ? t('chat.model.default') : modelLabel(draft, catalog),
        action: 'pickModel',
      },
    ];
    if (efforts.length > 0) {
      chatRows.push({
        id: 'bot-settings-effort',
        kind: 'nav',
        label: t('chat.model.reasoning'),
        value: effortLabelOf(draft.reasoningEffort, t),
        action: 'cycleEffort',
      });
    }
    chatRows.push(
      {
        id: 'bot-settings-language',
        kind: 'nav',
        label: t('chatLanguage.label'),
        value:
          draft.language === AUTO_LANGUAGE ? t('chatLanguage.auto') : languageLabel(draft.language),
        action: 'pickLanguage',
      },
      {
        id: 'bot-settings-timezone',
        kind: 'nav',
        label: t('timezone.label'),
        value: tzValue === null ? '' : t(tzValue.key, tzValue.values),
        action: 'pickTimezone',
      },
    );
    sections.push({
      id: 'chat',
      header: t('botSettings.group.chat'),
      footer: t('botSettings.chat.footer'),
      rows: chatRows,
    });

    sections.push({
      id: 'desktop',
      header: t('botSettings.group.desktop'),
      footer: t('botSettings.desktop.footer'),
      rows: [
        {
          id: 'bot-settings-display-enabled',
          kind: 'toggle',
          label: t('botSettings.displayEnabled'),
          key: 'displayEnabled',
          on: draft.displayEnabled,
        },
      ],
    });

    /** 检查组：汇总行可展开（原生 nav 行），明细/技术细节照 `checksPanel` 切好的内容画。 */
    const checksRows: NativeBotFormRow[] = [];
    if (checksView.total > 0) {
      checksRows.push({
        id: 'bot-checks-summary',
        kind: 'nav',
        label: checksView.title,
        hint: checksView.hint ?? '',
        glyph: checksView.glyph,
        tone: toneOf(checksView.tone),
        action: 'toggleChecks',
      });
    } else {
      checksRows.push({
        id: 'bot-checks-summary',
        kind: 'glyph',
        label: checksView.title,
        hint: checksView.hint ?? '',
        glyph: checksView.glyph,
        tone: toneOf(checksView.tone),
      });
    }
    for (const line of checksView.lines) {
      checksRows.push({
        id: line.testID,
        kind: 'glyph',
        label: line.title,
        hint: line.action ?? '',
        glyph: line.glyph,
        tone: toneOf(line.tone),
      });
    }
    if (checksView.recheck !== undefined) {
      checksRows.push({
        id: checksView.recheck.testID,
        kind: 'nav',
        label: checksView.recheck.label,
        action: 'recheck',
      });
    }
    if (checksView.total > 0 && checksView.expanded) {
      checksRows.push({
        id: 'bot-checks-technical',
        kind: 'nav',
        label: t('botSettings.checks.technical'),
        hint: t('botSettings.checks.technical.hint'),
        action: 'toggleChecksDetails',
      });
    }
    for (const line of checksView.technical) {
      checksRows.push({ id: line.testID, kind: 'info', value: line.text, mono: true });
    }
    if (checksView.technical.length > 0) {
      checksRows.push({
        id: 'bot-checks-copy',
        kind: 'button',
        label: copiedLabel(copied, t),
        action: 'copy',
      });
    }
    sections.push({ id: 'checks', header: t('botSettings.group.checks'), rows: checksRows });

    if (error !== null) {
      const errorRows: NativeBotFormRow[] = [
        {
          id: 'bot-settings-error',
          kind: 'glyph',
          label: t(FAILURE_TITLE_KEY[error.kind]),
          hint: t(reasonKeyOf(error.presentation)),
          glyph: '✕',
          tone: 'bad',
        },
      ];
      // 读取失败（传输层）才给重试；保存失败不给——Save 就在下面，再按一次就是重试。
      if (error.kind === 'load' && canRetry(error.presentation)) {
        errorRows.push({
          id: 'bot-settings-error-retry',
          kind: 'button',
          label: t('common.retry'),
          action: 'retry',
        });
      }
      sections.push({ id: 'error', rows: errorRows });
    }

    sections.push({
      id: 'danger',
      header: t('botSettings.group.danger'),
      footer: t('botSettings.danger.footer'),
      danger: true,
      rows: [
        {
          id: 'bot-settings-delete',
          kind: 'button',
          label: t('botSettings.delete.title'),
          destructive: true,
          disabled: saving,
          action: 'delete',
        },
      ],
    });

    return {
      status: 'ready',
      title: titleOf(bot),
      subtitle: bot.name,
      // 头像计划与设置页、会话页、两个选择器**同一处组装**（`features/bots/nativeAvatar.ts`）。
      avatar: nativeAvatarPlan(draft.avatarUrl, connectionOpen),
      sections,
      saveBarVisible: dirty || savedAt !== null,
      saveBarLabel: dirty ? t('botSettings.unsaved') : t('botSettings.saved'),
      saveBarButton: dirty ? (saving ? t('botSettings.saving') : t('botSettings.save')) : '',
      saveBarBusy: saving,
      backGuard: dirty
        ? {
            title: t('botSettings.unsaved.title'),
            body: t('botSettings.unsaved.body'),
            confirmLabel: t('botSettings.unsaved.discard'),
            saveLabel: t('botSettings.unsaved.save'),
            cancelLabel: t('common.cancel'),
          }
        : undefined,
      deleteConfirm: {
        title: t('botSettings.delete.title'),
        body: t('botSettings.delete.confirm', { name: titleOf(bot) }),
        confirmLabel: t('common.delete'),
        saveLabel: '',
        cancelLabel: t('common.cancel'),
      },
    };
  }, [
    bot,
    draft,
    catalog,
    checksView,
    dirty,
    savedAt,
    saving,
    error,
    namedBot,
    copied,
    connectionOpen,
    t,
  ]);

  return (
    <View style={{ flex: 1 }}>
      <NativeBotFormView
        style={{ flex: 1 }}
        mode={mode}
        modelJson={JSON.stringify(model)}
        onRetry={() => void load()}
        onBack={leave}
        onField={(event) => {
          const key = event.nativeEvent.key;
          const value = event.nativeEvent.value ?? '';
          if (key === 'displayName') update({ displayName: value });
          else if (key === 'isActive') update({ isActive: value === 'true' });
          else if (key === 'displayEnabled') update({ displayEnabled: value === 'true' });
        }}
        onAction={(event) => {
          const action = event.nativeEvent.action;
          if (action === 'pickModel') pickModel();
          else if (action === 'pickAvatar') pickAvatar();
          else if (action === 'pickLanguage') pickLanguage();
          else if (action === 'pickTimezone') pickTimezone();
          else if (action === 'cycleEffort') {
            if (draft !== null)
              update({
                reasoningEffort: nextEffort(draft.reasoningEffort, effortsFor(draft, catalog)),
              });
          } else if (action === 'toggleChecks') {
            setChecksExpanded((previous) => {
              if (previous) setChecksDetailsOpen(false);
              return !previous;
            });
          } else if (action === 'toggleChecksDetails') {
            setChecksDetailsOpen((previous) => !previous);
            setCopied(null);
          } else if (action === 'copy') copyChecks();
          else if (action === 'recheck' || action === 'retry') void load();
          else if (action === 'save') void runSave();
          else if (action === 'delete') runDelete();
          else if (action === 'back:discard') leave();
          else if (action === 'back:save') {
            void runSave().then((saved) => {
              if (saved) leave();
            });
          }
        }}
      />
    </View>
  );
}

/** 路由：`/bots/edit?botId=…`（与 `schedule/edit` 同一个形态）。 */
export function NativeBotSettingsRoute() {
  const params = useLocalSearchParams<{ botId?: string }>();
  const botId = typeof params.botId === 'string' ? params.botId : '';
  return <NativeBotSettingsScreen botId={botId} />;
}
