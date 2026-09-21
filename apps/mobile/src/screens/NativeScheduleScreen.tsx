import {
  NativeScheduleView,
  type NativeHubChromeModel,
  type NativeScheduleListViewModel,
} from '@memoh-ios/kit';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';

import type { HubView } from '../features/bots/surfaces.ts';
import { hubChromeModel } from '../features/session/hubChrome.ts';
import { useConnectionState, useSession } from '../features/session/store.tsx';
import { canManageBot } from '../features/bots/permissions.ts';
import { canRetry, reasonKeyOf } from '../features/errors/present.ts';
import { lastRunLabelKey, nextRunLabel, safeTimezone } from '../features/schedule/describe.ts';
import { scheduleSubtitleParts } from '../features/schedule/subtitle.ts';
import { useSchedules } from '../features/schedule/useSchedule.ts';
import { timezoneLine } from '../features/bots/timezones.ts';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

const DAY_KEY: Record<'today' | 'tomorrow' | 'dayAfter', string> = {
  today: 'schedule.day.today',
  tomorrow: 'schedule.day.tomorrow',
  dayAfter: 'schedule.day.dayAfter',
};

/**
 * 定时任务列表（原生）。
 *
 * `visibleView` / `hubViews` / `onViewChange` 是**可选**的 Hub 顶层件输入（模块 9），
 * 与 `NativeFilesScreen` 同一套约定：三者给全时列表页顶部会多出大标题、视图切换器、
 * agent 菜单、连接行与新建会话入口（数据由 `features/session/hubChrome.ts` 组装）。
 * 这里只影响**列表模型**——编辑页是另一屏（`NativeScheduleEditScreen`），
 * 它不画 Hub 顶层件（那里没有"三个视图"这回事）。
 */
export function NativeScheduleScreen({
  visibleView,
  hubViews,
  onViewChange,
}: {
  visibleView?: HubView;
  hubViews?: readonly HubView[];
  onViewChange?: (view: HubView) => void;
} = {}) {
  const router = useRouter();
  const t = useT();
  const { mode } = useTheme();
  const connection = useConnectionState();
  const { state, currentBot, selectBot, retryConnection, realtimeEnabled } = useSession();
  const allowed = canManageBot(currentBot);
  const schedules = useSchedules(state.client, allowed ? (currentBot?.id ?? null) : null);
  const { reload } = schedules;

  useFocusEffect(
    useCallback(() => {
      if (allowed) void reload();
    }, [allowed, reload]),
  );

  // Hub 顶层件与列表数据互不影响，各自一份记忆：刷新列表不该重算顶层件（反之亦然）。
  const hub = useMemo<NativeHubChromeModel | null>(() => {
    if (visibleView === undefined || hubViews === undefined || onViewChange === undefined) {
      return null;
    }
    return hubChromeModel(
      {
        visibleView,
        hubViews,
        bots: state.bots,
        currentBotId: state.currentBotId,
        connection,
        pendingSends: state.pendingSends,
        realtimeEnabled,
        currentBot,
      },
      t,
    );
  }, [
    connection,
    currentBot,
    hubViews,
    onViewChange,
    realtimeEnabled,
    state.bots,
    state.currentBotId,
    state.pendingSends,
    t,
    visibleView,
  ]);

  const onSelectBot = useCallback(
    (botId: string) => {
      if (botId === '__new__') {
        router.push('/bots/new');
        return;
      }
      // 选中的就是当前 agent 时什么都不做：`selectBot` 会触发整轮刷新，白刷一次。
      if (botId !== state.currentBotId) selectBot(botId);
    },
    [router, selectBot, state.currentBotId],
  );

  const viewModel = useMemo<NativeScheduleListViewModel>(() => {
    const timezone = safeTimezone(currentBot?.timezone);
    const line = timezoneLine(currentBot?.timezone);
    const rows = (schedules.data ?? []).map((schedule) => {
      const now = new Date();
      const parts = scheduleSubtitleParts(
        schedule,
        schedules.lastBySchedule[schedule.id],
        timezone,
        now,
      );
      const next = nextRunLabel(parts.nextAt, now, timezone);
      const segments: string[] = [];
      if (!schedule.enabled) segments.push(t('schedule.disabled'));
      else if (next.kind === 'unknown') segments.push(t('schedule.next.unknown'));
      else {
        const day = next.day === 'date' ? next.date : t(DAY_KEY[next.day]);
        segments.push(t('schedule.next.at', { day, time: next.time }));
      }
      const last = lastRunLabelKey(parts.last);
      if (last !== null) segments.push(t(last));
      const name = schedule.name === '' ? t('schedule.untitled') : schedule.name;
      return {
        id: schedule.id,
        name,
        subtitle: segments.join(' · '),
        enabled: schedule.enabled,
        accessibilityLabel: `${name}, ${segments.join(', ')}`,
      };
    });
    let status: NativeScheduleListViewModel['status'] = 'loading';
    if (!allowed && currentBot !== null) status = 'permission';
    else if (schedules.error !== null) status = 'error';
    else if (schedules.loading && schedules.data === null) status = 'loading';
    else if (rows.length === 0) status = 'empty';
    else status = 'ready';
    return {
      status,
      title: t('hub.view.schedule'),
      loadingLabel: t('common.loading'),
      emptyTitle: t('schedule.empty.title'),
      emptyBody: t('schedule.empty.body'),
      permissionTitle: t('schedule.permission.title'),
      permissionBody: t('schedule.permission.body'),
      errorTitle: t('schedule.error.title'),
      errorBody: schedules.error === null ? '' : t(reasonKeyOf(schedules.error)),
      retryEnabled: schedules.error !== null && canRetry(schedules.error),
      retryLabel: t(
        schedules.error !== null && canRetry(schedules.error) ? 'schedule.retry' : 'common.close',
      ),
      newLabel: t('schedule.new'),
      footer: t('schedule.footer', {
        count: rows.length,
        enabled: rows.filter((row) => row.enabled).length,
      }),
      timezone: currentBot === null ? '' : t(line.key, line.values),
      toggleEnabled: allowed,
      rows,
      hub,
    };
  }, [
    allowed,
    currentBot,
    hub,
    schedules.data,
    schedules.error,
    schedules.lastBySchedule,
    schedules.loading,
    t,
  ]);

  return (
    <View style={{ flex: 1 }}>
      <NativeScheduleView
        style={{ flex: 1 }}
        mode={mode}
        listModelJson={JSON.stringify(viewModel)}
        onRefresh={() => void schedules.reload()}
        onRetry={() => void schedules.reload()}
        onNew={() => router.push('/schedule/edit')}
        onOpen={(event) => {
          const id = event.nativeEvent.scheduleId;
          if (id) router.push(`/schedule/edit?scheduleId=${encodeURIComponent(id)}`);
        }}
        onToggle={(event) => {
          const id = event.nativeEvent.scheduleId;
          const enabled = event.nativeEvent.enabled;
          const schedule = schedules.data?.find((item) => item.id === id);
          if (id && enabled !== undefined && schedule)
            void schedules.toggleEnabled(schedule, enabled);
        }}
        onViewChange={(event) => {
          const next = event.nativeEvent.view;
          // 事件里的字符串来自原生，与模型是两条路：认不出来就丢掉，别把它当视图用。
          if (next === 'sessions' || next === 'files' || next === 'schedule') onViewChange?.(next);
        }}
        onSelectBot={(event) => {
          const botId = event.nativeEvent.botId;
          if (botId !== undefined) onSelectBot(botId);
        }}
        onNewSession={() => router.push('/chat/new')}
        onRetryConnection={() => retryConnection()}
      />
    </View>
  );
}
