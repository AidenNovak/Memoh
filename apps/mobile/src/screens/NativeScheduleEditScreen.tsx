import { NativeScheduleView, type NativeScheduleEditorViewModel } from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { canManageBot } from '../features/bots/permissions.ts';
import { reasonKeyOf } from '../features/errors/present.ts';
import { nextRunLabel, parseMaxCalls, safeTimezone } from '../features/schedule/describe.ts';
import { nextRunAt } from '../features/schedule/cron.ts';
import { checkRunTarget, selectedSessionLabel } from '../features/schedule/runTarget.ts';
import { useScheduleEditor, type ScheduleDraft } from '../features/schedule/useSchedule.ts';
import { timezoneLine } from '../features/bots/timezones.ts';
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';
import { present } from '../lib/presentation/index.ts';
import { CronPickerSheet } from '../ui/CronPickerPage.tsx';
import { RunTargetPickerSheet } from '../ui/RunTargetPickerPage.tsx';

const DAY_KEY: Record<'today' | 'tomorrow' | 'dayAfter', string> = {
  today: 'schedule.day.today',
  tomorrow: 'schedule.day.tomorrow',
  dayAfter: 'schedule.day.dayAfter',
};

export function NativeScheduleEditScreen({ scheduleId }: { scheduleId: string | null }) {
  const router = useRouter();
  const t = useT();
  const { mode } = useTheme();
  const { state, currentBot } = useSession();
  const allowed = canManageBot(currentBot);
  const { draft, patch, loading, saving, error, running, save } = useScheduleEditor(
    state.client,
    allowed ? (currentBot?.id ?? null) : null,
    scheduleId,
  );
  const [maxCallsText, setMaxCallsText] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const draftRef = useRef<ScheduleDraft>(draft);
  const maxCallsRef = useRef('');
  useEffect(() => {
    draftRef.current = draft;
    if (!loading) {
      const value = draft.maxCalls === null ? '' : String(draft.maxCalls);
      setMaxCallsText(value);
      maxCallsRef.current = value;
    }
  }, [draft, loading]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/?view=schedule');
  }, [router]);

  const nextPreview = useMemo(() => {
    const timezone = safeTimezone(currentBot?.timezone);
    const label = nextRunLabel(
      nextRunAt(draft.pattern, timezone, new Date()),
      new Date(),
      timezone,
    );
    if (label.kind === 'unknown') return t('schedule.next.unknown');
    const day = label.day === 'date' ? label.date : t(DAY_KEY[label.day]);
    return t('schedule.next.at', { day, time: label.time });
  }, [currentBot?.timezone, draft.pattern, t]);

  const handleSave = useCallback(async () => {
    const current = draftRef.current;
    setValidationError(null);
    if (current.name.trim() === '') return setValidationError(t('schedule.error.name'));
    if (current.description.trim() === '')
      return setValidationError(t('schedule.error.description'));
    if (current.command.trim() === '') return setValidationError(t('schedule.error.command'));
    const maxCalls = parseMaxCalls(maxCallsRef.current);
    if (!maxCalls.ok) return setValidationError(t('schedule.error.maxCalls'));
    const target = checkRunTarget(current.execution);
    if (!target.ok) return setValidationError(t(target.problemKey ?? 'schedule.error.runTarget'));
    const saved = await save({ maxCalls: maxCalls.value });
    if (saved !== null) leave();
  }, [leave, save, t]);

  const model = useMemo<NativeScheduleEditorViewModel>(() => {
    const line = timezoneLine(currentBot?.timezone);
    const runTargetValue =
      draft.execution.runTarget === 'existing_session'
        ? selectedSessionLabel(draft.execution.targetSessionId, state.sessions)
        : t('schedule.runTarget.newSession');
    let status: NativeScheduleEditorViewModel['status'] = loading ? 'loading' : 'ready';
    if (!allowed && currentBot !== null) status = 'permission';
    else if (error !== null) status = 'error';
    else if (saving) status = 'saving';
    return {
      status,
      title: t(scheduleId === null ? 'schedule.edit.new' : 'schedule.edit.existing'),
      loadingLabel: t('common.loading'),
      permissionTitle: t('schedule.permission.title'),
      permissionBody: t('schedule.permission.body'),
      errorTitle: t('schedule.save.failed'),
      errorBody: error === null ? '' : t(reasonKeyOf(error)),
      validationError,
      nameLabel: t('schedule.field.name'),
      descriptionLabel: t('schedule.field.description'),
      commandLabel: t('schedule.group.command'),
      commandPlaceholder: t('schedule.command.placeholder'),
      patternLabel: t('schedule.field.pattern'),
      enabledLabel: t('schedule.field.enabled'),
      maxCallsLabel: t('schedule.field.maxCalls'),
      maxCallsPlaceholder: t('schedule.maxCalls.unlimited'),
      frequencyLabel: t('schedule.group.frequency'),
      runTargetLabel: t('schedule.field.runTarget'),
      runTargetValue,
      executionFooter: t('schedule.execution.footer'),
      timezone: currentBot === null ? '' : t(line.key, line.values),
      nextPreview,
      saveLabel: t('schedule.save'),
      savingLabel: saving ? t('schedule.saving') : '',
      deleteLabel: scheduleId === null ? '' : t('schedule.delete.action'),
      deleteTitle: t('schedule.delete.title'),
      deleteBody: t('schedule.delete.body'),
      deleteRunningBody: running ? t('schedule.delete.running') : '',
      deleteConfirmLabel: t('schedule.delete.confirm'),
      cancelLabel: t('common.cancel'),
      name: draft.name,
      description: draft.description,
      command: draft.command,
      pattern: draft.pattern,
      enabled: draft.enabled,
      maxCalls: maxCallsText,
    };
  }, [
    allowed,
    currentBot,
    draft,
    error,
    loading,
    maxCallsText,
    nextPreview,
    running,
    saving,
    scheduleId,
    state.sessions,
    t,
    validationError,
  ]);

  return (
    <View style={{ flex: 1 }}>
      <NativeScheduleView
        style={{ flex: 1 }}
        mode={mode}
        editorModelJson={JSON.stringify(model)}
        onBack={leave}
        onFieldChange={(event) => {
          const field = event.nativeEvent.field;
          const value = event.nativeEvent.value ?? '';
          if (field === 'maxCalls') {
            maxCallsRef.current = value;
            setMaxCallsText(value);
          } else if (
            field === 'name' ||
            field === 'description' ||
            field === 'command' ||
            field === 'pattern'
          ) {
            patch({ [field]: value } as Partial<ScheduleDraft>);
          }
        }}
        onEnabledChange={(event) => patch({ enabled: event.nativeEvent.enabled === true })}
        onPatternPicker={() => {
          void (async () => {
            const outcome = await present(CronPickerSheet, { pattern: draftRef.current.pattern });
            if (outcome.status === 'completed') patch({ pattern: outcome.value.pattern });
          })();
        }}
        onRunTarget={() => {
          void (async () => {
            const outcome = await present(RunTargetPickerSheet, {
              runTarget: draftRef.current.execution.runTarget,
              targetSessionId: draftRef.current.execution.targetSessionId,
            });
            if (outcome.status === 'completed')
              patch({ execution: { ...draftRef.current.execution, ...outcome.value } });
          })();
        }}
        onSave={() => void handleSave()}
        onDelete={() => {
          if (state.client === null || currentBot === null || scheduleId === null) return;
          void state.client
            .deleteSchedule(currentBot.id, scheduleId)
            .then(leave)
            .catch((caught) => {
              setValidationError(caught instanceof Error ? caught.message : String(caught));
            });
        }}
      />
    </View>
  );
}
