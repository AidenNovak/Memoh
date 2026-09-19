/**
 * 归约器的**失败与边界**分支。
 *
 * `reducer.test.mjs` 覆盖的是"正常帧序列怎么被归约"；这一份只做一件事：把那些**坏了也
 * 看不出来**的分支钉住。它们的共同特征是——后果不是崩溃，而是屏幕上少了一点东西：
 *
 * - 历史拉回来是空的（这一轮还没落盘）→ 本地那条被清掉 = 输入框已清空 + 屏幕上什么都没有；
 * - 迟到的一条帧把待确认状态吃掉 → 用户再也点不到"重试"，也看不到"我发的话在哪"；
 * - 展示结果里出现重复身份 → **原生列表整帧解码失败**（`TranscriptRow.decode` 抛
 *   "Duplicate block identity"），表现成"整条对话停住不动"。
 *
 * 所以这里的断言一律写成**不变量**（"如果 X，那么屏幕上一定还看得见 Y"），不是快照。
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
  isRunAbandoned,
  rejectPendingSend,
  settleAbandonedRun,
  turnsForDisplay,
} from '../src/features/chat/reducer.ts';

/** 屏幕上现在有哪些用户说的话（按显示顺序）。 */
function visibleUserTexts(state) {
  return turnsForDisplay(state)
    .filter(hasContent)
    .map((turn) => turn.user?.blocks.map((block) => block.text).join('') ?? '')
    .filter((text) => text !== '');
}

function userTurn(turnId, text, position) {
  return { turn_id: turnId, role: 'user', text, turn_position: position };
}

function assistantTurn(turnId, text, position) {
  return { turn_id: turnId, role: 'assistant', text, turn_position: position };
}

/**
 * 逐块算出"行身份"，与原生侧 `TranscriptRow.ID` 同一口径
 * （turn / message / role / block / kind）。重复 = 整帧解码失败。
 */
function rowIdentities(turns) {
  const identities = [];
  for (const turn of turns) {
    for (const message of [turn.user, turn.assistant]) {
      if (message === undefined) continue;
      for (const block of message.blocks) {
        identities.push(
          [turn.key, message.key, message.role, block.key, block.kind].join('\u0000'),
        );
      }
    }
  }
  return identities;
}

function assertNoDuplicateRows(turns, label) {
  const identities = rowIdentities(turns);
  const duplicates = identities.filter((id, index) => identities.indexOf(id) !== index);
  assert.deepEqual(
    duplicates,
    [],
    `${label}：出现了重复的行身份，原生列表会整帧解码失败（"Messages could not be displayed."），` +
      '表现成整条对话停住不动',
  );
}

// ---------------------------------------------------------------- 空屏（最贵的失败）

test('历史拉回来是空的：本地那条不许消失（输入框已清空，屏幕再空就真的没了）', () => {
  // 现场（`tools/pending-echo-probe.mjs`，部署实例）：发出去之后、这一轮还没落盘时
  // 拉一次历史——历史里没有这一句。这里无条件清掉本地那份，屏幕上就一句话都没有。
  let state = appendOptimisticUserMessage(initialChatState, '刚发出去的一句', 'inv-1');

  state = applyHistory(state, []);

  assert.deepEqual(
    visibleUserTexts(state),
    ['刚发出去的一句'],
    '这一轮还没落盘的历史是"还不知道"，不是"这一句不存在"',
  );
  assert.equal(state.pendingInvocationId, 'inv-1', '待确认状态同样要留着（界面靠它说"等确认")');
});

test('run 结束的快照（没有 current_run_view）：待确认那条也不许被清掉', () => {
  // run 收尾时服务端会推一条没有活跃 run 的快照。它只该收走 live 内容，不该顺带
  // 把用户刚发的那句话一起收走。
  let state = appendOptimisticUserMessage(initialChatState, '还没回显的一句', 'inv-2');
  state = applySnapshot(state, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 3,
    current_run_view: null,
  });

  assert.deepEqual(visibleUserTexts(state), ['还没回显的一句']);
  assert.equal(state.pendingInvocationId, 'inv-2');
});

test('一条什么都没带的 delta：不许清屏（它不是 reset）', () => {
  // 服务端会推只带心跳性质的空 delta。清屏的后果是整段对话闪没。
  let state = appendOptimisticUserMessage(initialChatState, '我说的话', 'inv-3');
  state = applyDelta(state, 'e1', 1, {
    current_run_view: { run_id: 'r1', status: 'running', messages: [] },
  });
  state = applyDelta(state, 'e1', 2, {});

  assert.deepEqual(visibleUserTexts(state), ['我说的话'], '空 delta 只该推进序号');
  assert.equal(state.epoch, 'e1');
  assert.equal(state.seq, 2, '序号还是要前进的（否则下一条真帧会被判成重复）');
});

test('跨 epoch 的迟到帧：不许清掉本地内容，也不许把"过期"这个信号吞掉', () => {
  let state = appendOptimisticUserMessage(initialChatState, '我说的话', 'inv-4');
  state = applyDelta(state, 'e1', 1, {
    current_run_view: { run_id: 'r1', status: 'running', messages: [], user_turns: null },
  });

  const late = applyDelta(state, 'e2', 1, {
    reset_messages: true,
    current_run_view: { run_id: 'r2', status: 'running', messages: [], user_turns: null },
  });

  assert.equal(late.stale, true, '要标记过期：界面据此说"刷新中"，而不是假装还连着');
  assert.deepEqual(
    visibleUserTexts(late),
    visibleUserTexts(state),
    '跨 epoch 的帧一条都不许被并进来（seq 没有可比性）',
  );
  assert.equal(late.pendingInvocationId, 'inv-4', '更不该顺手把待确认那条收走');
});

// ---------------------------------------------------------------- 覆盖的边界

test('被拒之后的失败状态：历史刷新不许把它清掉（否则重试入口消失）', () => {
  // `run_rejected` 之后 pendingInvocationId 是留着的（那条消息还在屏幕上等用户重试）。
  // 任何一次历史刷新都必须把这套状态整体保留——清掉一半就会出现"消息在、按钮没了"。
  let state = appendOptimisticUserMessage(initialChatState, '被拒的一句', 'inv-5');
  state = rejectPendingSend(state, 'inv-5', { code: 'busy', message: 'agent is busy' });
  assert.equal(state.sendFailure.message, 'agent is busy');

  state = applyHistory(state, [userTurn('t-old', '上一轮的问题', 1)]);

  assert.deepEqual(visibleUserTexts(state), ['上一轮的问题', '被拒的一句']);
  assert.equal(state.pendingInvocationId, 'inv-5', '它还在等用户重试');
  assert.equal(state.sendFailure?.message, 'agent is busy', '失败原因不许被一次历史刷新抹掉');
});

test('助手说了同一句话：不算"服务端回显了用户这句"，本地那条不许让位', () => {
  // 覆盖判断里最容易写错的一条：回显必须是**用户轮次**。少了角色判断，agent 只要
  // 复述一次用户的话，屏幕上刚发的那条就会被顶掉。
  let state = appendOptimisticUserMessage(initialChatState, '帮我改一下', 'inv-6');
  state = applyHistory(state, [assistantTurn('t-a1', '帮我改一下', 1)]);

  assert.ok(
    visibleUserTexts(state).includes('帮我改一下'),
    '用户那条必须还在（不能因为助手复述了一遍就消失）',
  );
  assert.equal(state.pendingInvocationId, 'inv-6');
});

test('用户轮次里出现这一句（回显帧没有 invocation_id）：让位且只剩一份', () => {
  // 形状来自固定服务端：`user_turn_upserts` 那帧没有 invocation_id，只能按正文认。
  // 认不出来的代价是同一句话画两个气泡（原生列表键不同，不会报错，所以只能在这里挡）。
  let state = appendOptimisticUserMessage(initialChatState, '我说的话', 'inv-7');
  state = applyDelta(state, 'e1', 1, { user_turn_upserts: [userTurn('t-echo', '我说的话', 1)] });

  assert.deepEqual(visibleUserTexts(state), ['我说的话'], '有且只有一份');
  assert.equal(state.optimistic.length, 0, '本地那份要收起来');
  assert.equal(state.pendingInvocationId, null, '已经确认了，不该再显示"等确认"');
});

// ---------------------------------------------------------------- 终态与去重

test('本地判死一个 run 之后：服务端的终态必须能覆盖它，并给出真实原因', () => {
  // 租约过期只是"owner 不见了"的线索，不是结论。服务端随后补发的终态才是权威。
  const staleLease = new Date(Date.now() - 60_000).toISOString();
  let state = applySnapshot(initialChatState, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 1,
    current_run_view: {
      run_id: 'r1',
      status: 'running',
      messages: [],
      owner_lease_expires_at: staleLease,
    },
  });
  assert.equal(isRunAbandoned(state), true, '前提：租约确实过期了（否则这条用例什么都没验）');

  state = settleAbandonedRun(state);
  assert.equal(state.runStatus, 'errored');
  assert.equal(state.runError, 'error.runAbandoned');

  const settled = applyDelta(state, 'e1', 2, {
    run: { run_id: 'r1', status: 'errored', error: 'upstream provider returned 500' },
  });

  assert.equal(settled.running, false);
  assert.equal(
    settled.runError,
    'upstream provider returned 500',
    '本地那句"owner 消失"是猜测，服务端说了原因就要以它为准',
  );
});

test('重复判死同一个 run：状态不许再变（幂等）', () => {
  const state = settleAbandonedRun(
    applySnapshot(initialChatState, {
      bot_id: 'b1',
      session_id: 's1',
      epoch: 'e1',
      seq: 1,
      current_run_view: {
        run_id: 'r1',
        status: 'running',
        messages: [],
        owner_lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
      },
    }),
  );

  const again = settleAbandonedRun(state);
  assert.deepEqual(again, state, '第二次判定必须什么都没做（否则会把后续的终态覆盖掉）');
  assert.equal(isRunAbandoned(state), false, '已经落成终态就不再是"没人管的 run"');
});

test('同一轮从两条通道到达：展示结果里必须只有一份，且用更新的那份', () => {
  // REST 历史是落盘的那一条，实时投影是 `current_run_view.user_turns`（steer 轮次两条
  // 路都会带）。两条都画 = 重复身份 = 原生列表整帧解码失败。
  let state = applyHistory(initialChatState, [userTurn('t1', '原来的问题', 1)]);
  state = applyDelta(state, 'e1', 1, {
    current_run_view: {
      run_id: 'r1',
      status: 'running',
      messages: [],
      user_turns: [userTurn('t1', '改过的问题', 1)],
    },
  });

  const turns = turnsForDisplay(state);
  assertNoDuplicateRows(turns, '同一轮从历史与实时两条路到达');
  assert.deepEqual(visibleUserTexts(state), ['改过的问题'], '同一轮只画一次，且实时那份更近');
});

test('正常的一轮：展示结果里每一个行身份都必须唯一', () => {
  // 这条不是"锦上添花"：重复身份会让原生侧整个载荷解码失败，用户看到的是
  // "Messages could not be displayed."（屏幕为空时）或整条对话停住（有旧帧时）。
  let state = applySnapshot(initialChatState, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 1,
    current_run_view: {
      run_id: 'r1',
      invocation_id: 'inv-8',
      status: 'running',
      messages: [
        { id: 1, type: 'tool', name: 'shell', running: true, input: { command: 'ls' } },
        { id: 2, type: 'text', content: '先看一眼目录', running: true },
      ],
      user_turns: [userTurn('t1', '看看这个目录', 1)],
    },
  });
  state = applyHistory(state, [userTurn('t1', '看看这个目录', 1)]);
  state = applyDelta(state, 'e1', 2, {
    message_appends: [{ id: 2, type: 'text', content: '，然后再说' }],
  });

  const turns = turnsForDisplay(state);
  assert.ok(turns.length >= 1, '前提：确实有内容可渲染（否则这条用例什么都没验）');
  assertNoDuplicateRows(turns, '历史 + 活跃 run + 流式缓冲三层拼起来');
});

// ------------------------------------------------- 快照与增量不一致（谁说了算）

/** 活跃轮次（`__live__`）上画出来的助手文字。 */
function liveAssistantText(state) {
  const live = turnsForDisplay(state).find((turn) => turn.key === '__live__');
  if (live === undefined || live.assistant === undefined) return '';
  return live.assistant.blocks
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('');
}

test('增量先到、权威快照后到：快照里没有的那份正文必须被收走', () => {
  // 两条通道的到达顺序不保证（重订阅换回来的快照常常晚于仍在路上的增量）。服务端在
  // 快照里重写了这一轮、而增量那份还留在 `streams`/`blocks` 里时，屏幕上会停着一段
  // **服务端已经不承认的正文**——用户读到的和 agent 实际交付的不是同一份。
  let state = applySnapshot(initialChatState, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 1,
    current_run_view: {
      run_id: 'r1',
      invocation_id: 'inv-9',
      status: 'running',
      messages: [{ id: 5, type: 'text', content: '第一次的说法', running: true }],
    },
  });
  state = applyDelta(state, 'e1', 2, {
    message_appends: [{ id: 5, type: 'text', content: '，补充一句' }],
  });
  assert.equal(liveAssistantText(state), '第一次的说法，补充一句', '前提：增量确实拼到了那条上');

  // 权威快照：这一轮重写过，块 id 都不一样了。
  state = applySnapshot(state, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 9,
    current_run_view: {
      run_id: 'r1',
      invocation_id: 'inv-9',
      status: 'running',
      messages: [{ id: 7, type: 'text', content: '换了一种说法', running: true }],
    },
  });

  assert.equal(
    liveAssistantText(state),
    '换了一种说法',
    '快照是权威状态：它没提到的正文一个字都不许留在屏幕上',
  );
  assert.deepEqual(
    Object.keys(state.streams),
    [],
    '流式缓冲必须一起收走——留着它，`streamOnlyBlocks` 会把旧文本重新画回来',
  );
  assert.deepEqual(state.order.slice().sort(), [7], '块顺序也以快照为准');
  assert.equal(state.seq, 9, '游标跟权威走（否则下一次空洞判定从错误的起点算）');
});

test('终态帧只动活跃轮次：已经落盘的历史一条都不许被它带走', () => {
  // 快照那条路是"整体覆盖"，很容易顺手把终态帧也写成重建。历史是 REST 权威、轮次屏障
  // 之后才落盘的东西，被终态帧清掉的后果是**整个会话的旧对话消失**，只剩最后这一轮。
  let state = applyHistory(initialChatState, [
    userTurn('t1', '更早的那句话', 1),
    assistantTurn('t2', '更早的回复', 2),
  ]);
  state = applySnapshot(state, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 3,
    current_run_view: {
      run_id: 'r2',
      invocation_id: 'inv-10',
      status: 'running',
      messages: [{ id: 9, type: 'text', content: '正在跑', running: true }],
    },
  });

  state = applyDelta(state, 'e1', 4, {
    run: { run_id: 'r2', status: 'failed', error: 'upstream exploded' },
  });

  assert.equal(state.runStatus, 'failed', '终态要落到状态上（界面靠它显示失败与重试）');
  assert.deepEqual(
    visibleUserTexts(state),
    ['更早的那句话'],
    '历史轮次必须还在——终态帧只该动当前这一轮',
  );
  assert.equal(state.history.length, 2, '历史是 REST 的权威，实时帧不许碰它');
});
