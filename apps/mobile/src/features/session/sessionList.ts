/**
 * 会话列表的写入规则。
 *
 * ## 为什么这件事需要一个显式的模块
 *
 * `FlatList` 用 `keyExtractor={(item) => item.id}` 渲染会话列表。同一个 id 出现两次时，
 * React 会把它当成同一行的两个兄弟节点，抛出
 * 「Encountered two children with the same key, `.$<session-id>`」——**这条警告用户
 * 看得见**：开发构建里它是屏幕底部那条 LogBox 横幅，正好压在输入框上。
 *
 * 实测复现（模拟器 + 真实服务端，新建会话后立刻发消息，见 `docs/onboarding.md`
 * 附的复现步骤）：列表有两个写入点——
 *
 * 1. `refreshSessions`：整表替换（服务端权威）；
 * 2. `ensureSessionInList`：新会话在列表里还没有标题时，**先查再写**（`GET /sessions/{id}`
 *    拿到标题，然后 prepend 到列表头部）。
 *
 * 第 2 条是异步的：查的时候列表里没有这个会话，取回标题时列表可能已经变了。而且
 * 这个 effect 在开发构建里**同一依赖下会被调用两次**（实测：`同client=true 同session=true
 * 同回调=true 第2次`）——于是第 1 次写进去之后，第 2 次仍会再写一份，重复 key 就此产生。
 *
 * 修复放在两层，各管一件事：
 *
 * - `prependSession`：写入前重新判断——**已经有这个 id 就不写**。这是竞态本身的正解
 *   （也是 React 对 effect 的要求：写入路径必须幂等）。
 * - `uniqueSessions`：状态入口的去重。列表永远是"整表替换"，所以把去重挂在唯一入口
 *   上，服务端分页重叠之类的"脏载荷"也不会渗进 UI。
 */

import type { SessionSummary } from './store.tsx';

/**
 * 按 id 去重，保持原有顺序。
 *
 * 保留第一次出现的那条：列表是"最新的在前"，同一个会话重复出现意味着更靠前的位置
 * 已经有一条更新的版本。
 */
export function uniqueSessions(sessions: SessionSummary[]): SessionSummary[] {
  const seen = new Set<string>();
  const result: SessionSummary[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    result.push(session);
  }
  return result;
}

/**
 * 把一条会话摘要放到列表头部；**已经有同 id 的就不动**（返回原数组）。
 *
 * 返回原数组而不是等值的新数组是有意的：调用方可以直接比较引用来避免一次无谓的
 * dispatch（`next === sessions` 就是"什么都没发生"）。
 */
export function prependSession(
  sessions: SessionSummary[],
  summary: SessionSummary,
): SessionSummary[] {
  if (sessions.some((session) => session.id === summary.id)) return sessions;
  return [summary, ...sessions];
}
