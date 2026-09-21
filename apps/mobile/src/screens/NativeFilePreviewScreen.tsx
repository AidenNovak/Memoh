import { NativeFilePreviewView, type NativeFilePreviewViewModel } from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Alert, View } from 'react-native';

import { canRetry, reasonKeyOf } from '../features/errors/present.ts';
import { attemptDownload, DOWNLOAD_CAPABILITY } from '../features/files/download.ts';
import { formatBytes } from '../features/files/format.ts';
import type { FileKind } from '../features/files/kind.ts';
import { normalizeWorkspacePath, workspaceCrumbs } from '../features/files/paths.ts';
import { canReadWorkspace } from '../features/files/permissions.ts';
import { useFilePreview } from '../features/files/useFilePreview.ts';
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';
import { filesRoute } from '../features/files/routes.ts';

const KIND_TITLE_KEY: Partial<Record<FileKind, string>> = {
  image: 'files.preview.kind.image',
  pdf: 'files.preview.kind.pdf',
  video: 'files.preview.kind.video',
  audio: 'files.preview.kind.audio',
  archive: 'files.preview.kind.archive',
  sheet: 'files.preview.kind.sheet',
};

const REASON_KEY: Partial<Record<FileKind, string>> = {
  pdf: 'files.preview.reason.pdf',
  video: 'files.preview.reason.video',
  audio: 'files.preview.reason.audio',
  archive: 'files.preview.reason.archive',
  sheet: 'files.preview.reason.sheet',
};

export function NativeFilePreviewScreen({ path }: { path: string }) {
  const normalized = useMemo(() => normalizeWorkspacePath(path), [path]);
  const router = useRouter();
  const t = useT();
  const { mode } = useTheme();
  const { currentBot, state } = useSession();
  const allowed = canReadWorkspace(currentBot);
  const preview = useFilePreview(normalized, allowed);

  const viewModel = useMemo<NativeFilePreviewViewModel>(() => {
    const crumbs = normalized === null ? [] : workspaceCrumbs(normalized);
    if (!allowed) {
      return baseModel(crumbs, 'error', t('files.permission.title'), t('files.permission.body'));
    }
    if (normalized === null) {
      return baseModel(
        crumbs,
        'error',
        t('files.error.invalidPath'),
        t('files.error.invalidPath.body'),
      );
    }
    const current = preview.state;
    if (current.status === 'idle' || current.status === 'loading') {
      return baseModel(crumbs, current.status, '', '', false);
    }
    if (current.status === 'notFound') {
      return baseModel(
        crumbs,
        'notFound',
        t('files.error.notFound'),
        t('files.error.notFound.body'),
      );
    }
    if (current.status === 'error') {
      return baseModel(
        crumbs,
        'error',
        t(current.titleKey),
        t(reasonKeyOf(current)),
        canRetry(current),
      );
    }
    if (current.status === 'folder') {
      return baseModel(crumbs, 'folder', t('files.preview.folder'), t('files.preview.folder.body'));
    }
    if (current.status === 'text') {
      return baseModel(
        crumbs,
        'text',
        '',
        '',
        false,
        current.lines,
        current.truncated > 0 ? t('files.preview.truncated', { count: current.truncated }) : '',
      );
    }
    if (current.status === 'image') {
      return baseModel(
        crumbs,
        'image',
        t('files.preview.kind.image'),
        '',
        false,
        [],
        '',
        current.uri,
        current.headers,
        t('files.preview.image.meta', { size: formatBytes(current.size) }),
      );
    }
    if (current.status === 'binary') {
      const title = t(KIND_TITLE_KEY[current.kind] ?? 'files.preview.kind.binary');
      const reason = t(REASON_KEY[current.kind] ?? 'files.preview.reason.binary', {
        size: formatBytes(current.size),
      });
      return baseModel(crumbs, 'binary', title, reason);
    }
    return baseModel(
      crumbs,
      'tooLarge',
      t('files.preview.tooLarge.title'),
      t('files.preview.tooLarge.body', {
        size: formatBytes(current.size),
        limit: formatBytes(current.limit),
      }),
    );
  }, [allowed, normalized, preview.state, t]);

  const localizedViewModel = useMemo(
    () => ({
      ...viewModel,
      loadingLabel: t('files.loading'),
      retryLabel: t('common.retry'),
      downloadLabel: t('files.action.download'),
    }),
    [t, viewModel],
  );

  const onDownload = () => {
    const attempt = attemptDownload({
      capability: DOWNLOAD_CAPABILITY,
      resolveTarget: () =>
        state.client === null
          ? { url: '', headers: {} }
          : state.client.downloadTarget(currentBot?.id ?? '', normalized ?? ''),
    });
    if (!attempt.ok) Alert.alert(t('files.action.download'), t(attempt.reasonKey));
  };

  return (
    <View style={{ flex: 1 }}>
      <NativeFilePreviewView
        style={{ flex: 1 }}
        mode={mode}
        viewModelJson={JSON.stringify(localizedViewModel)}
        onRetry={() => preview.reload()}
        onDownload={onDownload}
        onNavigate={(event) => {
          const nextPath = event.nativeEvent.path;
          if (nextPath !== undefined) router.push(filesRoute(nextPath) as never);
        }}
      />
    </View>
  );
}

function baseModel(
  breadcrumbs: { label: string; path: string; current: boolean }[],
  status: NativeFilePreviewViewModel['status'],
  title: string,
  body: string,
  retryEnabled = false,
  lines: string[] = [],
  truncatedLabel = '',
  imageURI: string | null = null,
  imageHeaders: Record<string, string> = {},
  imageMeta = '',
): NativeFilePreviewViewModel {
  return {
    status,
    loadingLabel: 'Loading…',
    title,
    body,
    retryLabel: 'Retry',
    downloadLabel: 'Download',
    truncatedLabel,
    imageURI,
    imageHeaders,
    imageMeta,
    lines,
    retryEnabled,
    breadcrumbs,
  };
}
