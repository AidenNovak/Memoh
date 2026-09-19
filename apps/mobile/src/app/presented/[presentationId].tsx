/**
 * 出席会话的路由宿主。
 *
 * 全应用只有这一条 presented 路由：谁在台上由 URL 里的 `presentationId` 决定，参数与
 * 形态在内存账本里（见 `src/lib/presentation/sessions.ts`）。所以**不要**再为每个 sheet
 * 加路由——加一个 `definePage` 就够了。
 *
 * 约定（`AGENTS.md`）：路由文件导出 `page.Route`；瞬时流程走 `present()`。
 */
export { PresentedPageRoute as default } from '../../lib/presentation/index.ts';
