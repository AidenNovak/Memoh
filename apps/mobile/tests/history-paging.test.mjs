/**
 * 历史向前翻页（A2）：**真的能往回翻**，而且不重复不丢。
 *
 * 判据来自 `docs/research/review-engineering-standards.md` A2 与 `docs/research/memoh-api.md`
 * §3.3 的两条服务端事实：
 *
 * 1. `/messages` 的页首会被**延伸到轮次边界**——边界那一轮会与上一页重叠，所以判据
 *    必须按 `turn_id` 去重，**不能**按条数（"返回数 < limit 就是到底"是错的）；
 * 2. 没有 `has_more`：只有"返回空"才算到底。
 *
 * 场景照评审的写法：101 轮的长会话，往上翻必须能取到第 1 轮。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { olderCursorOf, pageBringsNewTurns } from '../src/features/chat/historyPage.ts';
import {
  applyHistory,
  initialChatState,
  prependHistory,
  olderHistoryFailed,
  turnsForDisplay,
} from '../src/features/chat/reducer.ts';

/** 一轮服务端形状的轮次（user/assistant 各一条，同一 turn_id）。 */
function userTurn(turnId, text, position, id) {
  return { turn_id: turnId, turn_position: position, role: 'user', text, id };
}

function assistantTurn(turnId, text, position, id) {
  return {
    turn_id: turnId,
    turn_position: position,
    role: 'assistant',
    messages: [{ id: 1, type: 'text', content: text }],
    id,
  };
}

function turnKeys(state) {
  return turnsForDisplay(state).map((turn) => turn.key);
}

function userTexts(state) {
  return turnsForDisplay(state)
    .map((turn) => turn.user?.blocks?.map((block) => block.text).join('') ?? '')
    .filter((text) => text !== '');
}

test('游标 = 这一页最老那一轮的消息 id（不按数组顺序猜）', () => {
  const page = [
    userTurn('t5', '第五轮', 5, 'msg-5'),
    userTurn('t3', '第三轮', 3, 'msg-3'),
    userTurn('t4', '第四轮', 4, 'msg-4'),
  ];
  assert.equal(olderCursorOf(page), 'msg-3');
});

test('最老那一轮没有 id（服务端 omitempty）：不给游标，别猜一个', () => {
  assert.equal(olderCursorOf([userTurn('t3', '第三轮', 3, undefined)]), null);
  assert.equal(olderCursorOf([userTurn('t3', '第三轮', 3, '  ')]), null);
  assert.equal(olderCursorOf([]), null);
});

test('一页里有没有新东西：靠 turn_id 判，不靠条数', () => {
  assert.equal(pageBringsNewTurns(['t3', 't4'], [userTurn('t2', '第二轮', 2, 'msg-2')]), true);
  assert.equal(
    pageBringsNewTurns(['t3', 't4'], [userTurn('t3', '第三轮', 3, 'msg-3')]),
    false,
    '全是已经加载过的（页首延伸造成重叠）→ 没有新内容',
  );
});

test('向前接一页：老的排在前面、已有的更新版本不被覆盖、重叠的那一轮只留一份', () => {
  let state = applyHistory(initialChatState, [
    userTurn('t3', '第三轮', 3, 'msg-3'),
    assistantTurn('t3', '第三轮的回复', 3, 'msg-3'),
    userTurn('t4', '第四轮', 4, 'msg-4'),
  ]);
  assert.equal(olderCursorOf([userTurn('t3', '第三轮', 3, 'msg-3')]), 'msg-3');

  // 下一页：服务端把页首延伸到轮次边界，于是 t3 又回来了一次。
  state = prependHistory(state, [
    userTurn('t1', '第一轮', 1, 'msg-1'),
    userTurn('t2', '第二轮', 2, 'msg-2'),
    userTurn('t3', '第三轮', 3, 'msg-3'),
  ]);

  assert.deepEqual(turnKeys(state), ['t1', 't2', 't3', 't4'], '顺序按 turn_position，不按到达顺序');
  assert.deepEqual(userTexts(state), ['第一轮', '第二轮', '第三轮', '第四轮']);
  assert.equal(state.olderCursor, 'msg-1', '游标跟着往前挪');
  assert.equal(state.olderExhausted, false);
});

test('往回翻到底（返回空）：说没有更早的了，不再请求', () => {
  let state = applyHistory(initialChatState, [userTurn('t1', '第一轮', 1, 'msg-1')]);
  state = prependHistory(state, []);

  assert.equal(state.olderExhausted, true);
  assert.equal(state.olderCursor, null, '到底了就不该留着游标（留着就会一直请求空页）');
  assert.deepEqual(turnKeys(state), ['t1'], '到底不等于把已有的内容清掉');
});

test('回来的一页全是已经加载过的：停下，不无限打转', () => {
  let state = applyHistory(initialChatState, [userTurn('t3', '第三轮', 3, 'msg-3')]);
  state = prependHistory(state, [userTurn('t3', '第三轮', 3, 'msg-3')]);

  assert.equal(state.olderExhausted, true);
  assert.equal(state.olderCursor, null);
});

test('向前接页**不动**活跃 run 的渲染缓冲（这是与整页刷新的关键区别）', () => {
  // 整页刷新（applyHistory）会收起 live 缓冲并清掉 pendingSend；向前翻页只是补老内容，
  // 正在跑的那一轮不能被它碰到——否则用户翻一次历史就看到回复闪断。
  let state = applyHistory(initialChatState, [userTurn('t3', '第三轮', 3, 'msg-3')]);
  state = {
    ...state,
    liveUserTurns: [userTurn('t9', '正在跑的这一轮', 9, 'msg-9')],
    pendingSend: true,
    pendingInvocationId: 'inv-9',
  };

  const next = prependHistory(state, [userTurn('t1', '第一轮', 1, 'msg-1')]);

  assert.equal(next.pendingSend, true);
  assert.equal(next.pendingInvocationId, 'inv-9');
  assert.equal(next.liveUserTurns.length, 1);
  assert.deepEqual(userTexts(next), ['第一轮', '第三轮', '正在跑的这一轮']);
});

test('整页刷新（applyHistory）：游标跟着最新那一页重算', () => {
  let state = applyHistory(initialChatState, [userTurn('t1', '第一轮', 1, 'msg-1')]);
  state = prependHistory(state, []);
  assert.equal(state.olderExhausted, true, '前提：上一页已经翻到底了');

  state = applyHistory(state, [
    userTurn('t7', '第七轮', 7, 'msg-7'),
    userTurn('t8', '第八轮', 8, 'msg-8'),
  ]);

  assert.equal(state.olderCursor, 'msg-7', '刷新后从最新页的最老那一轮继续往前');
  assert.equal(state.olderExhausted, false, '上一轮的"到底"结论不能带到新的一页上');
  assert.equal(state.olderError, null);
});

test('翻页失败：说得出原因，游标留着（用户还能再试）', () => {
  let state = applyHistory(initialChatState, [userTurn('t7', '第七轮', 7, 'msg-7')]);
  state = olderHistoryFailed(state, 'error.network');

  assert.equal(state.olderError, 'error.network');
  assert.equal(state.olderCursor, 'msg-7', '失败不是"没有更早的"，游标必须留着');
  assert.equal(state.olderExhausted, false);

  // 再成功一次就把那句话收掉。
  state = prependHistory(state, [userTurn('t1', '第一轮', 1, 'msg-1')]);
  assert.equal(state.olderError, null);
});
