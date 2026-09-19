/**
 * presented 路由：出席会话在原生的那一半。
 *
 * ## 这一屏的三件事
 *
 * 1. **查账本。** URL 里只有 `presentationId`；参数在内存账本里（`sessions.ts`）。
 *    查不到（进程被杀后深链进来、或者 id 是坏的）就立刻 dismiss——**不渲染空壳**：
 *    一个"什么都没有但关不掉"的 sheet 比不显示更糟。
 * 2. **套原生形态。** 形态来自页面定义（`present()` 时还能覆盖），在这里变成真实的
 *    Stack 选项：formSheet 的 detent、抓手、能不能侧滑。
 * 3. **任何关闭路径都结算。** 点按钮（`finish`）、侧滑、返回键、被上层卸载——全部
 *    落到 `settlePresentationSession`。**结算是一次性的**：同一次出席第二次结算返回
 *    false，所以"点按钮之后紧接着又被卸载"不会去 dismiss 两次（那会把下面那一屏也关掉）。
 */
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Text } from 'react-native';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';

import {
  type PageFinish,
  PageRuntimeProvider,
  type PageRuntime,
  parsePresentationId,
  sheetOptionsFor,
} from './page.tsx';
import {
  cancelPresentationSession,
  completePresentationSession,
  getPresentationSession,
  type PresentationSession,
} from './sessions.ts';

/**
 * presentationId → 有几个实例挂着。
 *
 * 开发构建里会"卸载再挂载"，用计数区分"真的走了"与"又挂回来了"。
 */
const mountCount = new Map<number, number>();

function dismissPresentedPage(
  router: ReturnType<typeof useRouter>,
  report: (note: string) => void,
): void {
  /**
   * 先 `back()`，再 `dismiss()`，最后 `replace('/')` 兜底。
   *
   * 这一屏是 `router.push` 推进来的（形态由宿主路由声明成 formSheet），所以**关它的
   * 逆操作是 `back()`**；`dismiss()` 的语义是"关掉一个模态"，这里当第二选择。
   * 最后那条 `replace('/')` 是保底：**这一屏无论如何都得关得掉**——一个关不掉的 sheet
   * 会把整个 App 卡在那（用户只能杀进程）。
   *
   * 调试这条路径时别只看断言：`report()` 会把"走了哪一支、canGoBack/canDismiss 各是什么"
   * 打到 Metro 日志（`[settle] ...`）。另见 `verification/presentation/README.md` 里
   * "断言会骗人"那一条。
   */
  const canGoBack = router.canGoBack();
  const canDismiss = router.canDismiss();
  if (canGoBack) {
    report(`back()  canGoBack=${canGoBack} canDismiss=${canDismiss}`);
    router.back();
    return;
  }
  if (canDismiss) {
    report(`dismiss()  canGoBack=${canGoBack} canDismiss=${canDismiss}`);
    router.dismiss();
    return;
  }
  report(`replace('/')  canGoBack=${canGoBack} canDismiss=${canDismiss}`);
  router.replace('/');
}

/**
 * 把页面自己声明的形态套到原生栈上。
 *
 * 用 `setOptions`（而不是渲染 `<Stack.Screen>`）：这一屏已经在台上了，要改的是**当前**
 * 这一屏的选项。`useLayoutEffect` 保证在首帧画出来之前设置，避免"先闪一下默认形态再变"。
 */
function SheetOptions({ options }: { options: PresentationSession['presentation'] }) {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions(sheetOptionsFor(options));
  }, [navigation, options]);
  return null;
}

export function PresentedPageRoute() {
  const router = useRouter();
  const navigation = useNavigation();
  const routeParams = useLocalSearchParams<{ presentationId?: string | string[] }>();
  const presentationId = parsePresentationId(routeParams.presentationId);

  /**
   * 只在挂载时查一次账本。
   *
   * 不订阅账本变化是有意的：这一屏的参数与形态在整个生命周期里是恒定的，重渲染只会
   * 让 sheet 闪一下。账本里没有它 = 该走了。
   */
  /**
   * 结算失败了要看得出原因。
   *
   * 关不掉的 sheet 是最难查的一类问题（"我点了，它没反应"），所以这里让**关的那条路
   * 带一句说明**：哪一支结算、拿到什么结论、走 dismiss 还是 back。开发构建里它就挂在
   * 屏幕底部，截图即证据——比翻 Metro 输出可靠（那段日志是块缓冲的，进程被杀才会落盘）。
   */
  const [settleNote] = useState('');
  const report = useCallback((note: string) => {
    if (__DEV__) console.warn(`[settle] ${note}`);
  }, []);
  const [session] = useState<PresentationSession | null>(() =>
    presentationId === null ? null : (getPresentationSession(presentationId) ?? null),
  );

  /**
   * "真的离开了"才算取消。
   *
   * ⚠️ 这里不能只看"某次 effect 的清理跑了"。开发构建里这一屏会被**卸载再挂载**
   * （`docs/research/verified-behaviour.md` 第 20 条记过同类现象），于是：
   *
   * - 旧实例的清理跑 → 如果那里直接结算，就把**已经重新挂上的那一屏**结算掉了；
   * - 而新实例挂载时会去账本里查会话——查不到（已被上面结算）→ 走 `session === null`
   *   那条路把自己关掉。表现就是"面板闪一下就没了"，比不弹更难查。
   *
   * 所以按 **id 记账**：谁挂上就 +1，谁卸下就 -1，只有"没有实例挂着"时才结算。
   */
  useEffect(() => {
    if (session === null) {
      dismissPresentedPage(router, report);
      return;
    }
    const id = session.id;
    mountCount.set(id, (mountCount.get(id) ?? 0) + 1);
    // 侧滑、返回键、程序化 dismiss：都走这条（离场前会触发一次）。
    const unsubscribe = navigation.addListener('beforeRemove', () => {
      cancelPresentationSession(id);
    });
    return () => {
      unsubscribe();
      const left = (mountCount.get(id) ?? 1) - 1;
      if (left <= 0) mountCount.delete(id);
      else mountCount.set(id, left);
      // 延后一拍再决定：重新挂载的话，计数已经被新实例加回去了。
      setTimeout(() => {
        if (mountCount.has(id)) return;
        cancelPresentationSession(id);
      }, 0);
    };
  }, [navigation, report, router, session]);

  const cancel = useCallback(() => {
    if (session === null) return;
    const settled = cancelPresentationSession(session.id);
    report(`cancel 结算=${settled} id=${session.id}`);
    if (settled) dismissPresentedPage(router, report);
  }, [router, report, session]);

  const finish = useCallback(
    (value?: unknown) => {
      if (session === null) return;
      const settled = completePresentationSession(session.id, value);
      report(`finish 结算=${settled} id=${session.id}`);
      if (settled) dismissPresentedPage(router, report);
    },
    [report, router, session],
  );

  const runtime = useMemo<PageRuntime<unknown, unknown> | null>(
    () =>
      session === null
        ? null
        : {
            params: session.params,
            finish: finish as PageFinish<unknown>,
            cancel,
            source: 'presentation',
          },
    [cancel, finish, session],
  );

  if (session === null || runtime === null) return null;

  return (
    <PageRuntimeProvider value={runtime}>
      {/* 形态分两半：`presentation` 由宿主路由声明（见 page.tsx 的说明），
          这里只设挂载后仍会生效的部分（detent / 抓手 / 侧滑开关 / 标题）。 */}
      <SheetOptions options={session.presentation} />
      <session.page.Component />
      {settleNote === '' ? null : (
        <Text
          testID="presentation-settle-note"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 6,
            fontSize: 11,
            color: '#B25E00',
          }}
        >
          {settleNote}
        </Text>
      )}
    </PageRuntimeProvider>
  );
}
