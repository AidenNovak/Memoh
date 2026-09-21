import {
  NativeFilesView,
  type NativeFilesViewModel,
  type NativeHubChromeModel,
} from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { Alert, View } from 'react-native';

import type { HubView } from '../features/bots/surfaces.ts';
import { hubChromeModel } from '../features/session/hubChrome.ts';
import { useConnectionState, useSession } from '../features/session/store.tsx';
import { canRetry, reasonKeyOf } from '../features/errors/present.ts';
import { copyText } from '../features/files/clipboard.ts';
import { directoryCount } from '../features/files/counts.ts';
import { attemptDownload, DOWNLOAD_CAPABILITY } from '../features/files/download.ts';
import type { WorkspaceEntry } from '../features/files/entries.ts';
import { directorySubtitle, fileSubtitle } from '../features/files/format.ts';
import { fileKind, fileSymbol } from '../features/files/kind.ts';
import {
  joinWorkspacePath,
  normalizeWorkspacePath,
  workspaceCrumbs,
  workspaceParentPath,
} from '../features/files/paths.ts';
import { filesRoute, previewRoute } from '../features/files/routes.ts';
import { useDirectory } from '../features/files/useDirectory.ts';
import { canReadWorkspace } from '../features/files/permissions.ts';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

/**
 * 文件视图（原生）。
 *
 * `visibleView` / `hubViews` / `onViewChange` 是**可选**的 Hub 顶层件输入（模块 9）：
 * 三者给全时，这一屏顶部会多出大标题、视图切换器、agent 菜单、连接行与新建会话入口
 * （数据由 `features/session/hubChrome.ts` 组装，画在原生侧）；只给一半时整块不画——
 * 宁可不画，也不画一个切不动的切换器。单独打开 `/files/...` 这条路由时（不在 Hub 里）
 * 一个都不传，形态与模块 8 完全一致。
 */
export function NativeFilesScreen({
  path,
  visibleView,
  hubViews,
  onViewChange,
}: {
  path: string;
  visibleView?: HubView;
  hubViews?: readonly HubView[];
  onViewChange?: (view: HubView) => void;
}) {
  const normalized = useMemo(() => normalizeWorkspacePath(path), [path]);
  const router = useRouter();
  const t = useT();
  const { mode } = useTheme();
  const connection = useConnectionState();
  const { currentBot, state, selectBot, retryConnection, realtimeEnabled } = useSession();
  const allowed = canReadWorkspace(currentBot);
  const directory = useDirectory(normalized, allowed);

  // Hub 顶层件与目录内容互不影响，各自一份记忆：翻目录不该重算顶层件（反之亦然）。
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
        // agent 菜单的头像计划要这一条（`connection` 是给连接行文案用的同一份状态）。
        connectionOpen: connection === 'open',
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

  const viewModel = useMemo<NativeFilesViewModel>(() => {
    let status: NativeFilesViewModel['status'] = 'ready';
    if (!allowed) status = 'permission';
    else if (normalized === null) status = 'invalid';
    else if (directory.status === 'idle' || directory.status === 'loading') status = 'loading';
    else if (directory.status === 'error') status = 'error';
    else if (directory.entries.length === 0) status = 'empty';

    const failure = directory.error;
    const parentPath = failure?.up === true ? workspaceParentPath(normalized ?? '') : null;
    const crumbs = normalized === null ? [] : workspaceCrumbs(normalized);
    const entries = directory.entries.flatMap((entry: WorkspaceEntry) => {
      const entryPath =
        entry.path === '' ? joinWorkspacePath(normalized ?? '', entry.name) : entry.path;
      if (entryPath === null) return [];
      const kind = fileKind(entry.name, entry.isDir);
      const subtitle = entry.isDir
        ? directorySubtitle(directoryCount(entryPath), t)
        : fileSubtitle(entry, t, directory.loadedAt);
      return [
        {
          name: entry.name,
          path: entryPath,
          subtitle,
          symbol: String(fileSymbol(kind)),
          accessibilityLabel: `${entry.name}, ${subtitle}`,
          isDir: entry.isDir,
        },
      ];
    });

    return {
      status,
      title: t('files.title'),
      loadingLabel: t('files.loading'),
      emptyLabel: t('files.empty'),
      permissionTitle: t('files.permission.title'),
      permissionBody: t('files.permission.body'),
      invalidTitle: t('files.error.invalidPath'),
      invalidBody: t('files.error.invalidPath.body'),
      errorTitle: failure === null ? t('files.error.list') : t(failure.titleKey),
      errorBody: failure === null ? '' : t(reasonKeyOf(failure)),
      retryLabel: t('common.retry'),
      upLabel: t('files.error.action.up'),
      moreLabel: t('files.more', { count: directory.hidden }),
      footer: t('files.footer'),
      openLabel: t('files.action.open'),
      copyPathLabel: t('files.action.copyPath'),
      downloadLabel: t('files.action.download'),
      breadcrumbs: crumbs,
      entries,
      hiddenCount: directory.hidden,
      retryEnabled: failure === null ? false : canRetry(failure),
      parentPath,
      hub,
    };
  }, [allowed, directory, hub, normalized, t]);

  function openPath(entryPath: string, isDir: boolean) {
    router.push((isDir ? filesRoute(entryPath) : previewRoute(entryPath)) as never);
  }

  function action(entryPath: string, actionId: string) {
    if (actionId === 'open') {
      const entry = directory.entries.find(
        (candidate) =>
          (candidate.path || joinWorkspacePath(normalized ?? '', candidate.name)) === entryPath,
      );
      openPath(entryPath, entry?.isDir === true);
      return;
    }
    if (actionId === 'copyPath') {
      copyText(entryPath);
      return;
    }
    if (actionId === 'download') {
      const attempt = attemptDownload({
        capability: DOWNLOAD_CAPABILITY,
        resolveTarget: () =>
          state.client === null
            ? { url: '', headers: {} }
            : state.client.downloadTarget(currentBot?.id ?? '', entryPath),
      });
      if (!attempt.ok) Alert.alert(t('files.action.download'), t(attempt.reasonKey));
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <NativeFilesView
        style={{ flex: 1 }}
        mode={mode}
        viewModelJson={JSON.stringify(viewModel)}
        onOpen={(event) => {
          const { path: nextPath, isDir } = event.nativeEvent;
          if (nextPath !== undefined && isDir !== undefined) openPath(nextPath, isDir);
        }}
        onNavigate={(event) => {
          const nextPath = event.nativeEvent.path;
          if (nextPath !== undefined) router.push(filesRoute(nextPath) as never);
        }}
        onRefresh={() => directory.reload()}
        onLoadMore={() => directory.loadMore()}
        onAction={(event) => {
          const { path: entryPath, action: actionId } = event.nativeEvent;
          if (entryPath !== undefined && actionId !== undefined) action(entryPath, actionId);
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
