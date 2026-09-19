/**
 * 每个场景的最后一帧，喂给**真实 reducer** 之后到底落在什么状态。
 *
 * ## 为什么需要这一条
 *
 * 场景是"帧回放"（`src/features/verify/scenes.ts` 的文件头写了理由），而它有两个消费者：
 * 场景台（回放**全部**帧）和固定服务端（`sendScene`：只发**第一个** snapshot，其余帧必须是
 * delta 才发得出去）。两者的差别正好是一类 bug 的温床：场景台里看着好好的，走真实 WS 时
 * 什么内容都没到。
 *
 * 2026-09-16 就踩到了这个：四个"等用户决定"的场景（两个审批 + 两个 `ask_user`）把主体内容
 * 写在一个**收尾 snapshot** 里，固定服务端不发它——界面上只剩用户那句话，审批面板/提问表单
 * 根本不出现。那是靠人肉跑 flow 才发现的；这一条把它变成编译期之外的自动检查。
 *
 * 断言的是**所有场景**：最后一帧落到的状态必须至少在**某一个通道**有内容
 * （审批 / 提问 / 消息块 / 用户轮次 / 状态）——一个"回放完什么都没有"的场景没有意义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyDelta,
  applySnapshot,
  hasContent,
  initialChatState,
  turnsForDisplay,
} from '../src/features/chat/reducer.ts';
import { composerActionWithSupport } from '../src/features/chat/queue.ts';
import { SCENES } from '../src/features/verify/scenes.ts';

/** 按 `playback.ts` 的同一条规则回放（snapshot → applySnapshot，delta → applyDelta）。 */
function replay(scene) {
  let state = initialChatState;
  for (const frame of scene.frames) {
    state =
      frame.kind === 'snapshot'
        ? applySnapshot(state, frame.payload)
        : applyDelta(state, frame.epoch, frame.seq, frame.delta);
  }
  return state;
}

test('每个场景回放完都有内容（空场景是没意义的）', () => {
  const empty = [];
  for (const scene of SCENES) {
    const state = replay(scene);
    const hasSomething =
      state.approval !== null ||
      state.userInput !== null ||
      state.order.length > 0 ||
      state.liveUserTurns.length > 0 ||
      state.runStatus !== null;
    if (!hasSomething) empty.push(scene.id);
  }
  assert.deepEqual(empty, [], '这些场景回放完什么都没剩下');
});

/** 一份转录在原生列表里有多少**行**（一个块一行；工具连续行会被原生合并，这里不计那层）。 */
function rowCount(state) {
  return turnsForDisplay(state).reduce(
    (count, turn) => count + (turn.user?.blocks.length ?? 0) + (turn.assistant?.blocks.length ?? 0),
    0,
  );
}

/**
 长会话场景存在的理由只有一个：把"每个 token 的代价是 O(整份转录)"变成能读的数
 （`docs/research/ios-native-code-comparison.md` §2.2 / §3 A 条）。

 所以这一条钉住的不是观感，而是**这个场景真的具备那个形状**：
 历史够长（两档差一个量级）、追加期间**行数不再增长**（增的是同一行的正文）、
 而每次追加要过桥/解码的载荷随行数一起变大。任何一条不成立，那一轮的数字就
 解释不了"长度"这件事。
 */
test('长会话场景：历史够长、追加只改一行、载荷随长度成比例', () => {
  const short = SCENES.find((scene) => scene.id === 'probe-stream-long');
  const deep = SCENES.find((scene) => scene.id === 'probe-stream-long-300');
  const baseline = SCENES.find((scene) => scene.id === 'probe-stream');
  assert.ok(short !== undefined, 'probe-stream-long 不见了');
  assert.ok(deep !== undefined, 'probe-stream-long-300 不见了');

  const measured = [baseline, short, deep].map((scene) => {
    // `seq` 必须从 1 起、逐帧 +1：reducer 把空洞当断线，断了就不是同一份转录。
    const deltas = scene.frames.filter((frame) => frame.kind === 'delta');
    assert.deepEqual(
      deltas.map((frame) => frame.seq),
      deltas.map((_, index) => index + 1),
      `${scene.id} 的 seq 不连续`,
    );

    // 逐帧回放：历史（走 upsert 通道）走完之后，行数只允许**多一行**（流式那行的第一次
    // 出现），其余每一次追加都必须是在**已有行**上加字。这条不成立，"每次追加要重算
    // 整份转录"就无从谈起——那说明这个场景变成了"加行"，而不是"加字"。
    let state = initialChatState;
    let rowsAfterHistory = 0;
    let bytesAfterHistory = 0;
    let lastRows = 0;
    let bytesAtEnd = 0;
    let appends = 0;
    let grew = 0;
    for (const frame of scene.frames) {
      state =
        frame.kind === 'snapshot'
          ? applySnapshot(state, frame.payload)
          : applyDelta(state, frame.epoch, frame.seq, frame.delta);
      const rows = rowCount(state);
      const bytes = JSON.stringify(turnsForDisplay(state).filter(hasContent)).length;
      if (frame.kind === 'delta' && frame.delta.message_appends === undefined) {
        // 历史那一半（用户轮次 / 助手块的 upsert）。收尾那种既不是 upsert 也不是
        // append 的帧两个计数都不动——它不是内容帧。
        if (
          frame.delta.user_turn_upserts === undefined &&
          frame.delta.message_upserts === undefined
        ) {
          continue;
        }
        rowsAfterHistory = rows;
        bytesAfterHistory = bytes;
        lastRows = rows;
        continue;
      }
      if (rows > lastRows) grew += 1;
      lastRows = rows;
      appends += 1;
      bytesAtEnd = bytes;
    }
    assert.ok(appends > 100, `${scene.id} 的追加次数太少`);
    assert.equal(grew, 1, `${scene.id} 的追加阶段多出了行（应是同一行在不断加字）`);
    return { id: scene.id, rows: rowsAfterHistory, bytesAfterHistory, bytesAtEnd, appends };
  });

  const [, long, deeper] = measured;
  assert.ok(
    deeper.rows > long.rows * 4,
    `300 轮那一档必须比 50 轮那一档长一个量级（${long.rows} → ${deeper.rows}）`,
  );
  assert.ok(
    deeper.bytesAfterHistory > long.bytesAfterHistory * 4,
    '过桥的 JSON 也必须跟着变长，否则"单价随长度怎么变"无从谈起',
  );
  assert.ok(long.bytesAtEnd > long.bytesAfterHistory, '追加必须在同一行上加字（载荷要变长）');
});

test('审批场景停在"等你决定"，且带得出待处理审批', () => {
  for (const id of ['approval-with-options', 'approval-no-options']) {
    const scene = SCENES.find((item) => item.id === id);
    assert.ok(scene !== undefined, `${id} 不见了`);
    const state = replay(scene);
    assert.equal(state.runStatus, 'waiting_decision', `${id} 该停在等你决定`);
    assert.ok(state.approval !== null, `${id} 回放完没有待处理审批`);
    assert.equal(state.approval.canApprove, true);
    assert.equal(state.approval.toolName, id === 'approval-no-options' ? 'exec' : 'git_commit');
  }
});

test('走固定服务端那条路（只发第一个 snapshot + 全部 delta）与场景台落到同一个状态', () => {
  // `sendScene` 只取**第一个** snapshot（`frames.find(kind === 'snapshot')`），其余帧必须是
  // delta。所以"等用户决定"这四个场景的收尾帧若是 snapshot，真实 WS 上就什么都收不到——
  // 界面上只剩用户那句话，审批面板/提问表单不出现（2026-09-16 踩到的就是这个）。
  for (const id of [
    'approval-with-options',
    'approval-no-options',
    'ask-user-single',
    'ask-user-multi',
  ]) {
    const scene = SCENES.find((item) => item.id === id);
    assert.ok(scene !== undefined, `${id} 不见了`);
    const last = scene.frames[scene.frames.length - 1];
    assert.equal(last.kind, 'delta', `${id} 的收尾帧是 snapshot，真实 WS 上收不到`);

    // 固定服务端那条路：第一个 snapshot + 按顺序重编号的 delta。
    const firstSnapshot = scene.frames.find((frame) => frame.kind === 'snapshot');
    let delivered = applySnapshot(initialChatState, firstSnapshot.payload);
    let seq = 1;
    for (const frame of scene.frames) {
      if (frame.kind !== 'delta') continue;
      delivered = applyDelta(delivered, frame.epoch, seq, frame.delta);
      seq += 1;
    }

    const full = replay(scene);
    assert.deepEqual(
      {
        approval: delivered.approval?.approvalId ?? null,
        userInput: delivered.userInput?.userInputId ?? null,
        runStatus: delivered.runStatus,
        blocks: delivered.order.length,
        userTurns: delivered.liveUserTurns.length,
      },
      {
        approval: full.approval?.approvalId ?? null,
        userInput: full.userInput?.userInputId ?? null,
        runStatus: full.runStatus,
        blocks: full.order.length,
        userTurns: full.liveUserTurns.length,
      },
      `${id}：场景台看到的东西走真实 WS 到不了客户端`,
    );
  }
});

/**
 * **工具在转圈时 run 必须在跑**：否则界面会同时画出"转圈"和"禁用的发送箭头"。
 *
 * ## 这条防的是什么
 *
 * 2026-09-17：aiden 拿固定服务端截出来的画面评产品，其中一张是"工具行转着圈 + 发送键是
 * 禁用的 ↑"。真服务端不会同时给出这两个表达（run 期间一路发 `current_run_view`，
 * 按钮是"停止"）——那是夹具的错：run 视图写在**第二个 snapshot** 帧里，而一条订阅流
 * 只发第一个 snapshot，于是 `chat.running` 恒为 false。
 *
 * 判据取三条，**两条路都查**（场景台回放全部帧 / 固定服务端只发第一个 snapshot + 全部
 * delta）：因为这两个表面互相矛盾过一次，而只有 WS 那一条是产品。
 */
test('场景里"转圈"与"运行中"不许互相矛盾（两条路都查）', () => {
  const delivered = (scene) => {
    const first = scene.frames.find((frame) => frame.kind === 'snapshot');
    let state = applySnapshot(initialChatState, first.payload);
    let seq = 1;
    for (const frame of scene.frames) {
      if (frame.kind !== 'delta') continue;
      state = applyDelta(state, frame.epoch, seq, frame.delta);
      seq += 1;
    }
    return state;
  };

  for (const scene of SCENES) {
    for (const [channel, state] of [
      ['场景台', replay(scene)],
      ['固定服务端', delivered(scene)],
    ]) {
      const spinning = Object.values(state.blocks).filter(
        (block) => block.type === 'tool' && block.running === true,
      ).length;
      const where = `${scene.id}（${channel}）`;
      assert.ok(
        spinning === 0 || state.running === true,
        `${where}：${spinning} 个工具在转圈，而 chat.running=${state.running}——这就是"转圈 + 发送箭头"`,
      );
      if (state.running) {
        assert.equal(
          composerActionWithSupport({ running: true, hasDraft: false, support: 'no' }),
          'stop',
          `${where}：运行中按钮必须是"停止"`,
        );
      }
    }
  }
});
