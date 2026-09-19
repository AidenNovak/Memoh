/**
 * 页面契约（`AGENTS.md` 里那条"复用 definePage / usePageRuntime / present"）。
 *
 * ## 它解决的三个问题
 *
 * 1. **瞬时流程不该各写各的 Modal。** 之前三个 sheet（审批、ask_user、会话信息）都是
 *    `Modal transparent + presentationStyle="overFullScreen"`：那是 Web 的居中弹窗思路，
 *    在 iOS 上既不是原生 sheet（没有 detent、没有抓手、没有侧滑关闭），也拿不到系统的
 *    滚动边缘与圆角。代价不只是观感——`docs/reviews` 里"审批在 pageSheet 下 detent 全失效"
 *    就是这种自绘控件的典型后果。
 * 2. **参数没有地方放。** 这类流程的参数（工具命令、问题与选项、要查的会话）不适合进 URL，
 *    见 `sessions.ts`；它们需要一个"进程内、有生命周期"的落点。
 * 3. **关闭路径太多。** 点按钮、点遮罩、侧滑、返回键、上层被卸载——每一条都必须让
 *    `await present(...)` 有结论（`completed` / `cancelled`），否则调用方永远等下去。
 *    契约把这件事交给路由层一次做对，而不是每个 sheet 自己记一遍。
 *
 * ## 谁负责什么
 *
 * | 层 | 职责 |
 * | --- | --- |
 * | `page.tsx`（这里） | 定义一个可出席的页面：id、标题、原生形态、参数解析、运行时 |
 * | `sessions.ts` | 出席会话的内存账本与一次性结算 |
 * | `index.ts` 的 `present()` | 注册会话 + 导航到 `presented/[presentationId]` |
 * | `PresentedPage.tsx` | 路由侧：查账本、套原生形态、任何关闭路径都结算 |
 *
 * ## 两种进入方式
 *
 * - **`present(page, params)`**：瞬时流程（由代码发起、等结果）。路由是
 *   `/presented/[presentationId]`，参数在内存里。
 * - **`page.Route`**：真路由（可以深链、交给系统返回）。参数从 URL 解析——这条路要求
 *   `parseRouteParams`，因为深链里没有内存账本可查。
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { createContext, useCallback, useContext, useMemo } from 'react';

/**
 * 页面能调的形态参数。
 *
 * ⚠️ **这里没有 `style`（formSheet / pageSheet / fullScreen）。** 形态是原生栈在 push
 * 那一刻从**宿主路由**读的（`src/app/_layout.tsx` 的 `presented/[presentationId]`），
 * 页面改不了它——给一个改不动的旋钮，比不给更坏：它会让下一个改的人以为写上就生效。
 * 真需要另一种形态（全屏模态、卡片推进）时，加一条宿主路由，而不是在这里加字段。
 */
export interface PagePresentationOptions {
  /** 能不能侧滑/下拉关闭。审批用 `false`——它必须被明确回答。 */
  dismissible: boolean;
  /** 只对 `formSheet` 有意义：允许停在哪些高度（0–1 的比例，或 `fitToContents`）。 */
  detents?: number[] | 'fitToContents';
  /** 只对 `formSheet` 有意义：顶部那条抓手。 */
  grabber?: boolean;
  /** 初始停在哪个 detent。 */
  initialDetent?: number | 'last';
  /** 原生导航栏。瞬时流程默认关掉——内容自带标题。 */
  headerShown: boolean;
  /** 原生导航栏标题；不给就用 `definePage` 的 `title`。 */
  headerTitle?: string;
}

export type PageFinish<TResult> = [TResult] extends [void]
  ? (result?: TResult) => void
  : (result: TResult) => void;

export interface PageRuntime<TParams = undefined, TResult = void> {
  /** 参数。瞬时流程来自内存账本，真路由来自 URL 解析。 */
  params: TParams;
  /** 完成（带结果）。调用方 `await present(...)` 拿到 `completed`。 */
  finish: PageFinish<TResult>;
  /** 取消。调用方拿到 `cancelled`。 */
  cancel: () => void;
  /** 这一屏是怎么进来的：决定调用方能不能指望拿到结果。 */
  source: 'presentation' | 'route';
}

export interface PageDefinitionBase {
  id: string;
  title: string;
  presentation: PagePresentationOptions;
  Component: React.ComponentType;
}

declare const pageTypes: unique symbol;

export interface PageDefinition<TParams = undefined, TResult = void> extends PageDefinitionBase {
  readonly [pageTypes]?: { params: TParams; result: TResult };
  /** 真路由用的组件：从 URL 解析参数，并提供同样的 runtime。 */
  Route: React.ComponentType;
}

const DEFAULT_PRESENTATION: PagePresentationOptions = {
  dismissible: true,
  detents: [0.5, 1],
  grabber: true,
  headerShown: false,
};

type RouteParams = Record<string, string | string[] | undefined>;

type DefinePageOptions<TParams> = {
  id: string;
  title: string;
  Component: React.ComponentType;
  presentation?: Partial<PagePresentationOptions>;
} & ([TParams] extends [undefined]
  ? { parseRouteParams?: (params: RouteParams) => TParams }
  : { parseRouteParams: (params: RouteParams) => TParams });

const PageRuntimeContext = createContext<PageRuntime<unknown, unknown> | null>(null);

export function definePage<TParams = undefined, TResult = void>(
  options: DefinePageOptions<TParams>,
): PageDefinition<TParams, TResult> {
  const presentation = { ...DEFAULT_PRESENTATION, ...options.presentation };
  const { Component, id, parseRouteParams, title } = options;

  function PageRoute() {
    const router = useRouter();
    const routeParams = useLocalSearchParams();
    const params = useMemo(
      () => (parseRouteParams ? parseRouteParams(routeParams) : (undefined as TParams)),
      [routeParams],
    );
    // 真路由没有"结算"这回事——它就是一个普通页面，返回即离开；两者同一个动作。
    const leave = useCallback(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, [router]);
    const runtime = useMemo<PageRuntime<TParams, TResult>>(
      () => ({ params, finish: leave as PageFinish<TResult>, cancel: leave, source: 'route' }),
      [leave, params],
    );

    return (
      <PageRuntimeProvider value={runtime}>
        <Stack.Screen options={sheetOptionsFor(presentation)} />
        <Component />
      </PageRuntimeProvider>
    );
  }

  PageRoute.displayName = `${Component.displayName ?? Component.name ?? id}Route`;

  return { Component, id, presentation, Route: PageRoute, title };
}

/** 出席会话的 id 从 URL 来。数字、正整数；别的都算坏值。 */
export function parsePresentationId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 形态 → 原生 Stack 选项。
 *
 * ⚠️ **这里只能给挂载后仍然生效的东西**：detent、抓手、能不能侧滑、标题。
 * `presentation`（formSheet / pageSheet / fullScreen）是原生栈在 **push 那一刻**读的，
 * 在这里给太晚——实测踩过：以为开了 sheet，实际渲染成一张全屏卡片（内容画到状态栏底下、
 * 没有抓手、没有圆角边距）。那条声明在宿主路由上（`src/app/_layout.tsx` 的
 * `presented/[presentationId]`）。
 *
 * 所以本契约目前只承诺一种宿主形态：`formSheet`——审批与表单要的就是它。
 * 真需要全屏模态或卡片推进时，**加一条宿主路由**，而不是在这一层假装能改。
 *
 * `detents` / `grabber` / `initialDetent` 只在 formSheet 下有意义：pageSheet 是固定
 * 全高，给了也不生效——这正是"审批必须用 formSheet"的原因（内容高度不固定，要靠 detent 兜）。
 */
export function sheetOptionsFor(options: PagePresentationOptions) {
  return {
    headerShown: options.headerShown,
    title: options.headerTitle,
    gestureEnabled: options.dismissible,
    sheetGrabberVisible: options.grabber,
    sheetAllowedDetents: options.detents,
    sheetInitialDetentIndex: options.initialDetent,
  };
}

export function PageRuntimeProvider<TParams, TResult>({
  children,
  value,
}: {
  children: React.ReactNode;
  value: PageRuntime<TParams, TResult>;
}) {
  return (
    <PageRuntimeContext value={value as PageRuntime<unknown, unknown>}>
      {children}
    </PageRuntimeContext>
  );
}

/**
 * 取当前页面的运行时。
 *
 * 页面组件**只能在契约的宿主里用**（presented 路由或真路由），否则是接线错误。
 * 这里故意抛错而不是回落成默认值：宽松的默认值会让"忘了接线"表现成一个永远关不掉的
 * sheet，那种 bug 在真机上很难看出因果。
 */
export function usePageRuntime<TParams = undefined, TResult = void>(): PageRuntime<
  TParams,
  TResult
> {
  const runtime = useContext(PageRuntimeContext);
  if (runtime === null) {
    throw new Error('usePageRuntime 必须在 present() 打开的页面或 page.Route 里使用');
  }
  return runtime as PageRuntime<TParams, TResult>;
}
