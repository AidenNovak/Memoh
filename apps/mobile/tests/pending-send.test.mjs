/**
 * "发出去了但看不见"的测试。
 *
 * ## 这一份要钉住什么
 *
 * 用户说了一句、点了发送，然后**在服务端回显之前**看屏幕：那句话必须还在。
 * 以前不是这样——`turnsForDisplay` 是二选一（有权威用户轮次就整段丢掉本地的乐观副本），
 * 而 run 期间服务端**经常还没有**这一轮的 user_turns（`admitting` 阶段是 null，
 * 上一轮的 steer 轮次却已经在里面），于是：
 *
 *   输入框清空 + 请求确实发出去了 + 屏幕上什么都没有
 *
 * 这条路径的现场与机制写在 `docs/research/e2e-suite.md` §4.3。下面的用例按**帧序列**回放，
 * 与真服务端发过来的顺序一致（snapshot → 本地乐观 → 各种 delta → 覆盖）。
 *
 * 另外两条来自 Lody 的判据（`docs/research/lody-desktop-vs-ios-feature-surface.md` §3.3）：
 * 等待态给**文字**不给转圈，且**重试 ≠ 重连**（语义分开、动作分开）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendOptimisticUserMessage,
  applyDelta,
  applyHistory,
  applySnapshot,
  hasContent,
  initialChatState,
  rejectPendingSend,
  turnsForDisplay,
} from '../src/features/chat/reducer.ts';
import { pendingSendView } from '../src/features/chat/pending.ts';

/** 屏幕上现在有哪些用户说的话。 */
function visibleUserTexts(state) {
  return turnsForDisplay(state)
    .filter(hasContent)
    .map((turn) => turn.user?.blocks.map((block) => block.text).join('') ?? '')
    .filter((text) => text !== '');
}

function userTurn(turnId, text, position) {
  return { turn_id: turnId, role: 'user', text, turn_position: position };
}

test('回显没到之前：本地那条一直看得见（已有权威轮次也一样）', () => {
  /**
   现场：会话里**已经**有一个带 user_turns 的 run（上一轮还没收尾，或一个 steer 轮次），
   用户又发了一句，服务端还没把这一轮广播回来。
   */
  let state = applySnapshot(initialChatState, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 1,
    current_run_view: {
      run_id: 'r0',
      invocation_id: 'inv-old',
      status: 'running',
      messages: [],
      user_turns: [userTurn('t-old', '上一句', 1)],
    },
  });
  assert.deepEqual(visibleUserTexts(state), ['上一句']);

  // 发新的一句：本地乐观插进去，此时服务端一个字节都还没回。
  state = appendOptimisticUserMessage(state, '刚发的一句', 'inv-new');

  const texts = visibleUserTexts(state);
  assert.deepEqual(texts, ['上一句', '刚发的一句']);
  // 顺序：权威那一条在前、刚发的那一条在后（否则看起来像"模型抢答"）。
  assert.equal(state.pendingInvocationId, 'inv-new');
});

test('空会话里发第一句：屏幕上不是空的', () => {
  const state = appendOptimisticUserMessage(initialChatState, '第一句', 'inv-1');
  assert.deepEqual(visibleUserTexts(state), ['第一句']);
});

test('服务端把这一轮广播回来之后，本地那条才让位（不是同时出现两个气泡）', () => {
  let state = appendOptimisticUserMessage(initialChatState, '我说的话', 'inv-1');

  // run 起来了，但 user_turns 还是 null：**不能**在这里丢掉本地那条。
  state = applySnapshot(state, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 1,
    current_run_view: {
      run_id: 'r1',
      invocation_id: 'inv-1',
      status: 'admitting',
      messages: [],
      user_turns: null,
    },
  });
  assert.deepEqual(visibleUserTexts(state), ['我说的话']);

  // 权威的用户轮次到了（同一个 invocation_id）→ 本地那条被覆盖，只剩一份。
  state = applyDelta(state, 'e1', 2, {
    current_run_view: {
      run_id: 'r1',
      invocation_id: 'inv-1',
      status: 'running',
      messages: [],
      user_turns: [userTurn('t1', '我说的话', 1)],
    },
  });
  assert.deepEqual(visibleUserTexts(state), ['我说的话']);
  assert.equal(state.optimistic.length, 0);
  assert.equal(state.pendingInvocationId, null);
});

test('别人的轮次到达不会顶掉我那条（覆盖要按 invocation_id 认）', () => {
  let state = appendOptimisticUserMessage(initialChatState, '我说的话', 'inv-1');
  state = applyDelta(state, 'e1', 1, {
    current_run_view: {
      run_id: 'r9',
      invocation_id: 'inv-other',
      status: 'running',
      messages: [],
      user_turns: [userTurn('t-other', '别人说的', 1)],
    },
  });
  assert.deepEqual(visibleUserTexts(state), ['别人说的', '我说的话']);
  assert.equal(state.pendingInvocationId, 'inv-1');
});

test('服务端用 user_turn_upserts 回显（那一帧没有 invocation_id）时，不出现两个气泡', () => {
  /**
   这是**固定服务端**（`verification/fixture/server.mjs`）回显用户轮次的形状：一帧
   `user_turn_upserts`，里面**没有** `invocation_id`。只按 id 认覆盖的话，同一句话会画
   两个气泡（键不同、原生列表也不会报错，所以只能靠这里挡住）。
   */
  let state = applySnapshot(initialChatState, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 1,
    current_run_view: {
      run_id: 'r0',
      invocation_id: 'inv-old',
      status: 'running',
      messages: [],
      user_turns: [userTurn('t-old', '上一句', 1)],
    },
  });
  state = appendOptimisticUserMessage(state, '我说的话', 'inv-1');
  assert.deepEqual(visibleUserTexts(state), ['上一句', '我说的话']);

  // 回显（没有 invocation_id）→ 本地那条让位，只剩权威那一条。
  state = applyDelta(state, 'e1', 2, {
    user_turn_upserts: [userTurn('fixture-echo-1', '我说的话', 2)],
  });
  assert.deepEqual(visibleUserTexts(state), ['上一句', '我说的话']);
  assert.equal(state.optimistic.length, 0);
  assert.equal(state.pendingInvocationId, null);
});

test('REST 历史到了：本地乐观收起来（权威历史就是覆盖）', () => {
  let state = appendOptimisticUserMessage(initialChatState, '我说的话', 'inv-1');
  state = applyHistory(state, [userTurn('t1', '我说的话', 1)]);
  assert.deepEqual(visibleUserTexts(state), ['我说的话']);
  assert.equal(state.pendingInvocationId, null);
});

test('历史里**还没有**这一轮时，本地那条不许消失（真服务端上的实测现场）', () => {
  /**
   现场：`tools/pending-echo-probe.mjs` 在部署实例上跑出来的——发出去之后、这一轮还没
   落盘的时候拉一次历史（App 在"打开会话"和"run 结束"两个时机都会拉）。
   历史里没有这一句，如果这里无条件清掉本地那份，屏幕上就**一句话都没有**了：
   输入框已清空、请求发出去了。
   */
  let state = appendOptimisticUserMessage(initialChatState, '刚发的一句', 'inv-1');
  state = applyHistory(state, [userTurn('t-old', '上一轮的问题', 1)]);
  assert.deepEqual(visibleUserTexts(state), ['上一轮的问题', '刚发的一句']);
  assert.equal(state.pendingInvocationId, 'inv-1');

  // 这一轮真的落盘之后再拉一次 → 那时才让位，而且只剩一条。
  state = applyHistory(state, [
    userTurn('t-old', '上一轮的问题', 1),
    userTurn('t1', '刚发的一句', 2),
  ]);
  assert.deepEqual(visibleUserTexts(state), ['上一轮的问题', '刚发的一句']);
  assert.equal(state.pendingInvocationId, null);
  assert.equal(state.optimistic.length, 0);
});

// ---------------------------------------------------------------- 等待态怎么说

const BASE = { unconfirmed: true, queuedLocally: false, connected: true, failure: null };

test('等确认：给文字、不给转圈、也**不给动作**', () => {
  const view = pendingSendView(BASE);
  assert.equal(view?.phase, 'awaiting');
  assert.equal(view?.textKey, 'chat.pending.awaiting');
  // 这一条是 Lody 的硬规则：结果未确认时**不许重发**，所以没有动作。
  assert.equal(view?.action, null);
});

test('帧还压在 outbox / 断线：动作是**重连**（不是重试）', () => {
  const queued = pendingSendView({ ...BASE, queuedLocally: true });
  assert.equal(queued?.phase, 'queued');
  assert.equal(queued?.action?.id, 'reconnect');
  assert.equal(queued?.action?.labelKey, 'chat.pending.reconnect');
  assert.equal(queued?.action?.hintKey, 'chat.pending.reconnect.hint');

  // 通道没开、但 outbox 已经空了（帧发出去过又掉了）：同样只给重连。
  const offline = pendingSendView({ ...BASE, connected: false });
  assert.equal(offline?.phase, 'queued');
  assert.equal(offline?.action?.id, 'reconnect');
});

test('服务端明确拒了：动作是**重试**，且与重连是两套文案', () => {
  // code 用服务端的真值：能不能原样重发由白名单说了算（见 pending-retry.test.mjs，
  // `session_runtime.session_busy` 是服务端唯一一个"该原样重试"的拒绝）。
  const view = pendingSendView({
    ...BASE,
    failure: {
      invocationId: 'inv-1',
      code: 'session_runtime.session_busy',
      message: 'agent is busy',
    },
  });
  assert.equal(view?.phase, 'failed');
  assert.equal(view?.textKey, 'chat.pending.failed');
  assert.equal(view?.action?.id, 'retry');
  assert.equal(view?.action?.labelKey, 'chat.pending.retry');
  assert.equal(view?.action?.hintKey, 'chat.pending.retry.hint');
  // 服务端给的原因原样转达；没给就不编。
  assert.equal(view?.reason, 'agent is busy');
  assert.equal(
    pendingSendView({ ...BASE, failure: { invocationId: 'inv-1', code: 'x', message: '' } })
      ?.reason,
    null,
  );
});

test('没有待发的就返回 null（空容器会白占一行）', () => {
  assert.equal(pendingSendView({ ...BASE, unconfirmed: false }), null);
  // 没有待发时，就算连接是断的也不该出现这一块——那是连接状态行的事。
  assert.equal(pendingSendView({ ...BASE, unconfirmed: false, connected: false }), null);
});

test('被拒之后那条消息**仍然在屏幕上**（失败不等于消失）', () => {
  let state = appendOptimisticUserMessage(initialChatState, '我说的话', 'inv-1');
  state = rejectPendingSend(state, 'inv-1', {
    code: 'session_runtime.session_busy',
    message: 'nope',
  });

  assert.deepEqual(visibleUserTexts(state), ['我说的话']);
  assert.equal(state.sendFailure?.message, 'nope');
  const view = pendingSendView({
    unconfirmed: state.pendingInvocationId !== null,
    queuedLocally: false,
    connected: true,
    failure: state.sendFailure,
  });
  assert.equal(view?.action?.id, 'retry');

  // 不可重试的 code：消息照样留着、原因照样转达，只是没有可点的按钮。
  const blocked = rejectPendingSend(state, 'inv-1', {
    code: 'session_runtime.invocation_conflict',
    message: 'already submitted with different content',
  });
  const blockedView = pendingSendView({
    unconfirmed: blocked.pendingInvocationId !== null,
    queuedLocally: false,
    connected: true,
    failure: blocked.sendFailure,
  });
  assert.deepEqual(visibleUserTexts(blocked), ['我说的话']);
  assert.equal(blockedView?.reason, 'already submitted with different content');
  assert.equal(blockedView?.action, null);

  // invocation 对不上就不认（一次误发的 rejection 不能牵连别的消息）。
  const other = rejectPendingSend(state, 'inv-9', { code: 'x', message: 'y' });
  assert.equal(other, state);
});
