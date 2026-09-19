/**
 * cron 选择器的界面状态（`src/features/schedule/cronPicker.ts`）。
 *
 * 三条"错了也不明显"的规则：
 * 1. 认不出来的表达式必须落进"手写"并**原样保留**（悄悄换成默认值 = 篡改用户输入）；
 * 2. 切模式时时刻该跟过去，但多选字段（星期几 / 每月几号）不该凭空继承；
 * 3. 写不出表达式时（`toCron` 返回 null）界面必须**拒绝完成**，而不是写一个空串。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatTime,
  patternFromSpec,
  specFromPattern,
  stepValue,
  switchMode,
  toggleValue,
  WEEKDAY_ORDER,
} from '../src/features/schedule/cronPicker.ts';

test('从表达式进选择器：认得出来就用那个模式', () => {
  assert.deepEqual(specFromPattern('0 9 * * *'), { mode: 'daily', hour: 9, minute: 0 });
  assert.deepEqual(specFromPattern('0 9 * * 1'), {
    mode: 'weekly',
    hour: 9,
    minute: 0,
    weekdays: [1],
  });
});

test('认不出来的表达式原样落进"手写"，不被替换', () => {
  assert.deepEqual(specFromPattern('1-5/2 * * * *'), {
    mode: 'advanced',
    expression: '1-5/2 * * * *',
  });
  assert.deepEqual(specFromPattern('  乱写  '), { mode: 'advanced', expression: '  乱写  ' });
  assert.deepEqual(specFromPattern(''), { mode: 'advanced', expression: '' });
});

test('切模式保留时刻（用户改的是频率，不是时间）', () => {
  const daily = { mode: 'daily', hour: 22, minute: 30 };
  assert.deepEqual(switchMode(daily, 'weekly'), {
    mode: 'weekly',
    hour: 22,
    minute: 30,
    weekdays: [1],
  });
  assert.deepEqual(switchMode(daily, 'monthly'), {
    mode: 'monthly',
    hour: 22,
    minute: 30,
    days: [1],
  });
});

test('多选字段不继承：给一个明确的默认（周一 / 每月 1 号）', () => {
  const weekly = { mode: 'weekly', hour: 9, minute: 0, weekdays: [3, 5] };
  assert.deepEqual(switchMode(weekly, 'monthly').days, [1]);
});

test('点已经选中的模式：什么都不改（不重置用户选好的星期）', () => {
  const weekly = { mode: 'weekly', hour: 9, minute: 0, weekdays: [3, 5] };
  assert.deepEqual(switchMode(weekly, 'weekly'), weekly);
});

test('没有时刻的模式（每 N 分钟）切过去用 09:00 这个默认', () => {
  assert.deepEqual(switchMode({ mode: 'minutes', step: 15 }, 'daily'), {
    mode: 'daily',
    hour: 9,
    minute: 0,
  });
});

test('从有时刻的模式切到"每小时"：分钟跟过去，小时丢掉（它不该有）', () => {
  assert.deepEqual(switchMode({ mode: 'daily', hour: 22, minute: 30 }, 'hourly'), {
    mode: 'hourly',
    minute: 30,
  });
});

test('切到"手写"时先把当前设置写成表达式（用户接着改，而不是从空白开始）', () => {
  assert.deepEqual(switchMode({ mode: 'daily', hour: 9, minute: 0 }, 'advanced'), {
    mode: 'advanced',
    expression: '0 9 * * *',
  });
});

test('写回：合法状态给表达式，非法状态给 null（界面据此拒绝完成）', () => {
  assert.equal(
    patternFromSpec({ mode: 'weekly', hour: 9, minute: 0, weekdays: [1, 3] }),
    '0 9 * * 1,3',
  );
  assert.equal(patternFromSpec({ mode: 'advanced', expression: '1-5/2 * * * *' }), '1-5/2 * * * *');
  assert.equal(patternFromSpec({ mode: 'minutes', step: 0 }), null);
  assert.equal(patternFromSpec({ mode: 'advanced', expression: '两段 而已' }), null);
});

test('时刻零填充（9:5 读起来像错的）', () => {
  assert.equal(formatTime(9, 5), '09:05');
  assert.equal(formatTime(0, 0), '00:00');
  assert.equal(formatTime(23, 59), '23:59');
});

test('步进环回：23 → 0，0 → 23', () => {
  assert.equal(stepValue(23, 1, 0, 23), 0);
  assert.equal(stepValue(0, -1, 0, 23), 23);
  assert.equal(stepValue(59, 1, 0, 59), 0);
});

test('多选：加/删，但不许删到空', () => {
  assert.deepEqual(toggleValue([1], 2), [1, 2]);
  assert.deepEqual(toggleValue([1, 2], 1), [2]);
  assert.deepEqual(toggleValue([3], 3), [3]);
});

test('星期显示顺序从周一开始（周日排最后）', () => {
  assert.deepEqual([...WEEKDAY_ORDER], [1, 2, 3, 4, 5, 6, 0]);
});
