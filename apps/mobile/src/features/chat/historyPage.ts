/**
 * 会话历史的**向前翻页**规则（纯逻辑，不碰 React、不发请求）。
 *
 * ## 为什么需要它
 *
 * `GET /bots/{bot_id}/messages` 是分页的（`limit` 上限 100，默认 30），而客户端只拉过
 * 一页 `limit: 100` 就从不再拉——长会话的第 101 轮往前**在 App 里永远看不到**。
 * 原生列表其实一直在报"滚到顶了"（`NativeMessageList` 的 `onReachTop`），只是 JS 侧
 * 没人接（见 `docs/research/review-engineering-standards.md` A2）。
 *
 * ## 服务端语义（读 fork 源码 + spec 核对，不是猜的）
 *
 * - `before_message_id`：**消息 id**（uuid）游标，返回严格早于它的那些消息
 *   （`internal/chat/message/service.go` 的 `ListBeforeMessageBySession`，键是
 *   `(turn_position, turn_message_seq, created_at, id)` 的 keyset）。
 * - **页首会向前延伸到轮次边界**（`extendToUITurnHead`，最多 200 行），所以返回的轮次数
 *   可能多于 `limit`，而且**边界那一轮会与上一页重叠** → 合并必须按 `turn_id` 去重。
 * - **没有 `has_more`**：判断到底只能靠"返回空"。
 * - `UITurn.id` 是这一轮**第一条消息**的行 id（`chatview.ConvertMessagesToUITurns` 里
 *   user 轮取 `raw.ID`，assistant 轮在建 pending 时取首行且之后不再改写）。页首既然
 *   一定会被延伸到轮次边界，把最老那一轮的 `id` 当下一页游标就是"从这一轮再往前"，
 *   不会原地打转。
 */
import type { UITurn } from '../../api/types.ts';

/** 一次向前翻页要多少轮。服务端 `limit` 上限就是 100。 */
export const HISTORY_PAGE_LIMIT = 100;

/**
 * 下一页的游标：这一页里**最老那一轮**的消息 id。没有可用 id 就返回 `null`（不猜）。
 *
 * 排序判据与渲染一致（`reducer.ts` 的 `positionOf`）：有 `turn_position` 用它，
 * 没有就按数组下标——所以"最老"= 用户看到的**最上面那一轮**，语义不会漂。
 */
export function olderCursorOf(turns: UITurn[]): string | null {
  let oldestIndex = -1;
  let oldestPosition = Number.POSITIVE_INFINITY;
  turns.forEach((turn, index) => {
    const position = typeof turn.turn_position === 'number' ? turn.turn_position : index;
    if (position < oldestPosition) {
      oldestPosition = position;
      oldestIndex = index;
    }
  });
  if (oldestIndex < 0) return null;
  const id = turns[oldestIndex]?.id;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/**
 * 这一页有没有带来**新的**轮次。
 *
 * 用来防"原地打转"：服务端把页首延伸到轮次边界，理论上每次都会带来更老的轮次；
 * 万一某次回来的全是已经在屏幕上的内容，继续按同一个游标请求只会无限重复——
 * 那时宁可停在这里（并如实说"没有更早的了"），也不要空转。
 */
export function pageBringsNewTurns(existingKeys: readonly string[], turns: UITurn[]): boolean {
  const known = new Set(existingKeys);
  return turns.some((turn) => typeof turn.turn_id === 'string' && !known.has(turn.turn_id));
}
