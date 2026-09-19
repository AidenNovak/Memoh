/**
 * 「机器」浮窗的纯逻辑（`src/features/machine/panel.ts`）。
 *
 * 每一条都对应一个"错了会误导人"的分岔：
 * - 容器在跑 ≠ 这一轮任务在跑；
 * - "桌面不可用"有四种完全不同的原因（没开 / 没装 / 没在推 / 读不到）；
 * - **读不到不是 0**（0% CPU 是一条结论，"读不到"是另一条）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  desktopVerdict,
  formatBytes,
  formatPercent,
  machineRows,
  metricsRows,
  usageWithLimit,
} from '../src/features/machine/panel.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'locales');

test('字节说成人话；读不到返回空串（不是 0 B）', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(undefined), '');
  assert.equal(formatBytes(512 * 1024 * 1024), '512 MB');
  assert.equal(formatBytes(3.5 * 1024 ** 3), '3.5 GB');
});

test('百分比：读不到返回空串', () => {
  assert.equal(formatPercent(0.23), '0.2%');
  assert.equal(formatPercent(undefined), '');
});

test('用量 / 上限：缺哪边就只给哪边', () => {
  assert.equal(usageWithLimit(1024, undefined), '1 KB');
  assert.equal(usageWithLimit(undefined, 2048), '/ 2 KB');
  assert.equal(usageWithLimit(undefined, undefined), '');
});

test('机器行：容器在跑但任务闲着，是两条不同的信息', () => {
  const rows = machineRows({ status: 'running', task_running: false, image: 'img:1' });
  assert.equal(
    rows.find((row) => row.label === 'machine.row.status').value,
    'machine.row.status.running',
  );
  assert.equal(rows.find((row) => row.label === 'machine.row.task').value, 'machine.row.task.idle');
});

test('机器行：还没拉到 → 空（界面显示加载中，不显示"已停止"这种默认结论）', () => {
  assert.deepEqual(machineRows(null), []);
});

test('机器行的值必须是文案 key：协议里的原值一个都不许上屏', () => {
  const catalogs = ['en.json', 'zh-Hans.json'].map((name) =>
    JSON.parse(readFileSync(join(LOCALES, name), 'utf8')),
  );
  const rows = machineRows({ status: 'running', task_running: false, image: 'img:1' });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    // 服务端给的原文（镜像名、命名空间）按原样显示：那是标识，不是词。
    if (row.valueKind === 'text') continue;
    for (const [index, catalog] of catalogs.entries()) {
      assert.ok(row.value in catalog, `${row.label} 的值 "${row.value}" 不在 ${index} 号表里`);
    }
  }
  // 少一道映射就是中文界面上出现「任务 | running」——这一条就是那个复发点。
  for (const row of rows) {
    assert.ok(
      !['running', 'stopped', 'idle'].includes(row.value),
      `${row.label} 把服务端原值 "${row.value}" 直接上屏了`,
    );
  }
  // 服务端给了我们不认识的状态：说"未知"，不把原值透出去。
  const unknown = machineRows({ status: 'dead' });
  assert.equal(unknown.find((row) => row.label === 'machine.row.status').value, 'common.unknown');
});

test('桌面四态：没开 / 没装 / 在推 / 没在推 是不同的结论', () => {
  assert.equal(desktopVerdict({ enabled: false }).verdict, 'not-enabled');
  assert.equal(
    desktopVerdict({ enabled: true, desktop_available: false }).verdict,
    'not-installed',
  );
  assert.equal(
    desktopVerdict({ enabled: true, available: true, running: true }).verdict,
    'available',
  );
  assert.equal(desktopVerdict({ enabled: true, available: true, running: false }).verdict, 'idle');
  assert.equal(desktopVerdict(null).verdict, 'unknown');
});

test('"没开桌面"要先于"没在推"被判定（否则会把没开说成停了）', () => {
  assert.equal(desktopVerdict({ enabled: false, running: false }).verdict, 'not-enabled');
});

test('后端说 supported:false 时不编数字', () => {
  assert.deepEqual(metricsRows({ supported: false, metrics: { cpu: { usage_percent: 1 } } }), []);
});

test('用量行只显示拿得到的那些', () => {
  const rows = metricsRows({
    supported: true,
    metrics: { cpu: { usage_percent: 12.5 }, memory: { usage_bytes: 1024 } },
  });
  assert.deepEqual(
    rows.map((row) => row.label),
    ['machine.row.cpu', 'machine.row.memory'],
  );
});
