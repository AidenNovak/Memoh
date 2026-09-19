/**
 * 子目录页路由：`/files/a/b`。
 *
 * 「一页一目录的 push」的落点就在这里：进一个目录 = push 一页，由**原生 header** 给标题
 * （目录名）与返回，所以这一层只做两件事——把 URL 段还原成路径、把标题交给栈。
 *
 * 根固定 `/data`：URL 里不带根信息（`/files/apps` 就是 `/data/apps`），任何 `/data`
 * 之外的路径在 `normalizeWorkspacePath` 那一步被拒（服务端不校验前缀，这是我们自己的边界）。
 * 根那一页（`/files`）在同目录的 `index.tsx` 里接。
 *
 * ## ⚠️ 这里**不能**改成可选 catch-all（`[[...path]]`）来顺带接住根
 *
 * 必需型 catch-all 只匹配 `/files/...`，不匹配 `/files` 本身；而 `filesRoute('/data')`
 * 返回的正是 `/files`（那个函数的文档与单测都这么写——根就是 `/data`）。2026-09-16 实测
 * 踩到：`/files/docs` 上给"回到上一层"，点下去整屏变成 expo-router 的
 * "Unmatched Route / Page could not be found"。
 *
 * 但修法不是改名：Expo Router 的类型生成器会把可选 catch-all 原样写成一个字符串字面量
 * （`` `/files/[[...path]]` ``）进 `Href` 联合类型，于是 `router.push('/files/…')` 这类既有
 * 调用（`ui/MachinePanelPage.tsx`、`features/notifications/NotificationOpenHandler.tsx`）
 * 会立刻变成类型错误。加一个 `index.tsx` 只多一页，且不动任何既有类型。
 *
 * 不进 `(tabs)`：它是会话视图里点出来的下一层，属于根栈；放进 tab 会让返回与标签栏打架。
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import React from 'react';

import { FilesScreen } from '../../screens/FilesScreen.tsx';
import {
  WORKSPACE_ROOT,
  normalizeWorkspacePath,
  workspaceBaseName,
} from '../../features/files/paths.ts';
import { pathFromSegments } from '../../features/files/routes.ts';
import { useT } from '../../lib/i18n/useT.ts';

export default function FilesRoute() {
  const params = useLocalSearchParams<{ path?: string | string[] }>();
  const t = useT();

  const segments = pathFromSegments(params.path);
  const raw = segments === '' ? WORKSPACE_ROOT : segments;
  const normalized = normalizeWorkspacePath(raw);
  const title =
    normalized === null || normalized === WORKSPACE_ROOT
      ? t('files.title')
      : workspaceBaseName(normalized);

  return (
    <>
      {/* 标题与返回由原生 header 给：系统返回、右滑、标题的折叠行为都白拿。
          返回键**只画箭头**：上一屏是会话视图（tab 里的"会话"），把它的名字印在箭头后面
          既不必要，也正是 2026-09-17 那次 `‹ (tabs)`（路由内部名漏到用户眼前）的来源。
          本 App 其它 push 页画的都是光秃秃一个 `‹`，这里跟着统一。 */}
      <Stack.Screen
        options={{ headerShown: true, title, headerBackButtonDisplayMode: 'minimal' }}
      />
      {/* 路径原样传下去：非法的路径要在页内显示"路径无效"，不能悄悄回退成根目录。 */}
      <FilesScreen path={raw} />
    </>
  );
}
