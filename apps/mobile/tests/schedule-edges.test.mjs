/**
 * 定时任务在**三种边界**下的客户端行为：`last run` 的状态映射、本地日期跨天/跨月、
 * 以及按 bot 时区算「下一次」。
 *
 * ## 这些用例为什么要单独存在（而不是并进 `cron.test.mjs`）
 *
 * `cron.test.mjs` 钉的是「表达式 ⇄ 可视化」和 `nextRunAt` 的算法；这里钉的是**服务端事实
 * 落到界面上会变成什么**。三件事各自对应一条读了服务端源码/数据得到的事实
 * （见 `docs/research/schedule-server-behaviour.md`）：
 *
 * 1. **服务端没有「正在跑」这个状态。** `schedule_logs.status` 只允许 `ok`/`error`，运行中的
 *    那行是 `status='ok'` + `completed_at` 为空。所以客户端的映射必须把 `running` 当成
 *    一个**独立**的状态，不能顺手当成成功或失败——这一条错起来是静默的：任务还在跑，
 *    列表上已经写着「成功」。
 * 2. **跨天/跨月时给的是「下一次」，不是刚过去的那次。** 用户照着列表等；差一次就是
 *    「到点了没跑」的错觉。这里用固定 `from` 断言 09:00 的前一分钟 / 整点 / 后一分钟，
 *    以及月末 23:59。
 * 3. **同一个 pattern + 同一个 UTC 时刻，在不同 bot 时区里的「下次」不是同一个时刻。**
 *    `America/Los_Angeles` 与 `Asia/Shanghai` 相差 15 小时（夏令时）或 16 小时（冬令时）；
 *    两边的**本地钟面**都必须是 09:00，而「今天/明天」要按各自时区算。
 *
 * 只测客户端（不测服务端）。跑法：
 * `cd apps/mobile && node --experimental-strip-types --experimental-test-module-mocks --test tests/schedule-edges.test.mjs`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { safeTimezone, DEPLOYMENT_DEFAULT_TIMEZONE } from '../src/features/schedule/describe.ts';
import { normalizeLog } from '../src/features/schedule/model.ts';
import { nextRunAt } from '../src/features/schedule/cron.ts';
import { dayDelta, lastRunLabelKey, nextRunLabel } from '../src/features/schedule/describe.ts';
import { lastRunState } from '../src/features/schedule/model.ts';

/** 测试里的时刻一律写 UTC ISO，不依赖跑测试的机器在哪个时区。 */
const utc = (iso) => new Date(iso);

/** `nextRunAt` 会返回 `null`（算不出来）；断言先确认拿到的是 `Date`，再比 ISO 串。 */
function nextIso(pattern, tz, from) {
  const at = nextRunAt(pattern, tz, from);
  assert.ok(at instanceof Date && !Number.isNaN(at.getTime()), `${pattern} 在 ${tz} 应能算出时间`);
  return at.toISOString();
}

// ---------------------------------------------------------------- last run 的状态

test('last run：`running` 既不算成功也不算失败', () => {
  // 服务端字段是 `status`，取值集合里**没有** running/started；客户端仍然要认它们：一旦
  // 服务端把它加回来（或别处喂进来），这三个状态必须在界面上分开。
  assert.equal(lastRunState('running'), 'running');
  assert.equal(lastRunState('started'), 'running');
  assert.notEqual(lastRunState('running'), 'ok');
  assert.notEqual(lastRunState('running'), 'failed');

  // 文案键也必须落到"正在跑"那一档：不能复用成功/失败的键。
  assert.equal(lastRunLabelKey('running'), 'schedule.last.running');
  assert.notEqual(lastRunLabelKey('running'), 'schedule.last.ok');
  assert.notEqual(lastRunLabelKey('running'), 'schedule.last.failed');

  // 成功/失败各自的键没被串味。
  assert.equal(lastRunLabelKey('ok'), 'schedule.last.ok');
  assert.equal(lastRunLabelKey('failed'), 'schedule.last.failed');
});

test('last run：认不出来的状态不假装成功', () => {
  // 服务端只给小写的 ok/error；大小写不同、或将来多一个没见过的值，都只能落到 unknown。
  // 「unknown 不等于 ok」是这里唯一要保住的性质。
  const unknown = ['', 'RUNNING', 'Running', 'pending', 'queued', 'retry', 'null', 'ok '];
  for (const status of unknown) {
    const state = lastRunState(status);
    assert.equal(state, 'unknown', `status=${JSON.stringify(status)} 应判成 unknown`);
    assert.notEqual(state, 'ok');
    assert.notEqual(state, 'running');
  }
  // unknown 有文案键（界面显示"说不清"），而"没有最近一次"是 null → 不显示这一段。
  assert.equal(lastRunLabelKey('unknown'), 'schedule.last.unknown');
  assert.equal(lastRunLabelKey(null), null);
});

// ---------------------------------------------------------------- 跨天 / 跨月

test('跨天：`0 9 * * *` 在 09:00 前一分钟是今天，后一分钟是明天', () => {
  const tz = 'Asia/Shanghai';

  // 08:59 +08：今天的 09:00 还没到。
  assert.equal(nextIso('0 9 * * *', tz, utc('2026-09-15T00:59:00Z')), '2026-09-15T01:00:00.000Z');

  // 09:01 +08：今天那次**刚刚过去**，答案必须是明天的 09:00，不是 09-15 的 09:00。
  const now = utc('2026-09-15T01:01:00Z');
  const next = nextRunAt('0 9 * * *', tz, now);
  assert.ok(next instanceof Date);
  assert.equal(next.toISOString(), '2026-09-16T01:00:00.000Z');
  assert.ok(next.getTime() > now.getTime(), '下一次必须严格晚于 from');

  // 跨天还要在文案上体现出来：本地日历日 +1，钟面时间不变。
  assert.equal(dayDelta(next, now, tz), 1);
  const label = nextRunLabel(next, now, tz);
  assert.equal(label.kind, 'at');
  assert.equal(label.day, 'tomorrow');
  assert.equal(label.time, '09:00');
  assert.equal(label.date, '09-16');
});

test('跨天：正好落在执行点上时给的是下一次（整点 / 差一毫秒都一样）', () => {
  const tz = 'Asia/Shanghai';
  // 09:00:00 整：这次已经发生，答案仍是明天。
  assert.equal(
    nextIso('0 9 * * *', tz, utc('2026-09-15T01:00:00.000Z')),
    '2026-09-16T01:00:00.000Z',
  );
  // 09:00:00.001：严格来说刚过，也是明天。
  assert.equal(
    nextIso('0 9 * * *', tz, utc('2026-09-15T01:00:00.001Z')),
    '2026-09-16T01:00:00.000Z',
  );
  // 23:59 的前一分钟 → 当天；跨过之后 → 次日。
  assert.equal(nextIso('59 23 * * *', tz, utc('2026-09-15T15:58:00Z')), '2026-09-15T15:59:00.000Z');
  assert.equal(nextIso('59 23 * * *', tz, utc('2026-09-15T15:59:00Z')), '2026-09-16T15:59:00.000Z');
});

test('刻度：`*/15 * * * *` 落在刻度上时取下一个刻度', () => {
  // 10:00:00 整 → 10:15（不是 10:00）：用户看到「下次 10:00」而任务已经跑过，会以为漏跑。
  assert.equal(
    nextIso('*/15 * * * *', 'UTC', utc('2026-09-15T10:00:00.000Z')),
    '2026-09-15T10:15:00.000Z',
  );
  // 刻度前一毫秒 → 就是那个刻度。
  assert.equal(
    nextIso('*/15 * * * *', 'UTC', utc('2026-09-15T09:59:59.999Z')),
    '2026-09-15T10:00:00.000Z',
  );
  // 刻度后一毫秒与刻度后 14:59.999 都是同一个下一次。
  assert.equal(
    nextIso('*/15 * * * *', 'UTC', utc('2026-09-15T10:00:00.001Z')),
    '2026-09-15T10:15:00.000Z',
  );
  assert.equal(
    nextIso('*/15 * * * *', 'UTC', utc('2026-09-15T10:14:59.999Z')),
    '2026-09-15T10:15:00.000Z',
  );
});

test('跨月：月末 23:59 之后给的是下个月', () => {
  const tz = 'Asia/Shanghai';

  // 09-30 23:58 +08 → 当天 23:59。
  assert.equal(nextIso('59 23 * * *', tz, utc('2026-09-30T15:58:00Z')), '2026-09-30T15:59:00.000Z');

  // 09-30 23:59 整 → 10-01 的 23:59（跨月），而且文案说的是"明天"。
  const now = utc('2026-09-30T15:59:00Z');
  const next = nextRunAt('59 23 * * *', tz, now);
  assert.ok(next instanceof Date);
  assert.equal(next.toISOString(), '2026-10-01T15:59:00.000Z');
  assert.equal(dayDelta(next, now, tz), 1);
  const label = nextRunLabel(next, now, tz);
  assert.equal(label.day, 'tomorrow');
  assert.equal(label.time, '23:59');
  assert.equal(label.date, '10-01');

  // 已经是 10-01 00:00 +08：不能退回刚过去的 09-30。
  assert.equal(nextIso('59 23 * * *', tz, utc('2026-09-30T16:00:00Z')), '2026-10-01T15:59:00.000Z');

  // 「每月 1 号 00:00」在月末最后一天看到的就是下月 1 号。
  assert.equal(nextIso('0 0 1 * *', tz, utc('2026-09-30T12:00:00Z')), '2026-09-30T16:00:00.000Z');

  // 跨年也是同一条规则。
  assert.equal(nextIso('59 23 * * *', tz, utc('2026-12-31T15:59:00Z')), '2027-01-01T15:59:00.000Z');
});

// ---------------------------------------------------------------- 时区

test('同一 pattern + 同一 UTC 时刻：LA 与上海的下次差 15/16 小时', () => {
  const pattern = '0 9 * * *';

  // 夏令时（PDT = UTC-7）：from 在两边都是"09:00 之前"。
  const summer = utc('2026-09-15T00:00:00Z'); // 上海 09-15 08:00 / LA 09-14 17:00
  const summerSh = nextRunAt(pattern, 'Asia/Shanghai', summer);
  const summerLa = nextRunAt(pattern, 'America/Los_Angeles', summer);
  assert.ok(summerSh instanceof Date && summerLa instanceof Date);
  assert.equal(summerSh.toISOString(), '2026-09-15T01:00:00.000Z'); // 09:00 +08
  assert.equal(summerLa.toISOString(), '2026-09-15T16:00:00.000Z'); // 09:00 PDT
  assert.equal((summerLa.getTime() - summerSh.getTime()) / 3_600_000, 15);

  // 两边算出来的本地钟面都必须是 09:00——差的是时刻，不是钟面。
  assert.equal(nextRunLabel(summerSh, summer, 'Asia/Shanghai').time, '09:00');
  assert.equal(nextRunLabel(summerLa, summer, 'America/Los_Angeles').time, '09:00');
  // 而"今天/明天"按各自时区算：上海已经是 09-15 早上（今天），LA 还在 09-14 下午（明天）。
  assert.equal(dayDelta(summerSh, summer, 'Asia/Shanghai'), 0);
  assert.equal(dayDelta(summerLa, summer, 'America/Los_Angeles'), 1);
  assert.equal(nextRunLabel(summerSh, summer, 'Asia/Shanghai').day, 'today');
  assert.equal(nextRunLabel(summerLa, summer, 'America/Los_Angeles').day, 'tomorrow');

  // 冬令时（PST = UTC-8）：同一个 pattern 差 16 小时（上海没有夏令时）。
  const winter = utc('2026-01-15T00:00:00Z'); // 上海 01-15 08:00 / LA 01-14 16:00
  const winterSh = nextRunAt(pattern, 'Asia/Shanghai', winter);
  const winterLa = nextRunAt(pattern, 'America/Los_Angeles', winter);
  assert.ok(winterSh instanceof Date && winterLa instanceof Date);
  assert.equal(winterSh.toISOString(), '2026-01-15T01:00:00.000Z'); // 09:00 +08
  assert.equal(winterLa.toISOString(), '2026-01-15T17:00:00.000Z'); // 09:00 PST
  assert.equal((winterLa.getTime() - winterSh.getTime()) / 3_600_000, 16);
  assert.equal(nextRunLabel(winterLa, winter, 'America/Los_Angeles').time, '09:00');
  assert.equal(dayDelta(winterLa, winter, 'America/Los_Angeles'), 1);

  // 反例守卫：如果客户端偷懒用**本地系统时区**算（拿上海的结果配 LA 的钟面），
  // 那次执行的本地时间就不是用户配置的 09:00——所以两者必须来自同一个时区参数。
  const laAsShanghai = nextRunLabel(summerLa, summer, 'Asia/Shanghai');
  assert.notEqual(laAsShanghai.time, '09:00');
});

// ─────────────────────────────────────────────────────────────────────────────
// 补：服务端**从不发** `running`（2026-09-15 在 dev 实例的 Postgres 上只读查证，
// 见 docs/research/schedule-server-behaviour.md）。正在跑的那次是 `status='ok'`
// 且 `completed_at` 为空——只看 status 会把"正在跑"显示成"成功"。
// ─────────────────────────────────────────────────────────────────────────────

test('正在跑的那次不能被显示成成功（completed_at 为空 = 还在跑）', () => {
  const running = normalizeLog({
    schedule_id: 's1',
    status: 'ok',
    started_at: '2026-09-15T04:30:00Z',
    completed_at: '',
  });
  assert.equal(running.completedAt, null);
  assert.equal(lastRunState(running.status, running.completedAt), 'running');

  const done = normalizeLog({
    schedule_id: 's1',
    status: 'ok',
    started_at: '2026-09-15T04:30:00Z',
    completed_at: '2026-09-15T04:30:12Z',
  });
  assert.equal(lastRunState(done.status, done.completedAt), 'ok');

  const failed = normalizeLog({
    schedule_id: 's1',
    status: 'error',
    started_at: '2026-09-15T04:30:00Z',
    completed_at: '2026-09-15T04:30:02Z',
  });
  assert.equal(lastRunState(failed.status, failed.completedAt), 'failed');
});

test('时区兜底是部署默认（UTC），不是本机时区', () => {
  // 服务端在 bot 没设时区时回落部署默认；本机时区（这台是 Asia/Shanghai）会让
  // 显示的"下次执行"和服务端真正执行的时刻差 8 小时。
  assert.equal(safeTimezone(undefined), DEPLOYMENT_DEFAULT_TIMEZONE);
  assert.equal(safeTimezone(''), DEPLOYMENT_DEFAULT_TIMEZONE);
  assert.equal(safeTimezone('Not/AZone'), DEPLOYMENT_DEFAULT_TIMEZONE);
  assert.equal(safeTimezone('Asia/Shanghai'), 'Asia/Shanghai');
});
