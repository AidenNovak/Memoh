/**
 * 「运行位置」选择器：新会话 / 复用某个已有会话。
 *
 * ## 这一项之前为什么只读
 *
 * 上一轮的结论写得很清楚：改成"复用同一个会话"**需要会话选择器**，没有它就会写出缺
 * `target_session_id` 的必然被拒请求。所以这一页的门槛不是"多一个开关"，而是"选得出会话"。
 * 现在补上了：先选位置，再（只在复用时）选会话，约束由 `features/schedule/runTarget.ts`
 * 的 `checkRunTarget` 统一把着，编辑页与这一页都读同一份判断。
 *
 * ## 为什么会话列表带"换一页看看"而不是分页器
 *
 * `GET /sessions` 默认一页 50 条。定时任务经常复用一个很久以前建的会话——它很可能不在第一页。
 * iOS 上一次性加载几百条会话是没必要的开销，所以这里给一句说明 + 一个"再拉 50 条"的动作：
 * 用户知道自己要找的东西更早，比给一个"加载更多"的按钮更清楚。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Session } from '../api/types.ts';
import { checkRunTarget, sessionLabel, type RunTarget } from '../features/schedule/runTarget.ts';
import { sessionSourceFromApi } from '../features/session/sourceLabel.ts';
import { useSession } from '../features/session/store.tsx';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';

export interface RunTargetPickerParams {
  runTarget: string;
  targetSessionId: string;
}

export interface RunTargetPickerResult {
  runTarget: RunTarget;
  targetSessionId: string;
}

const PAGE_SIZE = 50;

/**
 这一次响应里的"下一页游标"。

 `next_cursor` 是**空串**表示到底（`ListSessionsResponse` 的约定）。这里同时容忍"字段缺失"
 ——那说明对面版本旧/实现不全，把它当成到底比当成"还有"更安全（后者会让"再拉一批"永远挂着，
点下去拿到空页）。
 */
function nextCursorOf(page: { next_cursor?: string }): string | null {
  const cursor = page.next_cursor;
  if (typeof cursor !== 'string' || cursor === '') return null;
  return cursor;
}

function RunTargetPickerView() {
  const palette = usePalette();
  const t = useT();
  const { state, currentBot } = useSession();
  const runtime = usePageRuntime<RunTargetPickerParams, RunTargetPickerResult>();

  const [runTarget, setRunTarget] = useState<RunTarget>(
    runtime.params.runTarget === 'existing_session' ? 'existing_session' : 'new_session',
  );
  const [targetSessionId, setTargetSessionId] = useState(runtime.params.targetSessionId);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const botId = currentBot?.id ?? null;
  const client = state.client;

  useEffect(() => {
    if (client === null || botId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.listSessions(botId, { limit: PAGE_SIZE });
        if (cancelled) return;
        setSessions(page.items ?? []);
        setCursor(nextCursorOf(page));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId, client]);

  const loadMore = useCallback(() => {
    if (client === null || botId === null || cursor === null || loadingMore) return;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await client.listSessions(botId, { limit: PAGE_SIZE, cursor });
        setSessions((previous) => [...(previous ?? []), ...(page.items ?? [])]);
        setCursor(nextCursorOf(page));
      } catch {
        setFailed(true);
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [botId, client, cursor, loadingMore]);

  const check = checkRunTarget({ runTarget, targetSessionId });
  const list = sessions ?? [];

  const finish = () => {
    if (!check.ok) return;
    runtime.finish({
      runTarget,
      targetSessionId: runTarget === 'existing_session' ? targetSessionId : '',
    });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: GROUP_INSET,
          marginBottom: spacing.md,
        }}
      >
        <Text style={[typography.title2, { color: palette.label, flex: 1 }]}>
          {t('schedule.runTarget.title')}
        </Text>
        {/* 结论与出口都在顶部：不用滚到底才知道能不能完成（与 cron 选择器同一个形态）。 */}
        <Pressable
          testID="run-target-done"
          accessibilityRole="button"
          accessibilityState={{ disabled: !check.ok }}
          disabled={!check.ok}
          onPress={finish}
          hitSlop={12}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: 'flex-end',
            justifyContent: 'center',
            opacity: check.ok ? 1 : 0.5,
          }}
        >
          <Text style={[typography.body, { color: palette.accent }]}>{t('common.done')}</Text>
        </Pressable>
      </View>

      {check.ok ? null : (
        <Text
          testID="run-target-problem"
          style={[
            typography.footnote,
            {
              color: palette.destructive,
              paddingHorizontal: GROUP_INSET,
              marginBottom: spacing.md,
            },
          ]}
        >
          {t(check.problemKey ?? '')}
        </Text>
      )}

      <Section header={t('schedule.runTarget.group')}>
        <Choice
          testID="run-target-new"
          title={t('schedule.runTarget.newSession')}
          subtitle={t('schedule.runTarget.newSession.hint')}
          selected={runTarget === 'new_session'}
          onPress={() => setRunTarget('new_session')}
        />
        <Choice
          testID="run-target-existing"
          title={t('schedule.runTarget.existingSession')}
          subtitle={t('schedule.runTarget.existingSession.hint')}
          selected={runTarget === 'existing_session'}
          last
          onPress={() => setRunTarget('existing_session')}
        />
      </Section>

      {runTarget === 'existing_session' ? (
        <>
          <Section header={t('schedule.runTarget.sessions')}>
            {sessions === null ? (
              <View style={{ padding: spacing.lg, alignItems: 'center' }}>
                {failed ? (
                  <Text style={[typography.footnote, { color: palette.destructive }]}>
                    {t('schedule.runTarget.loadFailed')}
                  </Text>
                ) : (
                  <ActivityIndicator color={palette.secondaryLabel} />
                )}
              </View>
            ) : (
              list.map((session, index) => (
                <Choice
                  key={session.id}
                  testID={`run-target-session-${session.id}`}
                  title={sessionLabel(session)}
                  // 副标题走和其它会话行同一个纯函数：这台部署服务端**不返回**
                  // channel_type，直接传 undefined 会让 `subtitle === ''` 判不出来，
                  // 渲染一个空 Text 白占一行（`Choice` 里那一行的高度）。
                  subtitle={sessionSourceFromApi(session)}
                  selected={session.id === targetSessionId}
                  last={index === list.length - 1 && cursor === null}
                  onPress={() => setTargetSessionId(session.id)}
                />
              ))
            )}
            {cursor === null ? null : (
              <Pressable
                testID="run-target-more"
                accessibilityRole="button"
                onPress={loadMore}
                style={({ pressed }) => ({
                  minHeight: MIN_TOUCH_TARGET,
                  justifyContent: 'center',
                  paddingHorizontal: spacing.lg,
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: palette.separator,
                  backgroundColor: pressed ? palette.field : 'transparent',
                })}
              >
                {loadingMore ? (
                  <ActivityIndicator color={palette.secondaryLabel} />
                ) : (
                  <Text style={[typography.body, { color: palette.accent }]}>
                    {t('schedule.runTarget.more')}
                  </Text>
                )}
              </Pressable>
            )}
          </Section>
          <Text
            style={[
              typography.footnote,
              { color: palette.tertiaryLabel, paddingHorizontal: GROUP_INSET },
            ]}
          >
            {t('schedule.runTarget.sessions.footer')}
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}

function Section({ header, children }: { header: string; children: React.ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text
        style={[
          typography.footnote,
          {
            color: palette.secondaryLabel,
            paddingHorizontal: GROUP_INSET,
            marginBottom: spacing.xs,
          },
        ]}
      >
        {header}
      </Text>
      <View
        style={{
          backgroundColor: palette.card,
          marginHorizontal: GROUP_INSET,
          borderRadius: radius.md,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Choice({
  testID,
  title,
  subtitle,
  selected,
  last,
  onPress,
}: {
  testID: string;
  title: string;
  subtitle: string;
  selected: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: spacing.lg,
        paddingVertical: 10,
        gap: 1,
        backgroundColor: pressed ? palette.field : 'transparent',
        borderBottomWidth: last === true ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: palette.separator,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text style={[typography.body, { color: palette.label, flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
        {selected ? <Text style={[typography.body, { color: palette.accent }]}>✓</Text> : null}
      </View>
      {subtitle === '' ? null : (
        <Text style={[typography.footnote, { color: palette.tertiaryLabel }]} numberOfLines={2}>
          {subtitle}
        </Text>
      )}
    </Pressable>
  );
}

export const RunTargetPickerSheet = definePage<RunTargetPickerParams, RunTargetPickerResult>({
  id: 'runTargetPicker',
  title: 'Run target',
  Component: RunTargetPickerView,
  parseRouteParams: (params) => ({
    runTarget: String(params.runTarget ?? 'new_session'),
    targetSessionId: String(params.targetSessionId ?? ''),
  }),
  presentation: {
    dismissible: true,
    detents: [0.7, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});
