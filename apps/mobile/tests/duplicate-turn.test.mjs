/**
 * 打开一个**已完成的会话**时，同一轮只许出现一次。
 *
 * ## 这一份要证的那句话
 *
 * > 打开（或重连）一条已经跑完的会话，屏幕上**同一轮只有一份**，而且留在屏幕上的
 * > 那份**带着 `reasoning_timing`**（折叠态那句"思考了 N 秒"）。
 *
 * ## 真服务端的形状（不是猜的）
 *
 * 下面 `REAL_*` 三个常量来自这条部署上的**真会话**
 * （`7925aad5-7f29-44b1-84fd-3fd25ef2b893`，2026-09-18 用只读探针抓的原文字段，
 * 原始 JSON 与截图在 `docs/research/assets/chat-copy-and-reasoning-20260918/`）：
 *
 * - REST 历史：`turn_id = 09ceddef-…` 的 user 与 assistant **两条独立轮次**
 *   （同 `turn_position`），助手那条的 `messages` 是 `id=0 reasoning`（带
 *   `reasoning_timing.duration_ms = 2414`）+ `id=1 text`；
 * - runtime 快照：`current_run_view.status = "completed"`、**同一个 `turn_id`**、
 *   同一批消息 id，**但 `reasoning_timing` 是 null**（实时投影不带它）、`user_turns` 为空。
 *
 * 于是两条通道都在讲同一轮，而其中一份缺了时长。谁后到，谁就决定屏幕上是哪一份。
 *
 * ## 为什么固定服务端看不见
 *
 * `src/features/verify/scenes.ts` 的 `initialSnapshot` 是 `current_run_view: null`——
 * 它从不发一条**已完成**的 run 视图，所以场景台与 `verification/fixture` 都造不出这个
 * 竞态。这一份测试是那个盲点的补丁：**用真 payload 的形状，在纯逻辑里跑**。
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

const TURN_ID = '09ceddef-b885-424c-aec2-530a81c919a8';
const EPOCH = '60e66fb0-dd6f-4ac3-bfdb-4edd8d140c3d';
const REASONING = '用户问的是身份，我该用一句话回答。';
const ANSWER = '我是 Memoh。';
const DURATION_MS = 2414;

/** REST 历史（真形状：user 与 assistant 两条独立轮次，助手那条带 reasoning_timing）。 */
function realHistory() {
  return [
    { turn_id: TURN_ID, role: 'user', turn_position: 1, text: '用一句话说明你是谁' },
    {
      turn_id: TURN_ID,
      role: 'assistant',
      turn_position: 1,
      messages: [
        {
          id: 0,
          type: 'reasoning',
          content: REASONING,
          reasoning_timing: { duration_ms: DURATION_MS },
        },
        { id: 1, type: 'text', content: ANSWER },
      ],
    },
  ];
}

/** runtime 快照（真形状：completed + 同一个 turn_id，但**没有** reasoning_timing）。 */
function realSnapshot(status = 'completed') {
  return {
    bot_id: 'c904ca2a-c419-4ee9-9644-5de5afa63008',
    session_id: '7925aad5-7f29-44b1-84fd-3fd25ef2b893',
    epoch: EPOCH,
    seq: 107,
    current_run_view: {
      run_id: '26847d87-7473-4e7a-a9dd-af09df8851a4',
      turn_id: TURN_ID,
      invocation_id: 'ef2b90a5-9a41-4195-b419-34b7a4e15094',
      status,
      messages: [
        { id: 0, type: 'reasoning', content: REASONING, reasoning_timing: null },
        { id: 1, type: 'text', content: ANSWER },
      ],
      user_turns: [],
    },
  };
}

/** 屏幕上现在有几份助手内容（`__live__` 与历史各算一份）。 */
function assistantCopies(state) {
  return turnsForDisplay(state)
    .filter(hasContent)
    .filter((turn) => (turn.assistant?.blocks.length ?? 0) > 0);
}

/** 屏上那份思考块的时长（没有时长 = 拿的是实时投影那一份）。 */
function reasoningDuration(state) {
  const copies = assistantCopies(state);
  assert.equal(copies.length, 1, `前提：屏上应当只有一份助手内容，实际 ${copies.length} 份`);
  const block = copies[0].assistant.blocks.find((candidate) => candidate.kind === 'reasoning');
  assert.ok(block !== undefined, '前提：这一份里应当有思考块');
  return block.durationMs;
}

/**
 * 逐块算"行身份"，与原生侧 `TranscriptRow.ID` 同一口径。
 * 重复身份会让原生列表**整帧解码失败**（"Messages could not be displayed."），
 * 表现成整条对话停住不动——所以它比"多一条气泡"更严重。
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

function assertNoDuplicateRows(state, label) {
  const identities = rowIdentities(turnsForDisplay(state));
  const duplicates = identities.filter((id, index) => identities.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `${label}：出现重复行身份，原生列表会整帧解码失败`);
}

// ---------------------------------------------------------------- 三种到达顺序

test('到达顺序 A（历史先、快照后）：同一轮只出现一次，带时长的那份在屏上', () => {
  // 打开一条已完成会话时最常见的顺序：REST 先回来，订阅的快照后到。
  // 修前：快照无条件把 completed 的 `messages` 收进 `blocks`，`turnsForDisplay` 再把它
  // 当 `__live__` 追加在历史之后 → 屏上两份，**带时长的那份（历史）在上**，于是"思考了
  // N 秒"被顶出屏幕（截图 `04-duplicate-turn-race.png`）。
  let state = applyHistory(initialChatState, realHistory());
  state = applySnapshot(state, realSnapshot());

  assert.equal(assistantCopies(state).length, 1, '同一轮只许画一份');
  assert.equal(reasoningDuration(state), DURATION_MS, '留在屏上的必须是带时长的那一份');
  assertNoDuplicateRows(state, '历史先、快照后');
});

test('到达顺序 B（快照先、历史后）：同一轮只出现一次，带时长的那份在屏上', () => {
  let state = applySnapshot(initialChatState, realSnapshot());
  state = applyHistory(state, realHistory());

  assert.equal(assistantCopies(state).length, 1, '同一轮只许画一份');
  assert.equal(reasoningDuration(state), DURATION_MS, '历史到了以后要换成带时长的那一份');
  assertNoDuplicateRows(state, '快照先、历史后');
});

test('到达顺序 C（交错：快照 → 历史 → 重连又一条终态帧）：仍然只有一份', () => {
  // 重连时服务端会把同一条终态 run 视图**再发一遍**。幂等性必须成立，否则用户每重连
  // 一次屏幕上就多一份。
  let state = applySnapshot(initialChatState, realSnapshot());
  state = applyHistory(state, realHistory());
  state = applySnapshot(state, { ...realSnapshot(), seq: 108 });
  state = applyDelta(state, EPOCH, 109, { current_run_view: realSnapshot().current_run_view });

  assert.equal(assistantCopies(state).length, 1, '重连/补帧不许把同一轮再画一遍');
  assert.equal(reasoningDuration(state), DURATION_MS, '带时长的那份仍然在屏上');
  assertNoDuplicateRows(state, '交错到达');
});

// ---------------------------------------------------------------- 重连窗口（最容易修坏的地方）

test('重连窗口：run 刚结束、历史还没刷回来时，屏幕不许被清空', () => {
  // 这一条是"整段丢"那种粗暴修法的红线：历史里**还没有**这一轮（上游要到轮次屏障才
  // 落盘），此时把实时那份丢掉，屏幕上就是**整段对话少一条**——比重复更难被发现。
  const state = applySnapshot(initialChatState, realSnapshot());

  assert.equal(assistantCopies(state).length, 1, '历史还没回来时，实时那份就是屏幕上唯一的内容');
  assert.equal(
    reasoningDuration(state),
    undefined,
    '实时投影本来就不带时长——这一份只是"先看得见"，时长等历史回来才补上',
  );
});

test('重连窗口：历史回来了但**不含**这一轮，实时那份不许被清掉', () => {
  // 真实顺序：run 结束 → coordinator 立刻拉一次历史 → 这一轮可能还没落盘。
  // 修前 `applyHistory` 无条件清 `blocks`，屏幕上那一轮直接消失（然后要等下一次刷新）。
  let state = applySnapshot(initialChatState, realSnapshot());
  state = applyHistory(state, [
    { turn_id: 'older-turn', role: 'user', turn_position: 0, text: '更早的一句' },
    {
      turn_id: 'older-turn',
      role: 'assistant',
      turn_position: 0,
      messages: [{ id: 7, type: 'text', content: '更早的回复' }],
    },
  ]);

  assert.equal(assistantCopies(state).length, 2, '更早那轮 + 这一轮，各一份');
  assert.ok(
    assistantCopies(state).some((turn) => turn.key === '__live__'),
    '这一轮历史里还没有，就必须由实时那份顶着（否则屏幕上直接少一条回答）',
  );
});

test('正在跑的 run：历史（不含当前轮）到达时，流式正文不许闪没', () => {
  // 打开一条**正在跑**的会话：快照先到（正文已经在流），REST 历史后到。
  // 正在跑的那一轮不在历史里（`docs/research/verified-behaviour.md` §1），清掉就是闪断。
  let state = applySnapshot(initialChatState, {
    ...realSnapshot('running'),
    current_run_view: {
      ...realSnapshot().current_run_view,
      status: 'running',
      messages: [{ id: 0, type: 'text', content: '正在写……', running: true }],
    },
  });
  state = applyHistory(state, [
    {
      turn_id: 'older-turn',
      role: 'assistant',
      turn_position: 0,
      messages: [{ id: 9, type: 'text', content: '更早的回复' }],
    },
  ]);

  const live = turnsForDisplay(state).find((turn) => turn.key === '__live__');
  assert.ok(live !== undefined, '正在跑的正文必须还在（它历史里还没有）');
  assert.equal(live.assistant.blocks[0].text, '正在写……');
  assertNoDuplicateRows(state, '活跃 run + 历史');
});

test('历史里有这一轮、但助手侧还是空的：实时那份不许被当成"已代表"丢掉', () => {
  // 边界：按 turn_id 命中，但历史那一条**没有可渲染内容**（例如刚落盘、内容为空）。
  // 这时把实时那份收走 = 屏幕上什么都不剩。
  let state = applySnapshot(initialChatState, realSnapshot());
  state = applyHistory(state, [
    { turn_id: TURN_ID, role: 'user', turn_position: 1, text: '用一句话说明你是谁' },
    { turn_id: TURN_ID, role: 'assistant', turn_position: 1, messages: [] },
  ]);

  assert.equal(assistantCopies(state).length, 1, '实时那份要顶着，直到历史真的画出内容');
});

// ---------------------------------------------------------------- 身份缺失时的兜底

test('run 视图没给 turn_id：按消息 id 也认得出"历史里已经有了"', () => {
  // 协议里 `turn_id` 是可选字段。没有身份时也不能退回"看到 completed 就整段丢"，
  // 但也不能认不出来——否则又回到同一轮画两遍。
  let state = applyHistory(initialChatState, realHistory());
  const snapshot = realSnapshot();
  delete snapshot.current_run_view.turn_id;
  state = applySnapshot(state, snapshot);

  assert.equal(
    assistantCopies(state).length,
    1,
    '没有 turn_id 时按消息 id 认（真 payload 两边 id 相同）',
  );
  assert.equal(reasoningDuration(state), DURATION_MS);
});

test('run 视图既没有 turn_id、历史里也没有这批消息 id：仍然不许清屏', () => {
  let state = applyHistory(initialChatState, [
    {
      turn_id: 'older-turn',
      role: 'assistant',
      turn_position: 0,
      messages: [{ id: 9, type: 'text', content: '更早的回复' }],
    },
  ]);
  const snapshot = realSnapshot();
  delete snapshot.current_run_view.turn_id;
  state = applySnapshot(state, snapshot);

  assert.equal(assistantCopies(state).length, 2, '认不出身份就当"历史里还没有"，实时那份留着');
});
