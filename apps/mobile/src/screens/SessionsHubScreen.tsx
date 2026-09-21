/**
 * 「会话」tab 的外壳：**纯分发器**（不画任何东西）。
 *
 * ## 为什么三个视图挤在同一个 tab 里
 *
 * 2026-09-15 的裁决（`docs/research/memoh-design-baseline.md` §7.1）：底部只要两个 tab。
 * 文件与定时不是"另外两个地方"，而是**同一个 agent 的另外两种看法**——桌面端也是
 * Chat / Files / Schedule 三视图互斥。所以三视图共用同一份顶层件（大标题、视图切换、
 * agent 行、连接状态、新建会话），切视图**不切 agent**；反过来切 agent 时三视图的数据
 * 整体跟着换（它们都属于这个 agent）。
 *
 * ## 分工（模块 9 起）
 *
 * 顶层件由**当前挂载的那个视图自己画**（三个视图都是原生的，共用
 * `features/session/hubChrome.ts` 组装的那份数据）。所以这一屏只剩两件事：
 *
 * 1. 把"用户想去哪个视图"（`?view=` 深链 + 切换器回调）收敛成一个**真正能挂载**的视图；
 * 2. 把"有哪些视图可选"与切换回调交给挂载的那个视图。
 *
 * 它没有 UI，也不持有任何文案：标题写在哪里由子页决定——写两遍必然有一天不一致
 * （标题写着"文件"而内容还是会话）。
 */
import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';

import { hubViewsFor, visibleHubView, type HubView } from '../features/bots/surfaces.ts';
import { useSession } from '../features/session/store.tsx';
import { NativeFilesScreen } from './NativeFilesScreen.tsx';
import { NativeScheduleScreen } from './NativeScheduleScreen.tsx';
import { NativeSessionsScreen } from './NativeSessionsScreen.tsx';

/** 文件视图的根。**客户端钉死**：服务端只做 `path.Clean` + 拒 `..`，不校验前缀。 */
export const FILES_ROOT = '/data';

function parseView(raw: string | undefined): HubView {
  return raw === 'files' || raw === 'schedule' ? raw : 'sessions';
}

export function SessionsHubScreen() {
  // `?view=files` 这样进来能直达某个视图（设计稿的 `#files` / `#schedule` 等价物）。
  // 也让自动化验收能一条命令点到某一屏，不用先点两下图标。
  const params = useLocalSearchParams<{ view?: string }>();
  const [view, setView] = useState<HubView>(parseView(params.view));
  const { currentBot } = useSession();
  const hubViews = useMemo(() => hubViewsFor(currentBot), [currentBot]);
  // `view` 保留深链意图；`visibleView` 才能挂载子页。权限未知或不允许时绝不先画受限页。
  const visibleView = visibleHubView(currentBot, view);

  useEffect(() => {
    const next = parseView(params.view);
    if (params.view !== undefined) setView(next);
  }, [params.view]);

  useEffect(() => {
    // bot 未回来前还不知道权限，不提前吃掉 `?view=schedule` 这类深链意图；权限一旦可知，
    // 不可用的目标立即收敛到 sessions。之后刷新同一个 bot 也不会把用户当前选择重置。
    if (currentBot !== null && !hubViews.includes(view)) setView('sessions');
  }, [currentBot, hubViews, view]);

  // 三个视图各自是完整的一屏，顶层件由它们自己交给原生画（见文件头"分工"）。
  switch (visibleView) {
    case 'files':
      return (
        <NativeFilesScreen
          path={FILES_ROOT}
          visibleView={visibleView}
          hubViews={hubViews}
          onViewChange={setView}
        />
      );
    case 'schedule':
      return (
        <NativeScheduleScreen
          visibleView={visibleView}
          hubViews={hubViews}
          onViewChange={setView}
        />
      );
    default:
      return (
        <NativeSessionsScreen
          visibleView={visibleView}
          hubViews={hubViews}
          onViewChange={setView}
        />
      );
  }
}
