import { NativeFilesView, type NativeFilesViewModel } from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Alert, View } from 'react-native';

import { useSession } from '../features/session/store.tsx';
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

export function NativeFilesScreen({ path }: { path: string }) {
  const normalized = useMemo(() => normalizeWorkspacePath(path), [path]);
  const router = useRouter();
  const t = useT();
  const { mode } = useTheme();
  const { currentBot, state } = useSession();
  const allowed = canReadWorkspace(currentBot);
  const directory = useDirectory(normalized, allowed);

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
    };
  }, [allowed, directory, normalized, t]);

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
      />
    </View>
  );
}
