/**
 * 原生 sheet 的结论类型。
 *
 * ## 历史与现状
 *
 * 这里原来是一套"出席会话内存账本"（`present()` 入栈 + `PresentedPageRoute` 按 id 找页面），
 * 参数只存在内存里、URL 只带一个整数 id。模块 1–9A 把每个 sheet 都换成了原生呈现
 * （`ChatSheetPresenter`：审批 / ask_user / 选择器 / 会话信息 / 机器面板），RN 侧只剩
 * "发一条 JSON + 等一个结论"，于是那套账本连同 `page.tsx` / `present.ts` /
 * `PresentedPage.tsx` 与 `presented/[presentationId]` 路由一起删掉了（2026-09-21）。
 *
 * **留下来的只有这个结论类型**：`lib/presentation/nativePicker.ts` 仍然按它回答调用方，
 * 于是所有调用点的判据（`outcome.status !== 'completed'`）一行都不用改。
 */

/** 一次原生 sheet 的返回值：调用方必须区分这两支。 */
export type PresentationResult<TResult> =
  { status: 'cancelled' } | { status: 'completed'; value: TResult };
