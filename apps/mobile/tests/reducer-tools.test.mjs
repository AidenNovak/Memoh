/**
 * 工具调用渲染的时序回归（本轮补的）。
 *
 * 两条都是"跑起来才看见"的问题，所以用**真形状的帧序列**回放，而不是手搓状态：
 *
 * 1. 文字只有 append 通道、工具只有 upsert 通道。只按 upsert 登记顺序，屏幕上会把
 *    工具行排到文字上面（真机截图里就是「工具行 / 文字 / 文字」）。
 * 2. REST 历史与实时投影可能同时带着同一轮（steer 轮次既落盘又广播）。渲染两遍的话，
 *    原生列表会因为**行身份重复**而判定整份载荷不可解码——整条对话停住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyDelta,
  applyHistory,
  applySnapshot,
  hasContent,
  initialChatState,
  turnsForDisplay,
} from '../src/features/chat/reducer.ts';

function runningState() {
  return applySnapshot(initialChatState, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 0,
    current_run_view: {
      run_id: 'r1',
      turn_id: 't1',
      status: 'running',
      started_at: 'x',
      updated_at: 'x',
      messages: [],
      user_turns: [],
    },
  });
}

/** 屏幕上从上到下的行：`角色/块类型 文本或工具名`。 */
function lines(state) {
  return turnsForDisplay(state)
    .filter(hasContent)
    .flatMap((turn) => [
      ...(turn.user?.blocks ?? []).map((block) => `user ${block.text}`),
      ...(turn.assistant?.blocks ?? []).map((block) =>
        block.kind === 'tool'
          ? `assistant tool:${block.name}`
          : `assistant ${block.kind}:${block.text}`,
      ),
    ]);
}

/** 一个真实的 agent 回合：文字 → 工具 → 文字 → 工具 → 文字（帧序即 id 分配序）。 */
function agentLoop(state, text = '跑测试并更新报告') {
  let seq = 1;
  const send = (delta) => {
    state = applyDelta(state, 'e1', seq, delta);
    seq += 1;
  };

  send({
    user_turn_upserts: [{ turn_id: 't1', role: 'user', text, turn_position: 1 }],
  });
  send({ message_appends: [{ id: 1, type: 'text', content: '先跑测试。' }] });
  send({ message_upserts: [{ id: 2, type: 'tool', name: 'exec', running: true }] });
  send({ message_upserts: [{ id: 2, type: 'tool', name: 'exec', running: false, output: 'ok' }] });
  send({ message_appends: [{ id: 3, type: 'text', content: '测试过了，' }] });
  send({ message_appends: [{ id: 3, type: 'text', content: '接着更新报告。' }] });
  send({ message_upserts: [{ id: 4, type: 'tool', name: 'fs_write', running: true }] });
  send({ message_upserts: [{ id: 4, type: 'tool', name: 'fs_write', running: false }] });
  send({ message_appends: [{ id: 5, type: 'text', content: '报告已更新。' }] });
  return state;
}

test('流式期间文字与工具的先后顺序就是它实际发生的顺序（回归：工具曾全部挤到最上面）', () => {
  const state = agentLoop(runningState());

  assert.deepEqual(lines(state), [
    'user 跑测试并更新报告',
    'assistant text:先跑测试。',
    'assistant tool:exec',
    'assistant text:测试过了，接着更新报告。',
    'assistant tool:fs_write',
    'assistant text:报告已更新。',
  ]);
});

test('终态把整轮重发一遍之后顺序不变（回归：收尾时会再跳一次）', () => {
  let state = agentLoop(runningState());
  const streaming = lines(state);

  // `agent_end` 给的是**全量** messages（`runtimeDeltaForAgentEvent`）。
  state = applyDelta(state, 'e1', 20, {
    message_upserts: [
      { id: 1, type: 'text', content: '先跑测试。' },
      { id: 2, type: 'tool', name: 'exec', running: false, output: 'ok' },
      { id: 3, type: 'text', content: '测试过了，接着更新报告。' },
      { id: 4, type: 'tool', name: 'fs_write', running: false },
      { id: 5, type: 'text', content: '报告已更新。' },
    ],
  });

  assert.deepEqual(lines(state), streaming, '终态不该改变屏幕上从上到下的顺序');
});

test('流式顺序与 REST 历史（权威顺序）一致', () => {
  const streaming = lines(agentLoop(runningState()));

  const history = applyHistory(initialChatState, [
    { turn_id: 't1', role: 'user', text: '跑测试并更新报告', turn_position: 1 },
    {
      turn_id: 't1',
      role: 'assistant',
      turn_position: 2,
      messages: [
        { id: 1, type: 'text', content: '先跑测试。' },
        { id: 2, type: 'tool', name: 'exec', running: false, output: 'ok' },
        { id: 3, type: 'text', content: '测试过了，接着更新报告。' },
        { id: 4, type: 'tool', name: 'fs_write', running: false },
        { id: 5, type: 'text', content: '报告已更新。' },
      ],
    },
  ]);

  assert.deepEqual(streaming, lines(history));
});

test('同一个 turn 在历史与实时里都有时只渲染一次（回归：重复的行身份会让原生列表整份拒绝）', () => {
  // steer 轮次既落盘、又当作用户轮次广播（上游 `PublishQueueUserTurns`）。于是
  // "打开一个正在跑的会话"这条路上，历史与实时会各带一份。
  let state = applyHistory(initialChatState, [
    { turn_id: 't1', role: 'user', text: '先别改前端', turn_position: 1 },
  ]);
  state = applySnapshot(state, {
    bot_id: 'b1',
    session_id: 's1',
    epoch: 'e1',
    seq: 1,
    current_run_view: {
      run_id: 'r1',
      turn_id: 't1',
      status: 'running',
      messages: [],
      user_turns: [{ turn_id: 't1', role: 'user', text: '先别改前端', turn_position: 1 }],
    },
  });

  const shown = turnsForDisplay(state).filter(hasContent);
  const userTurns = shown.filter((turn) => turn.key === 't1');
  assert.equal(
    userTurns.length,
    1,
    `同一个 turn 只能出现一次：${JSON.stringify(shown.map((t) => t.key))}`,
  );
  assert.equal(userTurns[0].user.blocks[0].text, '先别改前端');

  // 行身份 = (轮次, 消息, 角色, 块, 类型)。原生列表要求它唯一，重复就直接判定
  // 整份载荷不可解码（`TranscriptRow.decode` 的 Duplicate block identity）。
  const identities = shown.flatMap((turn) =>
    [turn.user, turn.assistant]
      .filter(Boolean)
      .flatMap((message) =>
        message.blocks.map((block) =>
          [turn.key, message.key, message.role, block.key, block.kind].join('|'),
        ),
      ),
  );
  assert.equal(new Set(identities).size, identities.length, `行身份重复：${identities}`);
});

test('同一个工具块被连着整块替换时位置不动、状态只往前走（回归：高频更新下的抖动）', () => {
  let state = applyDelta(runningState(), 'e1', 1, {
    message_appends: [{ id: 1, type: 'text', content: '跑构建。' }],
  });
  state = applyDelta(state, 'e1', 2, {
    message_upserts: [
      { id: 2, type: 'tool', name: 'exec', running: true, input: { command: 'make' } },
    ],
  });

  const before = lines(state);
  const statuses = [];
  for (const chunk of ['building', 'building..', 'building...']) {
    state = applyDelta(state, 'e1', 3, {
      // 工具块是整块替换：每一次都把输出一起带回来（输出在变长）。
      message_upserts: [
        {
          id: 2,
          type: 'tool',
          name: 'exec',
          running: true,
          input: { command: 'make' },
          output: chunk,
        },
      ],
    });
    statuses.push(turnsForDisplay(state).flatMap((turn) => turn.assistant?.blocks ?? [])[1].status);
  }
  state = applyDelta(state, 'e1', 4, {
    message_upserts: [{ id: 2, type: 'tool', name: 'exec', running: false, output: 'done' }],
  });

  assert.deepEqual(lines(state), before, '同一个块的替换不该改变它在屏幕上的位置');
  assert.ok(
    statuses.every((status) => status === 'running'),
    '运行中不该闪成别的状态',
  );
  const blocks = turnsForDisplay(state).flatMap((turn) => turn.assistant?.blocks ?? []);
  assert.equal(blocks[1].status, 'done');
  assert.equal(blocks[1].output, 'done');
});
