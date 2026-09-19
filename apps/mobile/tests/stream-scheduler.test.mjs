/**
 * 流式性能护栏的纯逻辑测试（`features/chat/streamScheduler.ts`）。
 *
 * 两组断言，对应那一轮的两件事：
 *
 * A. **转录快照的发布节奏**：高频 delta 下 leading + trailing、33ms 窗口、不饿死；
 *    flush 立即落地最终值；reset 丢弃未发布的值（旧会话的 trailing 不泄漏）。
 *    时钟是注入的假时钟，所有"过多久才该发布"都是确定性断言，不靠墙钟。
 *
 * B. **会话缓存的释放判据**：只在"要关的还是当前会话"时清；空 id 不误删；
 *    key 不存在时保留原对象引用；切 bot 三份缓存全清。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TRANSCRIPT_SNAPSHOT_INTERVAL_MS,
  clearedSessionMaps,
  closeSessionCache,
  createSnapshotScheduler,
  omitKey,
} from '../src/features/chat/streamScheduler.ts';

const WINDOW = TRANSCRIPT_SNAPSHOT_INTERVAL_MS;

/** 可推进的假时钟：setTimeout 登记的回调在 advance 越过其触发时刻时按序执行。 */
function fakeClock(startAt = 0) {
  let now = startAt;
  let nextId = 1;
  /** @type {Map<number, { fn: () => void, at: number }>} */
  const timers = new Map();
  const runDue = () => {
    for (;;) {
      let due = null;
      for (const [id, entry] of timers) {
        if (entry.at <= now && (due === null || entry.at < due.at || id < due.id)) {
          due = { id, ...entry };
        }
      }
      if (due === null) return;
      timers.delete(due.id);
      due.fn();
    }
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    /** 前进 ms；越过的定时器按触发时刻依次执行（回调里新排的也会被跑到）。 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, entry] of timers) {
          if (entry.at <= target && (due === null || entry.at < due.at || id < due.id)) {
            due = { id, ...entry };
          }
        }
        if (due === null) break;
        now = due.at;
        timers.delete(due.id);
        due.fn();
      }
      now = target;
      runDue();
    },
    pendingTimers: () => timers.size,
  };
}

function recorder(clock, intervalMs = WINDOW) {
  const published = [];
  const scheduler = createSnapshotScheduler({
    intervalMs,
    publish: (value) => published.push({ at: clock.now(), value }),
    clock,
  });
  return { published, scheduler };
}

// ------------------------------------------------------------ A. 发布节奏

test('leading：第一次 push 立即发布，不等窗口', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  scheduler.push('v0');
  assert.deepEqual(published, [{ at: 0, value: 'v0' }]);
  assert.equal(clock.pendingTimers(), 0);
});

test('窗口内的高频 push 只记最新值，trailing 在窗口边界发布最新值', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  scheduler.push('v0'); // leading @0
  for (let t = 1; t <= 10; t += 1) {
    clock.advance(1);
    scheduler.push(`v${t}`);
  }
  // 窗口（33ms）还没满：没有第二次发布，但 trailing 定时器已经排着。
  assert.equal(published.length, 1);
  assert.equal(clock.pendingTimers(), 1);
  clock.advance(WINDOW - 10); // 到 t=33，窗口边界
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], { at: WINDOW, value: 'v10' });
  assert.equal(clock.pendingTimers(), 0);
});

test('持续高频输入不饿死：每个窗口都发一次最新值，间隔不超一个窗口', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  // 每 1ms 一个 delta，持续 300ms（≈ 9 个窗口）。
  for (let t = 0; t <= 300; t += 1) {
    scheduler.push(`v${t}`);
    clock.advance(1);
  }
  clock.advance(WINDOW * 2); // 让最后的 trailing 落地
  assert.ok(published.length >= 9, `300ms 的高频流至少该有 9 份快照，实际 ${published.length}`);
  // 不饿死：相邻两次发布的间隔永远不超过一个窗口。
  for (let i = 1; i < published.length; i += 1) {
    const gap = published[i].at - published[i - 1].at;
    assert.ok(gap <= WINDOW, `第 ${i} 次发布距上一次 ${gap}ms，超过窗口 ${WINDOW}ms`);
  }
  // 最终值必须落地（trailing 不是"窗口内最后一个"，是"最新那个"）。
  assert.equal(published.at(-1).value, 'v300');
});

test('trailing 对齐窗口边界，不漂到两倍窗口', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  scheduler.push('a'); // leading @0
  clock.advance(WINDOW - 1); // t=32，窗口内
  scheduler.push('b');
  clock.advance(1); // t=33 = 窗口边界
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], { at: WINDOW, value: 'b' });
});

test('flush 立即发布最新值，并取消 trailing（之后不再发）', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  scheduler.push('a'); // leading @0
  clock.advance(5);
  scheduler.push('b');
  clock.advance(5);
  scheduler.push('c');
  scheduler.flush(); // run 停止：最终值立刻落地
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], { at: 10, value: 'c' });
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(WINDOW * 3);
  assert.equal(published.length, 2); // trailing 已被取消，没有第三次
});

test('flush 在没有未发布的值时是空操作', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  scheduler.push('a');
  scheduler.flush();
  assert.equal(published.length, 1);
});

test('reset 丢弃未发布的值并清定时器：旧会话的 trailing 不泄漏进新会话', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  scheduler.push('old-0'); // leading @0
  clock.advance(5);
  scheduler.push('old-1'); // 窗口内，等待 trailing
  scheduler.reset(); // 切会话 / 卸载
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(WINDOW * 3);
  assert.deepEqual(
    published.map((p) => p.value),
    ['old-0'],
  );
  // 新会话的第一个值立即 leading（reset 之后窗口重新起算），且不带任何旧值。
  scheduler.push('new-0');
  assert.deepEqual(published.at(-1), { at: WINDOW * 3 + 5, value: 'new-0' });
});

test('同一个引用反复前馈不重复发布，也不排定时器', () => {
  const clock = fakeClock();
  const value = { text: '同一份状态' };
  const { published, scheduler } = recorder(clock);
  scheduler.push(value); // leading
  scheduler.push(value); // 引用没变：跳过
  scheduler.push(value);
  assert.equal(published.length, 1);
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(WINDOW * 2);
  assert.equal(published.length, 1);
});

test('发布间隙超过一个窗口后，下一个 push 重新 leading', () => {
  const clock = fakeClock();
  const { published, scheduler } = recorder(clock);
  scheduler.push('a'); // leading @0
  clock.advance(WINDOW * 5);
  scheduler.push('b'); // 距上次发布早已超过窗口：立即发
  assert.deepEqual(published.at(-1), { at: WINDOW * 5, value: 'b' });
});

// ------------------------------------------------------------ B. 缓存释放

function mapsWith(...ids) {
  const chats = {};
  const queues = {};
  const sessionStatus = {};
  for (const id of ids) {
    chats[id] = { id, kind: 'chat' };
    queues[id] = { id, kind: 'queue' };
    sessionStatus[id] = { id, kind: 'status' };
  }
  return { chats, queues, sessionStatus };
}

test('关会话：命中当前会话时，三份缓存里该 id 的条目都删掉，别的会话留着', () => {
  const maps = mapsWith('a', 'b');
  const released = closeSessionCache('a', 'a', maps);
  assert.notEqual(released, null);
  assert.equal(released.currentSessionId, null);
  assert.deepEqual(Object.keys(released.chats), ['b']);
  assert.deepEqual(Object.keys(released.queues), ['b']);
  assert.deepEqual(Object.keys(released.sessionStatus), ['b']);
  // 别的会话的条目是同一个对象（没被动过）。
  assert.equal(released.chats.b, maps.chats.b);
  assert.equal(released.queues.b, maps.queues.b);
  assert.equal(released.sessionStatus.b, maps.sessionStatus.b);
});

test('关会话：要关的已经不是当前会话 → 不动（旧屏幕迟到的 unmount 不清新会话）', () => {
  const maps = mapsWith('a', 'b');
  // 用户已经打开了 b，a 那一屏的 unmount 才到。
  const released = closeSessionCache('b', 'a', maps);
  assert.equal(released, null);
  // 当前会话为空时也一样：什么都 matched 不上。
  assert.equal(closeSessionCache(null, 'a', maps), null);
});

test('关会话：空/合成 id（/chat/new）绝不匹配，即使当前会话恰好是空串语义', () => {
  const maps = mapsWith('a');
  assert.equal(closeSessionCache('a', '', maps), null);
  assert.equal(closeSessionCache(null, '', maps), null);
});

test('omitKey：key 不存在时返回原对象引用（不为没删到东西付出整表拷贝）', () => {
  const record = { a: 1, b: 2 };
  assert.equal(omitKey(record, 'missing'), record);
  const next = omitKey(record, 'a');
  assert.notEqual(next, record);
  assert.deepEqual(next, { b: 2 });
  assert.deepEqual(record, { a: 1, b: 2 }); // 原对象不被改写
});

test('closeSessionCache 对缺失条目也保留原 map 引用', () => {
  // 会话在 chats 里有，但 queues / sessionStatus 还没拉到：那两份必须原样返回。
  const maps = mapsWith('a');
  const emptyQueues = {};
  const emptyStatus = {};
  const released = closeSessionCache('a', 'a', {
    chats: maps.chats,
    queues: emptyQueues,
    sessionStatus: emptyStatus,
  });
  assert.notEqual(released, null);
  assert.notEqual(released.chats, maps.chats); // 删掉了条目：新对象
  assert.equal(released.queues, emptyQueues); // 没有该 key：引用原样
  assert.equal(released.sessionStatus, emptyStatus);
});

test('切 bot：三份缓存全清（它们整个属于旧 bot）', () => {
  const cleared = clearedSessionMaps();
  assert.deepEqual(cleared, { chats: {}, queues: {}, sessionStatus: {} });
});
