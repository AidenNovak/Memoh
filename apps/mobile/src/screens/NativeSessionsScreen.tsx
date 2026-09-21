import { NativeSessionsView, type NativeSessionsViewModel } from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';

import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';
import { forkTarget, forkTitle } from '../features/session/actions.ts';
import { presentRenameSession } from '../features/session/renamePicker.ts';
import { useSessionActivity } from '../features/activity/useSessionActivity.ts';
import { canRetry, presentError, reasonKeyOf } from '../features/errors/present.ts';
import {
  hubBotRows,
  hubConnectionModel,
  hubTitleKey,
  hubViewOptions,
} from '../features/session/hubChrome.ts';
import { useConnectionState, useSession, type SessionSummary } from '../features/session/store.tsx';
import { sessionDisplayTitle } from '../features/session/displayTitle.ts';
import { sessionSourceLabel } from '../features/session/sourceLabel.ts';
import { sessionsFooter } from '../features/session/paging.ts';
import type { HubView } from '../features/bots/surfaces.ts';

export function NativeSessionsScreen({
  visibleView,
  hubViews,
  onViewChange,
}: {
  visibleView: HubView;
  hubViews: readonly HubView[];
  onViewChange: (view: HubView) => void;
}) {
  const t = useT();
  const router = useRouter();
  const { mode } = useTheme();
  const connection = useConnectionState();
  const {
    state,
    currentBot,
    realtimeEnabled,
    refreshBots,
    refreshSessions,
    loadMoreSessions,
    openSession,
    selectBot,
  } = useSession();
  const { pending, active } = useSessionActivity(state.client, state.bots);
  const [pendingJump, setPendingJump] = useState<string | null>(null);

  const onOpen = useCallback(
    (sessionId: string, botId?: string) => {
      if (botId !== undefined && botId !== state.currentBotId) {
        setPendingJump(sessionId);
        selectBot(botId);
        return;
      }
      openSession(sessionId);
      router.push(`/chat/${sessionId}`);
    },
    [openSession, router, selectBot, state.currentBotId],
  );

  useEffect(() => {
    if (pendingJump === null) return;
    const stillThere = state.sessions.some((session) => session.id === pendingJump);
    if (!stillThere && state.sessionsLoading) return;
    const target = pendingJump;
    setPendingJump(null);
    onOpen(target);
  }, [onOpen, pendingJump, state.sessions, state.sessionsLoading]);

  const onRefresh = useCallback(() => {
    void (async () => {
      await refreshBots();
      await refreshSessions();
    })();
  }, [refreshBots, refreshSessions]);

  const onSelectBot = useCallback(
    (botId: string) => {
      if (botId === '__new__') {
        router.push('/bots/new');
        return;
      }
      if (botId !== state.currentBotId) selectBot(botId);
    },
    [router, selectBot, state.currentBotId],
  );

  const onSessionAction = useCallback(
    (sessionId: string, action: string) => {
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) return;
      if (action === 'rename') {
        void presentRenameSession({
          client: state.client,
          botId: state.currentBotId,
          sessionId: session.id,
          title: session.title,
          refreshSessions,
        });
        return;
      }
      if (action !== 'fork' || state.client === null || state.currentBotId === null) return;
      void (async () => {
        try {
          const page = await state.client?.listMessages(state.currentBotId ?? '', session.id, {
            limit: 50,
          });
          const turnId = forkTarget(page?.items ?? []);
          if (turnId === null) {
            Alert.alert(t('session.fork.title'), t('session.fork.noTurn'));
            return;
          }
          const forked = await state.client?.forkSession(state.currentBotId ?? '', session.id, {
            turn_id: turnId,
            title: forkTitle(session.title, t('session.fork.title')) ?? undefined,
          });
          await refreshSessions();
          if (typeof forked?.id === 'string' && forked.id !== '') onOpen(forked.id);
        } catch (caught) {
          Alert.alert(t('session.fork.failed'), t(reasonKeyOf(presentError(caught))));
        }
      })();
    },
    [onOpen, refreshSessions, state.client, state.currentBotId, state.sessions, t],
  );

  const viewModel = useMemo<NativeSessionsViewModel>(() => {
    const loadError = state.sessionsError ?? state.botsError;
    // 连接行、agent 行、视图选项三份数据与文件 / 定时两个原生屏**同一处组装**
    // （`features/session/hubChrome.ts`）：三个视图上这些位置必须是同一份数据。
    const connectionModel = hubConnectionModel(
      {
        connection,
        pendingSends: state.pendingSends,
        realtimeEnabled,
        currentBot,
      },
      t,
    );
    const footer = sessionsFooter({
      cursor: state.sessionsCursor,
      loading: state.sessionsMoreLoading,
      error: state.sessionsMoreError,
    });
    const botRows = hubBotRows(state.bots, state.currentBotId, t);
    const views = hubViewOptions(hubViews, visibleView, t);
    const activityRow = (entry: (typeof active)[number]) => ({
      id: entry.sessionId,
      botId: entry.botId,
      title: sessionDisplayTitle({ title: entry.sessionTitle }, t),
      detail: entry.botName,
    });
    return {
      // 大标题就是当前视图名（这一屏只挂载 sessions，键与文件 / 定时同源）。
      title: t(hubTitleKey(visibleView)),
      newSessionLabel: t('home.newSession'),
      newBotLabel: t('bots.create'),
      botMenuLabel: t('home.bot.switch'),
      viewMenuLabel: t('home.title'),
      searchPlaceholder: t('common.search'),
      emptyTitle: t('home.empty.title'),
      emptyBody: t('home.empty.body'),
      errorTitle: t('home.error.title'),
      retryLabel: t('common.retry'),
      loadingLabel: t('common.loading'),
      moreLabel: t('home.sessions.more'),
      moreLoadingLabel: t('home.sessions.more.loading'),
      moreFailedLabel: t('home.sessions.more.failed'),
      windowLabel: t('home.sessions.window', { count: state.sessions.length }),
      pendingTitle: t('home.approvals.title'),
      activeTitle: '',
      renameLabel: t('session.action.rename'),
      forkLabel: t('session.action.fork'),
      actionsHint: t('session.action.hint'),
      loading: state.sessionsLoading,
      errorMessage: loadError === null ? null : t(reasonKeyOf(loadError)),
      retryEnabled: loadError === null ? false : canRetry(loadError),
      moreState: footer,
      connection: connectionModel,
      bots: botRows,
      views,
      pendingApprovals: pending.map(activityRow),
      activeRuns: active.filter((entry) => entry.status !== 'waiting_decision').map(activityRow),
      sessions: state.sessions.map((session: SessionSummary) => ({
        id: session.id,
        title: sessionDisplayTitle(session, t),
        subtitle: sessionSourceLabel(session),
        updatedLabel: formatRelative(session.updatedAt),
        canFork: session.type?.trim().toLowerCase() === 'chat',
      })),
    };
  }, [active, connection, currentBot, hubViews, pending, realtimeEnabled, state, t, visibleView]);

  return (
    <View style={{ flex: 1 }}>
      <NativeSessionsView
        style={{ flex: 1 }}
        mode={mode}
        viewModelJson={JSON.stringify(viewModel)}
        onOpenSession={(event) => {
          const { sessionId, botId } = event.nativeEvent;
          if (sessionId !== undefined && sessionId !== '') onOpen(sessionId, botId);
        }}
        onNewSession={() => router.push('/chat/new')}
        onRefresh={onRefresh}
        onLoadMore={() => void loadMoreSessions()}
        onSelectBot={(event) => {
          const botId = event.nativeEvent.botId;
          if (botId !== undefined) onSelectBot(botId);
        }}
        onSelectView={(event) => {
          const next = event.nativeEvent.view;
          if (next === 'sessions' || next === 'files' || next === 'schedule') onViewChange(next);
        }}
        onSessionAction={(event) => {
          const { sessionId, action } = event.nativeEvent;
          if (sessionId !== undefined && action !== undefined) onSessionAction(sessionId, action);
        }}
      />
    </View>
  );
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
