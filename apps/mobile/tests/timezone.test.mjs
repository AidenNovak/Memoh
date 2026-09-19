/**
 * 时区（bot 的 `timezone` 字段）纯逻辑测试。
 *
 * 值得钉住的三件事：
 *
 * 1. **清单本身**：419 项、不重复、`UTC` 在最前、每一项在 Intl 里都认。
 *    这份清单是打包进来的（不靠运行时的 `Intl.supportedValuesOf`），所以"它是不是
 *    真的一份完整时区表"只能在这里查——查不出来，界面上就是"用户找不到自己的时区"。
 * 2. **空值的语义**：`undefined` / `null` / `''` 都是"继承部署默认"，而不是一个空字符串
 *    的时区。实测服务端清空之后**连 key 都不返回**（见 `timezones.ts` 文件头）。
 * 3. **搜索**：`new york` / `shanghai` / `asia/shanghai` 都得命中——用户打不出
 *    `America/New_York` 里的下划线。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEPLOYMENT_DEFAULT_TIMEZONE,
  INHERIT_TIMEZONE,
  TIMEZONES,
  effectiveTimezone,
  filterTimezones,
  isUsableTimezone,
  normalizeTimezone,
  timezoneCity,
  timezoneLine,
  timezoneSubtitle,
  timezoneValue,
} from '../src/features/bots/timezones.ts';

test('清单是一份可用的 IANA 全表（419 项、UTC 在最前、无重复）', () => {
  assert.equal(TIMEZONES.length, 419);
  assert.equal(TIMEZONES[0], 'UTC');
  assert.equal(new Set(TIMEZONES).size, TIMEZONES.length);
  // 每一个都得能在运行时的 Intl 里构造出来——不然选完保存/显示都会炸。
  const unusable = TIMEZONES.filter((zone) => !isUsableTimezone(zone));
  assert.deepEqual(unusable, []);
  // 桌面端的清单也认这几个（同一条"桌面能选、手机也能选"的规矩）。
  for (const zone of ['Asia/Shanghai', 'America/New_York', 'Europe/London', 'UTC']) {
    assert.ok(TIMEZONES.includes(zone), `${zone} 不在清单里`);
  }
});

test('"继承"的三种写法都收敛成空串', () => {
  assert.equal(normalizeTimezone(undefined), INHERIT_TIMEZONE);
  assert.equal(normalizeTimezone(null), INHERIT_TIMEZONE);
  assert.equal(normalizeTimezone(''), INHERIT_TIMEZONE);
  assert.equal(normalizeTimezone('  '), INHERIT_TIMEZONE);
  // 不认识的原始值**原样保留**（静默改写成"继承"才是真丢用户设置）。
  assert.equal(normalizeTimezone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(normalizeTimezone('Etc/GMT+8'), 'Etc/GMT+8');
});

test('生效时区：没设 / 非法都回落部署默认，并且说得出"是继承的"', () => {
  assert.deepEqual(effectiveTimezone(undefined), {
    zone: DEPLOYMENT_DEFAULT_TIMEZONE,
    inherited: true,
  });
  assert.deepEqual(effectiveTimezone(''), {
    zone: DEPLOYMENT_DEFAULT_TIMEZONE,
    inherited: true,
  });
  assert.deepEqual(effectiveTimezone('Not/AZone'), {
    zone: DEPLOYMENT_DEFAULT_TIMEZONE,
    inherited: true,
  });
  assert.deepEqual(effectiveTimezone('Asia/Shanghai'), {
    zone: 'Asia/Shanghai',
    inherited: false,
  });
});

test('时区那一行/那个值的文案 key 跟着"继承与否"走', () => {
  assert.deepEqual(timezoneLine('Asia/Shanghai'), {
    key: 'timezone.line.set',
    values: { timezone: 'Asia/Shanghai' },
  });
  assert.deepEqual(timezoneLine(undefined), {
    key: 'timezone.line.inherited',
    values: { timezone: DEPLOYMENT_DEFAULT_TIMEZONE },
  });
  assert.deepEqual(timezoneValue(''), {
    key: 'timezone.value.inherited',
    values: { timezone: DEPLOYMENT_DEFAULT_TIMEZONE },
  });
  assert.deepEqual(timezoneValue('Europe/Paris'), {
    key: 'timezone.value.set',
    values: { timezone: 'Europe/Paris' },
  });
});

test('搜索：地名、带下划线的全名、区域前缀、大小写都能命中', () => {
  assert.ok(filterTimezones('shanghai').includes('Asia/Shanghai'));
  assert.ok(filterTimezones('SHANGHAI').includes('Asia/Shanghai'));
  assert.ok(filterTimezones('new york').includes('America/New_York'));
  assert.ok(filterTimezones('new_york').includes('America/New_York'));
  assert.ok(filterTimezones('newyork').includes('America/New_York'));
  assert.ok(filterTimezones('asia/').includes('Asia/Shanghai'));
  assert.ok(filterTimezones('tokyo').includes('Asia/Tokyo'));
  // UTC 是最短的那个查询，也得能找回来（用户在"要写死一个时区"时会打这个）。
  assert.deepEqual(filterTimezones('utc'), ['UTC']);
  // 空查询 = 全表（不是空列表：打开就要能滚）。
  assert.equal(filterTimezones('').length, TIMEZONES.length);
  assert.equal(filterTimezones('   ').length, TIMEZONES.length);
  // 查不到就是空——界面据此说"没有匹配的时区"。
  assert.deepEqual(filterTimezones('zzzz-not-a-zone'), []);
});

test('副标题给的是偏移量；列表标题先给城市名', () => {
  // 用 NODE 的 Intl 断言形状（Hermes 上拿不到时返回空串，界面不显示副标题——
  // 那一档在这里断言不了，别假装断言了）。
  const offset = timezoneSubtitle('Asia/Shanghai');
  assert.ok(offset === '' || /UTC|GMT/.test(offset), `偏移量形状不对: ${offset}`);
  assert.equal(timezoneCity('America/New_York'), 'New York');
  assert.equal(timezoneCity('UTC'), 'UTC');
});
