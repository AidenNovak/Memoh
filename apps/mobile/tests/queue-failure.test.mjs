/**
 * 会话队列的**失败路径**：提交闸门被迟到的回调弄乱，以及坏数据不该上队列条。
 *
 * ## 为什么这层值得单独钉
 *
 * 闸门错了的代价是**重复入队**——用户双击一下、或者一次失败后的重试抢在了上一个
 * 手势的回调前面，agent 后面就真的会连着答两遍同一句话。而这类错在界面上完全不显示：
 * 两次提交都"成功"了，只是多了一条。
 *
 * 另一半是**坏数据**：服务端加了一个我们不认识的 `status`，队列条就会显示一条永远
 * 不会消失的项（用户以为还欠着）。白名单是刻意的，所以这里把它钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  QueueSubmissionGate,
  queueFailureMessage,
  queuePreview,
  visibleQueueItems,
} from '../src/features/chat/queue.ts';

/** 一个会数数、可预测的身份生成器。 */
function countingGate() {
  let created = 0;
  const gate = new QueueSubmissionGate(() => {
    created += 1;
    return `id-${created}`;
  });
  return { gate, count: () => created };
}

const SAME = { sessionId: 's1', mode: 'follow-up', text: '再补一句' };

function item(overrides = {}) {
  return {
    itemId: 'i1',
    text: '补一句',
    position: 1,
    status: 'accepted',
    kind: 'follow-up',
    ...overrides,
  };
}

test('迟到的回调不许释放正在飞行的手势（否则同一次双击会入两条）', () => {
  // 现场形状（弱网下很常见）：一次提交的请求 20 秒后才回来，那时用户已经点了重试、
  // 又发了新的一句。回调到达的顺序与手势的顺序无关，闸门必须自己守住"哪个手势在飞"。
  const { gate } = countingGate();
  const first = gate.begin(SAME);
  gate.fail(first);
  const replay = gate.begin(SAME);
  assert.equal(replay.invocationId, first.invocationId, '重试必须是同一个身份');
  gate.succeed(replay); // 重试成功了

  const inFlight = gate.begin({ ...SAME, text: '另一句' });
  assert.notEqual(inFlight, null, '前提：确实有一个手势在飞（否则这条用例什么都没验）');

  // 最早那次提交的回调迟到了。
  gate.succeed(first);
  assert.equal(
    gate.begin({ ...SAME, text: '另一句' }),
    null,
    '迟到的成功回调不许释放在飞的手势——否则下一次点击也会排进去（重复一轮）',
  );
  gate.fail(first);
  assert.equal(gate.begin(SAME), null, '迟到的失败回调同样不许释放它（换个文字也不行）');
});

test('失败→重试→再失败：身份链不许断（服务端靠它识别是同一件事）', () => {
  const { gate, count } = countingGate();
  const first = gate.begin(SAME);
  gate.fail(first);
  const retry = gate.begin(SAME);
  gate.fail(retry);
  const retryAgain = gate.begin(SAME);

  assert.equal(retryAgain.invocationId, first.invocationId, '第二次失败之后重试仍是同一次提交');
  assert.equal(count(), 1, '整条重试链只该造一个身份（多造一个就是给服务端两条不同的话）');
});

test('成功之后身份必须清掉：同一句话再发一次是新的一次提交', () => {
  // 不清的话，用户"再发一遍同样的话"会被服务端当作重复提交（幂等去重），
  // 而用户的意思是"让它再跑一轮"。
  const { gate, count } = countingGate();
  const first = gate.begin(SAME);
  gate.fail(first);
  const replay = gate.begin(SAME);
  gate.succeed(replay);

  const next = gate.begin(SAME);

  assert.notEqual(next.invocationId, first.invocationId, '成功之后就是一个新的提交手势');
  assert.equal(count(), 2);
});

test('失败后换了模式（follow-up → steer）：不许复用旧身份', () => {
  // 两条队列，两张提交。把 follow-up 的身份重放到 steer 上，服务端会按 invocation_id
  // 认为"这件事已经在队列里了"，于是插话静默不生效。
  const { gate } = countingGate();
  const followUp = gate.begin(SAME);
  gate.fail(followUp);

  const steer = gate.begin({ ...SAME, mode: 'steer' });

  assert.notEqual(steer.invocationId, followUp.invocationId, '模式不同就是另一个提交手势');
});

test('服务端给了我们不认识的 status：不许显示（白名单之外一律不上队列条）', () => {
  // 服务端加一个新中间态（或回一个坏值）时，显示它的后果是队列条永远挂着一条
  // 既不排队也没跑的消息——用户以为还欠着，而实际上什么都不会发生。
  const items = [
    item({ itemId: 'ok', status: 'accepted' }),
    item({ itemId: 'unknown', status: 'pending' }),
    item({ itemId: 'missing', status: undefined }),
    item({ itemId: 'empty', status: '' }),
    item({ itemId: 'case', status: 'Accepted' }),
  ];

  assert.deepEqual(
    visibleQueueItems(items).map((entry) => entry.itemId),
    ['ok'],
    '只认服务端契约里那两个"排队中/正在取用"的值',
  );
});

test('队列条的折叠计数不许算出负数（坏 limit 不该变成"还有 -1 条"）', () => {
  const items = ['a', 'b'].map((itemId, index) => item({ itemId, position: index + 1 }));

  const negative = queuePreview(items, -1);

  assert.deepEqual(negative.visible, []);
  assert.equal(negative.hidden, 2, '被折叠的条数只能是 0..总数');
});

test('入队失败的说法：非 Error 的抛出值也要读得出来（不许只剩一句"失败了"）', () => {
  // JS 允许 `throw 'boom'`。这里读不出来，用户就只能看到"入队失败"——而真正的原因
  // 就在手里。
  assert.equal(queueFailureMessage('boom'), 'queue.failed:boom');
  assert.equal(
    queueFailureMessage({ code: 409 }),
    'queue.failed:[object Object]',
    '形状再怪也要把它转成一句话，而不是丢掉',
  );
});
