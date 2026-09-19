/**
 * 定时任务 cron 的纯逻辑用例：可视化 ⇄ 表达式往返、下次执行时间。
 *
 * ## 这些用例存在的理由
 *
 * 这一层错起来是**静默**的：`fromCron` 多猜一点点，用户的选择器就会显示成另一个频率；
 * `nextRunAt` 少想一层 DST，列表上就会出现一个根本不会发生的时间。所以这里的断言分三类：
 *
 * 1. **往返**：7 个模式各写成表达式再读回来，必须一模一样（weekly/monthly 多选也是）。
 * 2. **认不出来就 null**：语法合法但没法用选择器表达（`0 0 31 2 *`）、别的方言
 *    （6 段、`@daily`）、乱写——全部 `null`，调用方据此保持「手写 cron」状态。
 * 3. **下次执行**：写死 UTC 时刻做断言（`Asia/Shanghai` 无 DST、`America/New_York` 有），
 *    把「跨天/跨月」「正好整点时取下一个刻度」「0 和 7 都是周日」「DST 前跳当天没有
 *    这个本地时间」四件事钉死。时区相关的结果都不依赖跑测试的机器在哪个时区。
 *
 * 跑法与其他纯逻辑用例一致：`pnpm test`（node --experimental-strip-types --test）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fromCron,
  nextRunAt,
  resolveTimeZone,
  systemTimeZone,
  toCron,
} from '../src/features/schedule/cron.ts';

/** 测试里的时间一律写 UTC ISO，不依赖跑测试的机器在哪个时区。 */
const utc = (iso) => new Date(iso);

// ---------------------------------------------------------------- 往返

test('minutes：N 分钟 → `*/N * * * *` → 回来还是 N', () => {
  for (const step of [1, 2, 5, 7, 15, 30, 59]) {
    const spec = { mode: 'minutes', step };
    const expression = toCron(spec);
    assert.equal(expression, `*/${step} * * * *`);
    assert.deepEqual(fromCron(expression), spec);
  }
});

test('hourly：每小时的第 M 分钟', () => {
  for (const minute of [0, 5, 30, 59]) {
    const spec = { mode: 'hourly', minute };
    const expression = toCron(spec);
    assert.equal(expression, `${minute} * * * *`);
    assert.deepEqual(fromCron(expression), spec);
  }
});

test('daily：每天 H:M', () => {
  for (const [hour, minute] of [
    [0, 0],
    [9, 0],
    [23, 59],
    [7, 5],
  ]) {
    const spec = { mode: 'daily', hour, minute };
    const expression = toCron(spec);
    assert.equal(expression, `${minute} ${hour} * * *`);
    assert.deepEqual(fromCron(expression), spec);
  }
});

test('weekly：星期多选（去重升序），单个星期也走列表形态', () => {
  const single = { mode: 'weekly', hour: 9, minute: 0, weekdays: [1] };
  assert.equal(toCron(single), '0 9 * * 1');
  assert.deepEqual(fromCron('0 9 * * 1'), single);

  const multi = { mode: 'weekly', hour: 18, minute: 30, weekdays: [1, 3, 5] };
  assert.equal(toCron(multi), '30 18 * * 1,3,5');
  assert.deepEqual(fromCron('30 18 * * 1,3,5'), multi);

  // 输入顺序不影响输出：选择器里勾选顺序是随机的。
  assert.equal(
    toCron({ mode: 'weekly', hour: 18, minute: 30, weekdays: [5, 1, 3] }),
    '30 18 * * 1,3,5',
  );
  assert.equal(
    toCron({ mode: 'weekly', hour: 18, minute: 30, weekdays: [1, 1, 3] }),
    '30 18 * * 1,3',
  );

  // 周末两天。
  const weekend = { mode: 'weekly', hour: 8, minute: 0, weekdays: [0, 6] };
  assert.equal(toCron(weekend), '0 8 * * 0,6');
  assert.deepEqual(fromCron('0 8 * * 0,6'), weekend);
});

test('monthly：月日多选', () => {
  const single = { mode: 'monthly', hour: 9, minute: 0, days: [1] };
  assert.equal(toCron(single), '0 9 1 * *');
  assert.deepEqual(fromCron('0 9 1 * *'), single);

  const multi = { mode: 'monthly', hour: 9, minute: 0, days: [1, 15, 31] };
  assert.equal(toCron(multi), '0 9 1,15,31 * *');
  assert.deepEqual(fromCron('0 9 1,15,31 * *'), multi);

  // 31 号合法：有些月份没有 31 号，由 cron 语义决定（那些月份不跑）。
  assert.equal(fromCron('0 0 31 * *')?.mode, 'monthly');
});

test('yearly：单日 + 单月，且日期必须在日历上存在', () => {
  const spec = { mode: 'yearly', hour: 9, minute: 0, day: 1, month: 1 };
  assert.equal(toCron(spec), '0 9 1 1 *');
  assert.deepEqual(fromCron('0 9 1 1 *'), spec);

  const birthday = { mode: 'yearly', hour: 8, minute: 30, day: 29, month: 2 };
  assert.equal(toCron(birthday), '30 8 29 2 *');
  assert.deepEqual(fromCron('30 8 29 2 *'), birthday);
});

test('advanced：原样透传（只确认还是 5 段）', () => {
  for (const expression of ['0 9 1-5 * *', '*/20 9-17 * * 1-5', '0 0 * * 0']) {
    assert.equal(toCron({ mode: 'advanced', expression }), expression);
    assert.equal(toCron({ mode: 'advanced', expression: `  ${expression}  ` }), expression);
  }
  assert.equal(toCron({ mode: 'advanced', expression: '0 9 1-5 * * *' }), null);
});

test('toCron：spec 越界就 null，不写一个看着像样但不对的表达式', () => {
  assert.equal(toCron({ mode: 'minutes', step: 0 }), null);
  assert.equal(toCron({ mode: 'minutes', step: 60 }), null);
  assert.equal(toCron({ mode: 'minutes', step: 2.5 }), null);
  assert.equal(toCron({ mode: 'hourly', minute: 60 }), null);
  assert.equal(toCron({ mode: 'daily', hour: 24, minute: 0 }), null);
  assert.equal(toCron({ mode: 'daily', hour: -1, minute: 0 }), null);
  assert.equal(toCron({ mode: 'weekly', hour: 9, minute: 0, weekdays: [] }), null);
  assert.equal(toCron({ mode: 'weekly', hour: 9, minute: 0, weekdays: [7] }), null);
  assert.equal(toCron({ mode: 'monthly', hour: 9, minute: 0, days: [0] }), null);
  assert.equal(toCron({ mode: 'monthly', hour: 9, minute: 0, days: [32] }), null);
  // 2 月 31 日、4 月 31 日：日历上不存在，写出来就是个永不执行的任务。
  assert.equal(toCron({ mode: 'yearly', hour: 0, minute: 0, day: 31, month: 2 }), null);
  assert.equal(toCron({ mode: 'yearly', hour: 0, minute: 0, day: 31, month: 4 }), null);
  // 4 月 30 日合法。
  assert.equal(toCron({ mode: 'yearly', hour: 0, minute: 0, day: 30, month: 4 }), '0 0 30 4 *');
});

// ---------------------------------------------------------------- 认不出来就 null

test('fromCron：解析不了的输入一律 null，调用方保持手写状态', () => {
  const rejected = [
    // 语法合法但日历上不存在：没有「每年 2 月 31 日」这个时刻。
    '0 0 31 2 *',
    // 方言：6 段（带秒）、@daily、Quartz 的 ? / L / #、名字。
    '* * * * * *',
    '0 9 * * * *',
    '@daily',
    '0 9 ? * *',
    '0 9 * * MON',
    '0 9 * 1 JAN *',
    '0 9 L * *',
    '0 9 * * 1#2',
    // 乱写。
    '',
    '   ',
    'daily',
    '0 9 * *',
    '0 9 * * 1 2 3',
    '60 9 * * *',
    '0 24 * * *',
    '0 9 32 * *',
    '0 9 1 13 *',
    '*/0 * * * *',
    '*/ * * * *',
    '0-70 * * * *',
    '10-5 * * * *',
    '5/2 * * * *',
    // 列表里混着一个写错的元素：不能"跳过它、只认剩下的"——那样用户写的表达式会被静默截断。
    '1,5-a * * * *',
    '0 9 5-a * *',
    '0 9 * * 1,MON',
    // 日 + 星期同时限定：Vixie 是 OR 语义，选择器没有对应模式，不猜。
    '0 9 1 * 1',
    '0 9 1,15 * 3',
    // 多值小时：上游 weekly/monthly/yearly 只支持单个小时值。
    '0 9,18 * * 1',
    '0 9,18 1 * *',
    // 多选分钟但不构成 `*/N`。
    '0,30 9 * * *',
    // 每年 1 号和 15 号：没有对应控件。
    '0 9 1,15 6 *',
  ];
  for (const expression of rejected) {
    assert.equal(fromCron(expression), null, `应当拒绝：${expression}`);
  }
});

test('fromCron：等价手写能认出来（不能因为写法不同就丢掉可视化）', () => {
  // 小时写成 `0-23` 与 `*` 含义相同。
  assert.deepEqual(fromCron('0 0-23 * * *'), { mode: 'hourly', minute: 0 });
  // `* * * * *` 就是每 1 分钟。
  assert.deepEqual(fromCron('* * * * *'), { mode: 'minutes', step: 1 });
  assert.deepEqual(fromCron('*/1 * * * *'), { mode: 'minutes', step: 1 });
  // 星期 7 等价于 0（周日），列表里两种写法去重后是同一个集合。
  assert.deepEqual(fromCron('0 9 * * 7'), { mode: 'weekly', hour: 9, minute: 0, weekdays: [0] });
  assert.deepEqual(fromCron('0 9 * * 0,7'), { mode: 'weekly', hour: 9, minute: 0, weekdays: [0] });
  // 区间写法：`5-7` = 周五、周六、周日。
  assert.deepEqual(fromCron('0 9 * * 5-7'), {
    mode: 'weekly',
    hour: 9,
    minute: 0,
    weekdays: [0, 5, 6],
  });
  // 多段空白不影响。
  assert.deepEqual(fromCron('  0   9  *  *  1  '), {
    mode: 'weekly',
    hour: 9,
    minute: 0,
    weekdays: [1],
  });
});

test('fromCron：区间写成列表也认（含义一样就不是"另一种表达式"）', () => {
  // `0 9 1-5 * *` 就是「每月 1–5 号 09:00」，monthly 的 days 列表能精确表达它，
  // 所以它不该被判成"认不出来"——只是写回来会变成 `0 9 1,2,3,4,5 * *`（同一个含义）。
  assert.deepEqual(fromCron('0 9 1-5 * *'), {
    mode: 'monthly',
    hour: 9,
    minute: 0,
    days: [1, 2, 3, 4, 5],
  });
  // 工作日 = weekly 的五个值。
  assert.deepEqual(fromCron('0 9 * * 1-5'), {
    mode: 'weekly',
    hour: 9,
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
  });
});

test('fromCron 不返回 advanced：认不出来就是 null，由调用方决定怎么显示', () => {
  // 这一条是刻意的取舍记录：下面的表达式语法完全合法，只是没法用选择器表达
  // （多值小时没有对应控件）。返回 advanced 会让界面切进「高级模式」，
  // 而用户看到的还是同一串文字；返回 null 则明确表示「选择器表示不了它」，
  // 界面保持手写并提示。
  assert.equal(fromCron('0 9-17 * * *'), null);
  assert.equal(fromCron('*/20 9-17 * * 1-5'), null);
  assert.equal(fromCron('0 9 1,15 6 *'), null);
});

// ---------------------------------------------------------------- 下次执行

test('nextRunAt：每天 09:00 在 Asia/Shanghai（UTC+8，无 DST）', () => {
  const shanghai = 'Asia/Shanghai';
  // 2026-09-15 08:30 +08：当天 09:00 还没到。
  assert.equal(
    nextRunAt('0 9 * * *', shanghai, utc('2026-09-15T00:30:00Z'))?.toISOString(),
    '2026-09-15T01:00:00.000Z',
  );
  // 正好 09:00 整：下一次是明天，不是「现在」（严格大于 from）。
  assert.equal(
    nextRunAt('0 9 * * *', shanghai, utc('2026-09-15T01:00:00.000Z'))?.toISOString(),
    '2026-09-16T01:00:00.000Z',
  );
  // 差一毫秒也算已经过了：跨天。
  assert.equal(
    nextRunAt('0 9 * * *', shanghai, utc('2026-09-15T01:00:00.001Z'))?.toISOString(),
    '2026-09-16T01:00:00.000Z',
  );
});

test('nextRunAt：跨月', () => {
  // 每月 1 号 09:00 +08。from = 2026-01-31 13:00 +08。
  assert.equal(
    nextRunAt('0 9 1 * *', 'Asia/Shanghai', utc('2026-01-31T05:00:00Z'))?.toISOString(),
    '2026-02-01T01:00:00.000Z',
  );
  // 每月 15 号 09:00 +08，from 已经是当月 15 号 10:00 → 下个月 15 号。
  assert.equal(
    nextRunAt('0 9 15 * *', 'Asia/Shanghai', utc('2026-09-15T02:00:00Z'))?.toISOString(),
    '2026-10-15T01:00:00.000Z',
  );
  // 每年 1 月 1 日 09:00 +08。
  assert.equal(
    nextRunAt('0 9 1 1 *', 'Asia/Shanghai', utc('2026-09-15T02:00:00Z'))?.toISOString(),
    '2027-01-01T01:00:00.000Z',
  );
});

test('nextRunAt：每小时（`M * * * *`）', () => {
  // 08:20 +08 → 09:00 +08 = 01:00Z。
  assert.equal(
    nextRunAt('0 * * * *', 'Asia/Shanghai', utc('2026-09-15T00:20:00Z'))?.toISOString(),
    '2026-09-15T01:00:00.000Z',
  );
  // 跨天：23:30 +08 → 次日 00:00 +08。
  assert.equal(
    nextRunAt('0 * * * *', 'Asia/Shanghai', utc('2026-09-15T15:30:00Z'))?.toISOString(),
    '2026-09-15T16:00:00.000Z',
  );
});

test('nextRunAt：`*/15` 正好落在刻度上时取下一个刻度', () => {
  // 10:00:00 整 → 10:15，不是 10:00。用户看到「下次 10:00」而任务已经跑过了，
  // 会以为任务漏跑；所以下一次必须严格大于 from。
  assert.equal(
    nextRunAt('*/15 * * * *', 'UTC', utc('2026-09-15T10:00:00.000Z'))?.toISOString(),
    '2026-09-15T10:15:00.000Z',
  );
  // 10:00:01 也是 10:15。
  assert.equal(
    nextRunAt('*/15 * * * *', 'UTC', utc('2026-09-15T10:00:01.000Z'))?.toISOString(),
    '2026-09-15T10:15:00.000Z',
  );
  // 10:14:59 → 10:15。
  assert.equal(
    nextRunAt('*/15 * * * *', 'UTC', utc('2026-09-15T10:14:59.000Z'))?.toISOString(),
    '2026-09-15T10:15:00.000Z',
  );
  // 跨小时/跨天：23:50 → 次日 00:00。
  assert.equal(
    nextRunAt('*/15 * * * *', 'UTC', utc('2026-09-15T23:50:00.000Z'))?.toISOString(),
    '2026-09-16T00:00:00.000Z',
  );
  // 每 5 分钟、跨月边界。
  assert.equal(
    nextRunAt('*/5 * * * *', 'UTC', utc('2026-09-30T23:57:00.000Z'))?.toISOString(),
    '2026-10-01T00:00:00.000Z',
  );
});

test('nextRunAt：星期（0 和 7 都是周日）', () => {
  // 2026-09-15 是周二，下一个周日是 09-20。
  assert.equal(
    nextRunAt('0 0 * * 0', 'UTC', utc('2026-09-15T00:00:00Z'))?.toISOString(),
    '2026-09-20T00:00:00.000Z',
  );
  assert.equal(
    nextRunAt('0 0 * * 7', 'UTC', utc('2026-09-15T00:00:00Z'))?.toISOString(),
    '2026-09-20T00:00:00.000Z',
  );
  // 周三（3）：09-15 是周二，次日就是周三。
  assert.equal(
    nextRunAt('30 18 * * 3', 'UTC', utc('2026-09-15T12:00:00Z'))?.toISOString(),
    '2026-09-16T18:30:00.000Z',
  );
  // 周一/三/五 09:00 +08：from 周二 → 周三 09:00 +08。
  assert.equal(
    nextRunAt('0 9 * * 1,3,5', 'Asia/Shanghai', utc('2026-09-15T02:00:00Z'))?.toISOString(),
    '2026-09-16T01:00:00.000Z',
  );
});

test('nextRunAt：DST 前跳当天没有那个本地时间 —— 跳过这一次（保守）', () => {
  // America/New_York 2026-03-08：02:00 EST 直接跳到 03:00 EDT，本地时间 02:00 当天不存在。
  // 取舍：**跳过这一次**，下一次是 03-09 的 02:00 EDT（= 06:00Z）。
  // 为什么不做「挪到 03:00」或「按 EST 硬算」：硬算出来的时刻它的本地钟面不是 02:00，
  // 列表上会显示一个用户写的时间对不上的点；而真 cron 在这些实现上也是跳过。
  // 代价是这一天的任务不显示，但它确实也不会按 02:00 跑。
  assert.equal(
    nextRunAt('0 2 * * *', 'America/New_York', utc('2026-03-08T05:00:00Z'))?.toISOString(),
    '2026-03-09T06:00:00.000Z',
  );
  // 同一条表达式在前一天是正常的 02:00 EST（= 07:00Z）。
  assert.equal(
    nextRunAt('0 2 * * *', 'America/New_York', utc('2026-03-07T05:00:00Z'))?.toISOString(),
    '2026-03-07T07:00:00.000Z',
  );
  // 03:00 那天存在（夏令时里是 03:00 EDT = 07:00Z）：不受缺口影响。
  assert.equal(
    nextRunAt('0 3 * * *', 'America/New_York', utc('2026-03-08T05:00:00Z'))?.toISOString(),
    '2026-03-08T07:00:00.000Z',
  );
});

test('nextRunAt：DST 回拨时同一个本地时间出现两次 —— 只算一次（取第一次）', () => {
  // America/New_York 2026-11-01：01:00 EDT 之后回到 01:00 EST，本地 01:00 出现两次。
  // 取舍：回拨当天**只算一次**，取第一次（05:00Z）。真 cron 回拨当天也是只跑一次。
  assert.equal(
    nextRunAt('0 1 * * *', 'America/New_York', utc('2026-11-01T00:00:00Z'))?.toISOString(),
    '2026-11-01T05:00:00.000Z',
  );
  // 关键的那一条：from = 05:30Z，本地钟面是 01:30 EDT，30 分钟后钟面会再次经过 01:00
  // （06:00Z = 01:00 EST）。我们**不**把那次当成新的一次执行，答案是次日的 01:00。
  // 这条与 Python zoneinfo 的独立实现对齐（见汇报里的交叉验证）。
  assert.equal(
    nextRunAt('0 1 * * *', 'America/New_York', utc('2026-11-01T05:30:00Z'))?.toISOString(),
    '2026-11-02T06:00:00.000Z',
  );
});

test('nextRunAt：非整点偏移、半小时 DST 也算得对', () => {
  // Asia/Kathmandu +05:45：本地 09:15 = 03:30Z。
  assert.equal(
    nextRunAt('15 9 * * *', 'Asia/Kathmandu', utc('2026-09-15T00:00:00Z'))?.toISOString(),
    '2026-09-15T03:30:00.000Z',
  );
  // Pacific/Chatham +12:45：from 已是当地 09-15 12:45，下一次是 09-16 09:45 = 09-15T21:00Z。
  assert.equal(
    nextRunAt('45 9 * * *', 'Pacific/Chatham', utc('2026-09-15T00:00:00Z'))?.toISOString(),
    '2026-09-15T21:00:00.000Z',
  );
  // Australia/Lord_Howe 的 DST 只挪 30 分钟（02:00 → 02:30）。10-04 的 02:30 正好是跳完
  // 之后的第一个有效本地时间（= 10-03T15:30Z），所以它存在、要算进去。
  assert.equal(
    nextRunAt('30 2 * * *', 'Australia/Lord_Howe', utc('2026-10-03T00:00:00Z'))?.toISOString(),
    '2026-10-03T15:30:00.000Z',
  );
  // Europe/Berlin 2026-03-29：02:00 → 03:00，02:00 当天不存在 → 跳到 03-30（CEST）。
  assert.equal(
    nextRunAt('0 2 * * *', 'Europe/Berlin', utc('2026-03-29T00:00:00Z'))?.toISOString(),
    '2026-03-30T00:00:00.000Z',
  );
});

test('nextRunAt：算不出来就 null，不给可能错的时间', () => {
  const from = utc('2026-09-15T00:00:00Z');
  const unsupported = [
    // 日 + 星期同时限定：Vixie 是 OR 语义，我们不表示它。
    '0 9 1 * 1',
    // 解析不了：名字、方言、越界。
    '0 9 * * MON',
    '* * * * * *',
    '@daily',
    '0 9 ? * *',
    '60 9 * * *',
    '*/0 * * * *',
    '',
    'garbage',
    // 合法但窗口内（5 年）永远不匹配：2 月没有 31 日。
    '0 0 31 2 *',
  ];
  for (const expression of unsupported) {
    assert.equal(nextRunAt(expression, 'UTC', from), null, `应当算不出来：${expression}`);
  }
  // from 不是有效时间。
  assert.equal(nextRunAt('0 9 * * *', 'UTC', new Date(Number.NaN)), null);
  // 但 `0 0 29 2 *`（闰年 2 月 29 日）算得出来：窗口要够长。
  assert.equal(
    nextRunAt('0 0 29 2 *', 'UTC', utc('2026-03-01T00:00:00Z'))?.toISOString(),
    '2028-02-29T00:00:00.000Z',
  );
});

test('nextRunAt：时区缺失或解析失败退回系统时区', () => {
  const from = utc('2026-09-15T00:00:00Z');
  const system = systemTimeZone();
  const expected = nextRunAt('0 9 * * *', system, from)?.toISOString();
  assert.equal(resolveTimeZone('Not/AZone'), system);
  assert.equal(resolveTimeZone(''), system);
  assert.equal(resolveTimeZone(undefined), system);
  assert.equal(resolveTimeZone(null), system);
  assert.equal(resolveTimeZone('  Asia/Shanghai  '), 'Asia/Shanghai');
  assert.equal(nextRunAt('0 9 * * *', 'Not/AZone', from)?.toISOString(), expected);
  assert.equal(nextRunAt('0 9 * * *', '', from)?.toISOString(), expected);
  assert.equal(nextRunAt('0 9 * * *', '格林尼治', from)?.toISOString(), expected);
});

test('nextRunAt：与 fromCron 组合成选择器要用的那一对', () => {
  // 选择器里选「每周一、三 18:30」→ 写表达式 → 算下次执行。
  const spec = fromCron(toCron({ mode: 'weekly', hour: 18, minute: 30, weekdays: [3, 1] }) ?? '');
  assert.deepEqual(spec, { mode: 'weekly', hour: 18, minute: 30, weekdays: [1, 3] });
  const expression = toCron(spec);
  assert.equal(expression, '30 18 * * 1,3');
  assert.equal(
    nextRunAt(expression, 'Asia/Shanghai', utc('2026-09-15T02:00:00Z'))?.toISOString(),
    '2026-09-16T10:30:00.000Z',
  );
});
