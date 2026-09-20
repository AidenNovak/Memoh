/**
 * `present()` —— 打开一个瞬时流程，等它的结论。
 *
 * ## 契约
 *
 * ```ts
 * const decision = await present(ApprovalPage, { sessionId });
 * if (decision.status === 'completed') { ... }   // 用户做了决定
 * // status === 'cancelled'                      // 侧滑/返回/上层被卸载
 * ```
 *
 * 调用方**必须**区分这两支：`present()` 永远不会 reject 成"没结论"，它总有一个结论。
 *
 * ## 为什么不要 `visible` 这类 prop
 *
 * `present(page, params)` 由代码发起、等结果，页面自己不需要"我该不该显示"这个状态——
 * 在台上就是显示，离开就是结束。状态驱动的 UI（比如"服务端说这个会话在等审批"）用
 * 一个 effect 把它翻译成一次 `present()`，而不是把 `visible` 往下传三层。
 */
import { router, type Href } from 'expo-router';

import type { PageDefinition, PagePresentationOptions } from './page.ts';
import {
  cancelPresentationSession,
  openPresentationSession,
  type PresentationResult,
} from './sessions.ts';

type PresentOptions = Partial<PagePresentationOptions>;

type PresentArgs<TParams> = [TParams] extends [undefined]
  ? [params?: TParams, options?: PresentOptions]
  : [params: TParams, options?: PresentOptions];

export function present<TParams, TResult>(
  page: PageDefinition<TParams, TResult>,
  ...args: PresentArgs<TParams>
): Promise<PresentationResult<TResult>> {
  const [params, options] = args;

  return new Promise<PresentationResult<TResult>>((resolve) => {
    const id = openPresentationSession({
      page,
      params,
      presentation: { ...page.presentation, ...options },
      resolve: (result) => resolve(result as PresentationResult<TResult>),
    });

    try {
      router.push({
        pathname: '/presented/[presentationId]',
        params: { presentationId: String(id) },
      } as Href);
    } catch (error) {
      // 导航都发不出去就别把会话留在账本里：留着它，调用方的 await 永远不返回。
      cancelPresentationSession(id);
      throw error;
    }
  });
}
