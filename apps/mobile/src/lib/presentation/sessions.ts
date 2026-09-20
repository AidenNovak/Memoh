/**
 * 出席会话（presentation session）的内存账本。
 *
 * ## 为什么是"内存账本"而不是"把参数塞进 URL"
 *
 * `AGENTS.md` 的契约原话：**present 的参数只存在内存里，只有 `presentationId` 进 URL。**
 *
 * 理由是这类流程的参数**不适合进 URL**：审批里有工具命令与参数、问表单里有问题与选项、
 * 会话信息里有服务端数据。放进 URL 意味着它们会被序列化进路由状态、出现在日志与深链里，
 * 而且每次重新渲染都要反序列化一遍。URL 只携带一个整数 id，参数留在这张表里。
 *
 * 代价说清楚：**进程被杀之后这些会话就没了**——那时深链打开的 `presented/7` 找不到账本，
 * 路由层要 dismiss 掉它（`PresentedPageRoute` 就是这么做的），而不是渲染一个空壳。
 *
 * 账本与导航分开：`present()` 负责入栈，这里只保证一次结算以及取消/完成的区分。
 */

import type { PageDefinitionBase, PagePresentationOptions } from './page.ts';

/** 一个还在台上的出席会话。 */
export interface PresentationSession {
  id: number;
  page: PageDefinitionBase;
  params: unknown;
  presentation: PagePresentationOptions;
}

/** `present()` 的返回值：调用方必须区分这两支。 */
export type PresentationResult<TResult> =
  { status: 'cancelled' } | { status: 'completed'; value: TResult };

interface StoredSession extends PresentationSession {
  resolve: (result: PresentationResult<unknown>) => void;
}

let nextId = 1;
let sessions: readonly StoredSession[] = [];

/** 注册一个出席会话，返回它的 id。id 从 1 开始，进程内唯一。 */
export function openPresentationSession(input: {
  page: PageDefinitionBase;
  params: unknown;
  presentation: PagePresentationOptions;
  resolve: (result: PresentationResult<unknown>) => void;
}): number {
  const id = nextId;
  nextId += 1;
  sessions = [...sessions, { id, ...input }];
  return id;
}

export function getPresentationSession(id: number): PresentationSession | undefined {
  const session = sessions.find((candidate) => candidate.id === id);
  if (session === undefined) return undefined;
  // 只把只读的四个字段交出去：`resolve` 是账本内部的事。
  return {
    id: session.id,
    page: session.page,
    params: session.params,
    presentation: session.presentation,
  };
}

/**
 * 结算一个会话。
 *
 * 返回 `false` 表示"这个 id 已经结算过了（或从来没存在过）"——调用方据此判断要不要
 * 再执行"关掉这一屏"的副作用。**同一次出席只能结算一次**：审批在用户点"允许"的同一帧
 * 里既可能走 `finish()`（点按钮）也可能走 `cancel()`（侧滑/返回），两边都去 dismiss
 * 的话会把**下面那一屏**也一起关掉（`router.dismiss()` 关的是最上面那个）。
 */
export function settlePresentationSession(
  id: number,
  result: PresentationResult<unknown>,
): boolean {
  const session = sessions.find((candidate) => candidate.id === id);
  if (session === undefined) return false;
  sessions = sessions.filter((candidate) => candidate.id !== id);
  session.resolve(result);
  return true;
}

export function completePresentationSession(id: number, value: unknown): boolean {
  return settlePresentationSession(id, { status: 'completed', value });
}

export function cancelPresentationSession(id: number): boolean {
  return settlePresentationSession(id, { status: 'cancelled' });
}
