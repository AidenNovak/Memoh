/**
 * 预览页路由：`/preview?path=/data/...`。
 *
 * 用 query 而不是路径段：文件路径里可以合法地包含 `/`（面包屑上每一级都要还原），
 * 用 `[...path]` 也能做，但那样 `/preview/a/b` 和 `/files/a/b` 在 URL 上长得一样，
 * 调试时看不出自己打开了哪一页。query 里放绝对路径，一眼能读。
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import React from 'react';

import { FilePreviewScreen } from '../screens/FilePreviewScreen.tsx';
import { normalizeWorkspacePath, workspaceBaseName } from '../features/files/paths.ts';
import { queryPathParam } from '../features/files/routes.ts';
import { useT } from '../lib/i18n/useT.ts';

export default function PreviewRoute() {
  const params = useLocalSearchParams<{ path?: string | string[] }>();
  const t = useT();

  const raw = queryPathParam(params.path);
  const normalized = normalizeWorkspacePath(raw);
  const title =
    normalized === null || normalized === '' ? t('files.title') : workspaceBaseName(normalized);

  return (
    <>
      {/* 文件名当标题：它是这一页唯一需要一直看得见的信息。
          返回键只画箭头，理由同 `files/[...path].tsx`：上一屏的名字在这里没有用，
          而 iOS 默认会把它印在箭头后面（`‹ (tabs)` 就是这么来的）。 */}
      <Stack.Screen
        options={{ headerShown: true, title, headerBackButtonDisplayMode: 'minimal' }}
      />
      <FilePreviewScreen path={raw} />
    </>
  );
}
