/**
 * 点通知之后怎么办：**去哪儿**、**要不要替用户做决定**、**什么时候放弃**。
 *
 * ## 三个决定各自的理由
 *
 * 1. **去哪儿**：`/chat/<sessionId>`。客户端只认负载里的 `sessionId`，不接受"打开首页
 *    让用户自己找"——审批的价值就是少走几步。
 * 2. **要不要替用户做决定**：只有点了"允许/拒绝"那两个动作才提交决定；点通知本体只是
 *    打开会话。而且提交时用**兜底决策**（`decision: approve|reject`，不带 `option_id`）：
 *    通知里放不下 agent 定义的选项，硬编一个 `allow_once` 等于替 agent 编了一个它
 *    可能没给的选项。
 * 3. **什么时候放弃**：等**那一次**审批（`approvalId` 必须完全相等）。等不到就放弃，
 *    绝不拿"当前挂着的另一次审批"顶上——替用户批准一个他没看见的命令，是这条链路上
 *    唯一不可挽回的错误。
 *
 * ## 防串号
 *
 * 负载里的 `recipientUserId` 与当前登录用户不一致时，**这条通知不属于这个账号**
 * （Lody 第 24 条：换号之后前一个用户的审批弹到了新用户手机上）。这种情况下不深链、
 * 不提交，只报出来。负载没带这个字段时按"无法核对"放行——这是契约里要求服务端带的
 * 字段，缺了是服务端的问题，不该把用户的审批一起吞掉。
 */

import { FALLBACK_APPROVAL_OPTIONS, decisionForFallback } from '../chat/reducer.ts';
import type { NotificationEvent } from './policy.ts';

/** 与原生 `NotificationContract.OpenAction` 一致。 */
export type OpenAction = 'opened' | 'allow' | 'reject';

export interface NotificationOpen {
  sessionId: string;
  approvalId: string | null;
  action: OpenAction;
  event: NotificationEvent | null;
  /** 服务端声称这条通知 belongs to 谁；没有就是 null（无法核对）。 */
  recipientUserId: string | null;
}

const ACTION_NAMES: Record<string, OpenAction> = {
  opened: 'opened',
  allow: 'allow',
  reject: 'reject',
};

const EVENT_NAMES: Record<string, NotificationEvent> = {
  approval_waiting: 'approval_waiting',
  run_finished: 'run_finished',
  run_failed: 'run_failed',
};

function text(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** 原生事件负载 → 打开请求。**没有 sessionId 就没有请求**（与原生同一条判据）。 */
export function parseOpen(raw: unknown): NotificationOpen | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const sessionId = text(record.sessionId);
  if (sessionId === null) return null;
  const actionName = text(record.action);
  const eventName = text(record.event);
  return {
    sessionId,
    approvalId: text(record.approvalId),
    action: actionName === null ? 'opened' : (ACTION_NAMES[actionName] ?? 'opened'),
    event: eventName === null ? null : (EVENT_NAMES[eventName] ?? null),
    recipientUserId: text(record.recipientUserId),
  };
}

/** 这条通知是不是当前用户的。 */
export function matchesCurrentUser(open: NotificationOpen, currentUserId: string | null): boolean {
  if (open.recipientUserId === null) return true;
  if (currentUserId === null) return false;
  return open.recipientUserId === currentUserId;
}

/** 深链目标。路由形态与 `src/app/chat/[sessionId].tsx` 对齐。 */
export function routeFor(open: NotificationOpen): string {
  return `/chat/${encodeURIComponent(open.sessionId)}`;
}

/**
 * 打开会话之后要提交的决定（`null` = 不提交，只是打开）。
 *
 * 返回的是 `respondApproval` 认的**选项 id**：兜底动作那两个（`__fallback_approve__` /
 * `__fallback_reject__`），因为提交时不该带任何 agent 没给过的 `option_id`。
 */
export function approvalOptionIdFor(open: NotificationOpen): string | null {
  if (open.action === 'opened') return null;
  const choice = FALLBACK_APPROVAL_OPTIONS.find(
    (option) => decisionForFallback(option.id) === (open.action === 'allow' ? 'approve' : 'reject'),
  );
  return choice?.id ?? null;
}

/** 等那次审批出现的最长时间。 */
export const APPROVAL_WAIT_MS = 20_000;

export interface PendingApprovalView {
  approvalId: string;
  runId: string;
}

export type Submission =
  /** 还没到时候：会话刚打开，快照还没到。 */
  | { kind: 'wait' }
  /** 提交。 */
  | { kind: 'submit'; optionId: string }
  /** 别提交了，以及为什么。 */
  | { kind: 'stop'; why: 'no_action' | 'no_approval_id' | 'timed_out' | 'not_mine' };

/**
 * 现在该不该提交。
 *
 * 判定顺序里有两条**安全**规则（不是优化）：
 *
 * - `pending.approvalId !== open.approvalId` → 继续等，绝不提交。会话里挂着的可能是
 *   另一次审批（前一次已被处理、或 agent 又发起了一次），替用户批准它就是越权。
 * - 超时 → 放弃（`timed_out`）。用户回到 App 时面板还在，他可以在那儿决定。
 */
export function submissionFor(params: {
  open: NotificationOpen;
  pending: PendingApprovalView | null;
  elapsedMs: number;
  currentUserId?: string | null;
}): Submission {
  const { open, pending, elapsedMs } = params;
  if (currentUserIdOf(params) === false) return { kind: 'stop', why: 'not_mine' };
  const optionId = approvalOptionIdFor(open);
  if (optionId === null) return { kind: 'stop', why: 'no_action' };
  if (open.approvalId === null) return { kind: 'stop', why: 'no_approval_id' };
  if (pending !== null && pending.approvalId === open.approvalId) {
    return { kind: 'submit', optionId };
  }
  if (elapsedMs >= APPROVAL_WAIT_MS) return { kind: 'stop', why: 'timed_out' };
  return { kind: 'wait' };
}

/** `matchesCurrentUser` 的"三态"版本：调用方没给 userId 时不判断。 */
function currentUserIdOf(params: {
  open: NotificationOpen;
  currentUserId?: string | null;
}): boolean {
  if (params.currentUserId === undefined) return true;
  return matchesCurrentUser(params.open, params.currentUserId);
}
