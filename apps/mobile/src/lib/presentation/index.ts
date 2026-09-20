/**
 * 页面契约的入口。
 *
 * 用法（两行足够）：
 *
 * ```ts
 * // 1. 定义（页面自己）
 * export const ApprovalPage = definePage<{ sessionId: string }>({
 *   id: 'approval',
 *   title: t('approval.title'),
 *   Component: ApprovalView,
 *   presentation: { dismissible: false, detents: [0.5, 1] },   // 形态由宿主路由给
 * });
 *
 * // 2. 打开（调用方）
 * const result = await present(ApprovalPage, { sessionId });
 * ```
 */
export {
  definePage,
  parsePresentationId,
  sheetOptionsFor,
  usePageRuntime,
  type PageDefinition,
  type PageFinish,
  type PagePresentationOptions,
  type PageRuntime,
} from './page.tsx';
export { present } from './present.ts';
export {
  cancelPresentationSession,
  completePresentationSession,
  getPresentationSession,
  type PresentationResult,
  type PresentationSession,
} from './sessions.ts';
export { PresentedPageRoute } from './PresentedPage.tsx';
