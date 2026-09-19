/**
 * 会话列表的**游标分页**规则（纯逻辑）。
 *
 * 服务端 `GET /bots/{bot_id}/sessions` 支持 `cursor` / `next_cursor`（keyset：
 * `encodeSessionCursor`，`internal/handlers/session.go`），并且**明确**：
 * `next_cursor` 为空串**当且仅当**没有下一页（"clients should stop paging on an empty
 * cursor and never expect a follow-up empty page"）。客户端之前只拉一页 `limit: 50`
 * 就再也不拉，界面上一个字都不说——超过 50 个会话的账号会以为旧会话被删了。
 *
 * 这里的三件事都能直测：游标怎么读、一页怎么并进来、尾部该说什么。
 */
import type { SessionSummary } from './store.tsx';
import { uniqueSessions } from './sessionList.ts';

/** 一页拉多少。服务端默认 50、上限 200；保持默认值，别偷偷改小。 */
export const SESSION_PAGE_LIMIT = 50;

/**
 * 响应里的 `next_cursor` → 可用的游标（`null` = 到底了）。
 *
 * 空串是服务端的"没有下一页"，不是"再请求一次空页"。空白串同理（协议里它是可缺的）。
 */
export function cursorFromResponse(nextCursor: string | undefined): string | null {
  if (typeof nextCursor !== 'string') return null;
  const trimmed = nextCursor.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 把新一页**接在**现有列表后面。
 *
 * 去重仍走 `uniqueSessions`（列表入口的唯一去重点）：翻页时服务端在两次请求之间可能
 * 新增会话，导致两页之间出现同一条——重复 key 会在开发构建里弹出那条压在输入框上的
 * LogBox 横幅（见 `sessionList.ts` 的记录）。
 */
export function appendSessionPage(
  current: SessionSummary[],
  page: SessionSummary[],
): SessionSummary[] {
  return uniqueSessions([...current, ...page]);
}

/**
 * 列表尾部该是什么。`none` = 什么都不显示（到 50 条以内的账号，屏幕上多一个字都是噪音）。
 *
 * - `more`：还有更早的会话（要点就给按钮，滚动到底也会自己加载）；
 * - `loading`：正在拉更早的那一页；
 * - `error`：没拉到（探针实测：静默失败会被当成"没有更早的会话"）。
 */
export type SessionsFooter = 'none' | 'more' | 'loading' | 'error';

export function sessionsFooter(input: {
  /** 还有下一页（`cursorFromResponse` 的结果）。 */
  cursor: string | null;
  loading: boolean;
  error: string | null;
}): SessionsFooter {
  if (input.cursor === null) return 'none';
  if (input.loading) return 'loading';
  if (input.error !== null) return 'error';
  return 'more';
}
