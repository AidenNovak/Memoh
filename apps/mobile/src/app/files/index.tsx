/**
 * 根目录页路由：`/files`（就是工作区根 `/data`）。
 *
 * ## 为什么单独一页（而不是让 `[...path].tsx` 顺带接住）
 *
 * `filesRoute('/data')` 返回 `/files`（`features/files/routes.ts` 的契约写着这条），
 * 而必需型 catch-all（`[...path]`）**不匹配没有段数的父路径**——它只匹配 `/files/...`。
 * 于是在 `/files/docs` 上点"回到上一层"会落到 expo-router 的 `Unmatched Route`
 * （2026-09-16 实测）。可选 catch-all 能同时接住两者，但会让类型生成器把
 * `` `/files/[[...path]]` `` 当字面量塞进 `Href`，把既有的 `router.push('/files/…')`
 * 调用变成类型错误（详见 `[...path].tsx` 的注释）。所以这里只补一页。
 *
 * 标题与返回同样交给**原生 header**：与子目录页保持一致（系统返回、右滑、标题折叠都白拿）。
 */
import { Stack } from 'expo-router';
import React from 'react';

import { FilesScreen } from '../../screens/FilesScreen.tsx';
import { WORKSPACE_ROOT } from '../../features/files/paths.ts';
import { useT } from '../../lib/i18n/useT.ts';

export default function FilesRootRoute() {
  const t = useT();

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('files.title'),
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      <FilesScreen path={WORKSPACE_ROOT} />
    </>
  );
}
