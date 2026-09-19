/**
 * 会话协调层的行为测试：三条轮询路径的**时机**与**不该发生的那一侧**。
 *
 * ## 为什么需要这一组
 *
 * 这三条路径（10s 队列兜底、15s 孤儿 run 巡检、run 结束边沿）原来长在 1000 行的
 * `SessionProvider` 里，只有一整套真界面才跑得起来。而它们失效的方式全是**静默**的：
 *
 *   - 间隔改错 → 队列永远显示"还在排队"，或者每个 10s 白打一次服务端；
 *   - 边沿退化成"当前不跑就刷" → 流式回复的每一帧后面都跟三个请求；
 *   - 忘记清理 → 卸载之后还在打服务端；
 *   - 孤儿巡检判据丢了 → owner 死掉的 run 永远转圈。
 *
 * 四种都不会在界面上留痕，所以必须靠断言钉住。
 *
 * ## 时间怎么走
 *
 * **不用墙钟、不 sleep。** 本仓库已经吃过一次亏：`realtime-weaknet.test.mjs:69` 那条
 * 时序断言在负载下会假红（它等的是真实时间），单独跑 4 次全绿。这里的时间是注入的：
 * `advance(ms)` 把假时钟推到那一刻，定时器按到期顺序跳。所以"过多久才该发生"和
 * "不该发生"两侧都能写成确定性断言。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ORPHAN_RUN_POLL_INTERVAL_MS,
  QUEUE_POLL_INTERVAL_MS,
  coordinatorView,
  createSessionCoordinator,
} from '../src/features/session/coordinator.ts';
import { initialChatState } from '../src/features/session/reducer-exports.ts';

/** 推进上限：真跑到这个数说明有定时器被改成了 0 周期（会变成死循环）。 */
const ADVANCE_GUARD = 10_000;

/**
 * 可推进的假时间源。
 *
 * 它实现的就是协调层要的那两个方法，语义与真实 `setInterval` 对齐：到期触发、
 * 触发后按同一个周期再挂下一跳、`clearInterval` 之后不再触发。
 */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();

  return {
    clock: () => now,
    timers: {
      setInterval(handler, ms) {
        const id = nextId++;
        pending.set(id, { dueAt: now + ms, ms, handler });
        return id;
      },
      clearInterval(id) {
        pending.delete(id);
      },
    },
    /** 当前挂着的定时器周期（排序后）。用来验"真的只装了两个、而且是 10s / 15s"。 */
    intervalDelays() {
      return [...pending.values()].map((timer) => timer.ms).sort((a, b) => a - b);
    },
    /** 推进 ms 毫秒；期间到期的定时器按时间顺序依次触发。 */
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        let next = null;
        for (const [id, timer] of pending) {
          if (timer.dueAt > target) continue;
          if (next === null || timer.dueAt < next.timer.dueAt) next = { id, timer };
        }
        if (next === null) break;
        guard += 1;
        if (guard > ADVANCE_GUARD) throw new Error('定时器推进次数异常：周期像是被改成了 0');
        now = next.timer.dueAt;
        next.timer.handler();
        // 触发过的这一跳如果是 interval，重新挂下一次（clearInterval 掉的不重挂）。
        if (pending.has(next.id))
          pending.set(next.id, { ...next.timer, dueAt: now + next.timer.ms });
      }
      now = target;
    },
  };
}

/** 一次轮询视图。默认是"开着 s1、run 在跑、没有待发项"。 */
function viewOf(overrides = {}) {
  return {
    currentSessionId: 's1',
    runKnown: true,
    running: false,
    abandoned: false,
    pendingItems: 0,
    ...overrides,
  };
}

/**
 * 假宿主：网络（三个刷新）与收尾动作都只记录调用。
 *
 * 这就是"网络可注入"的落点——浏览器/RN 那边它们真的发请求，这边它们只留下一串
 * `(什么时候、对哪个会话、打了几次)`。
 */
function fakeHost(initial) {
  const calls = {
    refreshQueue: [],
    refreshHistory: [],
    refreshSessionStatus: [],
    settleAbandonedRun: [],
  };
  const view = { current: initial };
  return {
    calls,
    view,
    host: {
      view: () => view.current,
      refreshQueue: (sessionId) => calls.refreshQueue.push(sessionId),
      refreshHistory: (sessionId) => calls.refreshHistory.push(sessionId),
      refreshSessionStatus: (sessionId) => calls.refreshSessionStatus.push(sessionId),
      settleAbandonedRun: (sessionId) => calls.settleAbandonedRun.push(sessionId),
    },
  };
}

function setup(initialView, options = {}) {
  const timers = fakeTimers();
  const logs = [];
  const { host, calls, view } = fakeHost(initialView);
  const coordinator = createSessionCoordinator({
    host,
    timers: timers.timers,
    clock: timers.clock,
    log: (record) => logs.push(record),
    ...options,
  });
  return { coordinator, timers, calls, logs, view };
}

// ---------------------------------------------------------------- 队列兜底轮询（10s）

test('队列轮询：10s 之前不打服务端，到点才打', () => {
  const { coordinator, timers, calls, logs } = setup(viewOf({ pendingItems: 2 }));
  coordinator.start();
  assert.deepEqual(
    timers.intervalDelays(),
    [QUEUE_POLL_INTERVAL_MS, ORPHAN_RUN_POLL_INTERVAL_MS],
    '只该装两个周期，且是 10s 与 15s',
  );
  assert.deepEqual([QUEUE_POLL_INTERVAL_MS, ORPHAN_RUN_POLL_INTERVAL_MS], [10_000, 15_000]);

  timers.advance(9_999);
  assert.deepEqual(calls.refreshQueue, [], '不到 10s 就打了服务端');

  timers.advance(1);
  assert.deepEqual(calls.refreshQueue, ['s1'], '10s 到了应当刷新队列');

  // 定时器是重复的，不是一次性的：有东西排队就一直兜底。
  timers.advance(10_000);
  assert.deepEqual(calls.refreshQueue, ['s1', 's1'], '第二跳应当再来一次');
  assert.deepEqual(
    logs.filter((record) => record.event === 'queue-poll').map((record) => record.outcome),
    ['refresh-queue', 'refresh-queue'],
  );
});

test('队列轮询：空队列时不打服务端（只是空转），排上一条才开始打', () => {
  const { coordinator, timers, calls, view } = setup(viewOf({ pendingItems: 0 }));
  coordinator.start();

  timers.advance(30_000);
  assert.deepEqual(calls.refreshQueue, [], '队列是空的还打服务端 = 每 10s 白一次请求');

  // 跳过是"看当前状态"，不是"只跳第一下"：排上一条之后下一跳就真的打。
  view.current = viewOf({ pendingItems: 1 });
  timers.advance(10_000);
  assert.deepEqual(calls.refreshQueue, ['s1']);
});

test('队列轮询：没有打开的会话时不打服务端', () => {
  const { coordinator, timers, calls } = setup(
    viewOf({ currentSessionId: null, runKnown: false, pendingItems: 3 }),
  );
  coordinator.start();
  timers.advance(30_000);
  assert.deepEqual(calls.refreshQueue, [], '没有打开的会话时不该打服务端');
});

test('队列轮询：stop() 之后一跳都不走，句柄也交还了', () => {
  const { coordinator, timers, calls } = setup(viewOf({ pendingItems: 1 }));
  coordinator.start();
  timers.advance(10_000);
  assert.equal(calls.refreshQueue.length, 1);

  coordinator.stop();
  assert.deepEqual(timers.intervalDelays(), [], 'stop() 必须把两个定时器都清掉');

  timers.advance(120_000);
  assert.equal(calls.refreshQueue.length, 1, '卸载之后还在打服务端');
});

test('队列轮询：start() / stop() 幂等，重复调用不会装出第二套定时器', () => {
  const { coordinator, timers, calls } = setup(viewOf({ pendingItems: 1 }));
  coordinator.start();
  coordinator.start();
  assert.deepEqual(timers.intervalDelays(), [10_000, 15_000], 'start() 两次只该有一套');

  timers.advance(10_000);
  assert.equal(calls.refreshQueue.length, 1, '装了两套的话这里会是 2 次');

  coordinator.stop();
  coordinator.stop();
  coordinator.start();
  assert.deepEqual(timers.intervalDelays(), [10_000, 15_000]);
});

test('日志带你注入的时钟：跳过的那一跳也说得清是为什么', () => {
  const { coordinator, timers, logs } = setup(viewOf({ pendingItems: 0 }));
  coordinator.start();
  timers.advance(10_000);

  assert.deepEqual(logs, [
    { at: 10_000, event: 'queue-poll', sessionId: 's1', outcome: 'skip-empty-queue' },
  ]);
});

// ---------------------------------------------------------------- 孤儿 run 巡检（15s）

test('孤儿 run 巡检：15s 一跳，run 正常跑着时不收尾', () => {
  const { coordinator, timers, calls, logs } = setup(viewOf({ running: true, abandoned: false }));
  coordinator.start();

  timers.advance(14_999);
  assert.deepEqual(calls.settleAbandonedRun, [], '不到 15s 不该动 run 的终态');

  timers.advance(1);
  assert.deepEqual(calls.settleAbandonedRun, [], '租约没过期就收尾 = 把还在跑的 run 判死');
  assert.deepEqual(
    logs.filter((record) => record.event === 'orphan-poll').map((record) => record.outcome),
    ['skip-live-run'],
  );
});

test('孤儿 run 巡检：租约过期时收尾，收尾之后不再重复收尾', () => {
  const { coordinator, timers, calls, view } = setup(viewOf({ running: true, abandoned: true }));
  coordinator.start();

  timers.advance(15_000);
  assert.deepEqual(calls.settleAbandonedRun, ['s1'], 'owner 死掉的 run 必须被收成终态');

  // 真实运行时收尾动作会把状态改成"不跑"，下一跳自然就不再命中。
  view.current = viewOf({ running: false, abandoned: false });
  timers.advance(60_000);
  assert.deepEqual(calls.settleAbandonedRun, ['s1'], '收尾一次就够了');
});

test('孤儿 run 巡检：没有当前会话 / chat 还没建时不动手', () => {
  const { coordinator, timers, calls, view } = setup(
    viewOf({ currentSessionId: null, runKnown: false, running: true, abandoned: true }),
  );
  coordinator.start();
  timers.advance(60_000);
  assert.deepEqual(calls.settleAbandonedRun, [], '没有会话时不该动手');

  view.current = viewOf({ runKnown: false, running: true, abandoned: true });
  timers.advance(60_000);
  assert.deepEqual(calls.settleAbandonedRun, [], 'chat 还没建时不该动手');
});

// ---------------------------------------------------------------- run 结束的边沿

test('run 结束边沿：跑着 → 不跑，三个刷新各触发一次', () => {
  const { coordinator, calls, view } = setup(viewOf({ running: true }));

  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, [], 'run 还在跑，此刻历史还不是权威的');

  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, [], '还是跑着，不算边沿');

  view.current = viewOf({ running: false });
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, ['s1']);
  assert.deepEqual(calls.refreshQueue, ['s1'], 'run 结束正是队列被消费的时机');
  assert.deepEqual(calls.refreshSessionStatus, ['s1'], '用量在这一轮之后变化最明显');
});

test('run 结束边沿：同一状态再喂两次不会重复触发', () => {
  const { coordinator, calls, view } = setup(viewOf({ running: true }));
  coordinator.observeRunState();
  view.current = viewOf({ running: false });
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, ['s1']);

  // 之后的每一次渲染都会再喂一遍（chats 变化就调）——不记边沿的话这里会一直涨。
  coordinator.observeRunState();
  coordinator.observeRunState();
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, ['s1'], '边沿只该触发一次');
  assert.deepEqual(calls.refreshQueue, ['s1']);
  assert.deepEqual(calls.refreshSessionStatus, ['s1']);
});

test('run 结束边沿：首次看到"不跑"不算边沿（它不是状态变化）', () => {
  const { coordinator, calls } = setup(viewOf({ running: false }));
  coordinator.observeRunState();
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, [], '刚打开会话就白刷一遍历史');
  assert.deepEqual(calls.refreshQueue, []);
  assert.deepEqual(calls.refreshSessionStatus, []);
});

test('run 结束边沿：会话之间互不串台（切换会话不会替上一个触发）', () => {
  const { coordinator, calls, view } = setup(viewOf({ currentSessionId: 's1', running: true }));
  coordinator.observeRunState();

  view.current = viewOf({ currentSessionId: 's2', running: true });
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, [], '切到另一个正在跑的会话不是边沿');

  view.current = viewOf({ currentSessionId: 's2', running: false });
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, ['s2']);

  view.current = viewOf({ currentSessionId: 's1', running: false });
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, ['s2', 's1'], 's1 自己的边沿回来时才算数');
});

test('run 结束边沿：没有会话 / chat 还没建时不写记忆，也不触发', () => {
  const { coordinator, calls, view } = setup(
    viewOf({ currentSessionId: null, runKnown: false, running: false }),
  );
  coordinator.observeRunState();

  // 还没建 chat 时的观察不该把记忆写成 false——否则随后真的边沿会被吞掉。
  view.current = viewOf({ runKnown: false, running: false });
  coordinator.observeRunState();
  view.current = viewOf({ runKnown: true, running: true });
  coordinator.observeRunState();
  view.current = viewOf({ runKnown: true, running: false });
  coordinator.observeRunState();
  assert.deepEqual(calls.refreshHistory, ['s1'], '前面那两次无效观察不该吃掉这条边沿');
});

// ---------------------------------------------------------------- 视图映射

test('coordinatorView：队列条数、旧会话、遗弃判据都从 store 状态里读出来', () => {
  const chat = { ...initialChatState, running: true, runLeaseExpiresAt: '2000-01-01T00:00:00Z' };
  const alive = {
    ...initialChatState,
    running: true,
    runLeaseExpiresAt: '2999-01-01T00:00:00Z',
  };

  const view = coordinatorView({
    currentSessionId: 's1',
    chats: { s1: chat, s2: alive },
    queues: { s1: { items: [{ itemId: 'i1' }, { itemId: 'i2' }] }, s2: { items: [] } },
  });
  assert.deepEqual(view, {
    currentSessionId: 's1',
    runKnown: true,
    running: true,
    abandoned: true,
    pendingItems: 2,
  });

  // 租约还没到（或者根本不在跑）就不是遗弃——这两条是"不该收尾"的那一侧。
  assert.equal(
    coordinatorView({ currentSessionId: 's2', chats: { s1: chat, s2: alive }, queues: {} })
      .abandoned,
    false,
  );
  assert.equal(
    coordinatorView({
      currentSessionId: 's1',
      chats: { s1: { ...chat, running: false } },
      queues: {},
    }).abandoned,
    false,
  );

  // 没有打开的会话 / chat 还没建 / 没有队列：都不该冒出待发条数。
  assert.deepEqual(coordinatorView({ currentSessionId: null, chats: {}, queues: {} }), {
    currentSessionId: null,
    runKnown: false,
    running: false,
    abandoned: false,
    pendingItems: 0,
  });
  assert.equal(coordinatorView({ currentSessionId: 's9', chats: {}, queues: {} }).runKnown, false);
  assert.equal(coordinatorView({ currentSessionId: 's9', chats: {}, queues: {} }).pendingItems, 0);
});
