import { NativeScheduleView, type NativeScheduleListViewModel } from '@memoh-ios/kit';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';

import { canManageBot } from '../features/bots/permissions.ts';
import { canRetry, reasonKeyOf } from '../features/errors/present.ts';
import { lastRunLabelKey, nextRunLabel, safeTimezone } from '../features/schedule/describe.ts';
import { scheduleSubtitleParts } from '../features/schedule/subtitle.ts';
import { useSchedules } from '../features/schedule/useSchedule.ts';
import { timezoneLine } from '../features/bots/timezones.ts';
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

const DAY_KEY: Record<'today' | 'tomorrow' | 'dayAfter', string> = {
  today: 'schedule.day.today',
  tomorrow: 'schedule.day.tomorrow',
  dayAfter: 'schedule.day.dayAfter',
};

export function NativeScheduleScreen() {
  const router = useRouter();
  const t = useT();
  const { mode } = useTheme();
  const { state, currentBot } = useSession();
  const allowed = canManageBot(currentBot);
  const schedules = useSchedules(state.client, allowed ? (currentBot?.id ?? null) : null);
  const { reload } = schedules;

  useFocusEffect(
    useCallback(() => {
      if (allowed) void reload();
    }, [allowed, reload]),
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
    };
  }, [
    allowed,
    currentBot,
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
      />
    </View>
  );
}
