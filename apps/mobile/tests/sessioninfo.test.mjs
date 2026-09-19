/**
 * 会话信息面板的显示规则测试。
 *
 * 最要紧的一条：**没有服务端给的窗口时不能算百分比**。算出来会是一个看起来精确、
 * 实际没有依据的数——而这台部署恰恰就是"没有窗口"的那种（实测 `GET …/status`
 * 只回 used_tokens，模型配置里也没有 context_window）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatPercent,
  formatTokenCount,
  sessionInfoView,
} from '../src/features/session/sessionInfo.ts';

test('这台部署的实际响应：只有 used_tokens 时不给百分比', () => {
  // 形状照抄 2026-09-14 对部署服务端的实测响应。
  const view = sessionInfoView({
    message_count: 2,
    context_usage: { used_tokens: 1798 },
    cache_stats: {
      cache_read_tokens: 1536,
      total_input_tokens: 1798,
      cache_hit_rate: 85.42825361512793,
    },
    skills: [],
  });
  assert.equal(view.usedTokens, 1798, '绝对值照实显示');
  assert.equal(view.contextWindow, null, '服务端没给窗口，就必须是 null');
  assert.equal(view.contextPercent, null, '没有分母不许算百分比——那是在编数');
  assert.equal(view.messageCount, 2);
  assert.equal(view.cacheReadTokens, 1536);
  assert.equal(view.totalInputTokens, 1798);
  assert.equal(Math.round(view.cacheHitRate), 85);
});

test('服务端给了窗口才算百分比', () => {
  const view = sessionInfoView({
    context_usage: { used_tokens: 50_000, context_window: 200_000 },
  });
  assert.equal(view.contextWindow, 200_000);
  assert.equal(view.contextPercent, 25);
});

test('budget_plan 的窗口优先于模型窗口（这一轮实际按多大跑的）', () => {
  const view = sessionInfoView({
    context_usage: {
      used_tokens: 10_000,
      context_window: 100_000,
      budget_plan: { window: 50_000, output_reserve: 8_000 },
    },
  });
  assert.equal(view.contextWindow, 50_000, '实际跑的那个窗口才是分母');
  assert.equal(view.contextPercent, 20);
});

test('窗口为 0 或负数等同于没给（0 是不能做分母的）', () => {
  assert.equal(
    sessionInfoView({ context_usage: { used_tokens: 10, context_window: 0 } }).contextWindow,
    null,
  );
  assert.equal(
    sessionInfoView({ context_usage: { used_tokens: 10, context_window: -5 } }).contextWindow,
    null,
  );
  assert.equal(
    sessionInfoView({ context_usage: { used_tokens: 10, context_window: Number.NaN } })
      .contextWindow,
    null,
  );
});

test('百分比封顶 100（用量超过窗口时不该显示 137%）', () => {
  const view = sessionInfoView({ context_usage: { used_tokens: 300, context_window: 200 } });
  assert.equal(view.contextPercent, 100);
});

test('压缩阈值只在服务端说启用时才算数', () => {
  const off = sessionInfoView({
    context_usage: { used_tokens: 10, compaction: { enabled: false, auto_tokens: 500 } },
  });
  assert.equal(off.autoCompactTokens, null, '没启用就不该拿那个数当阈值');

  const on = sessionInfoView({
    context_usage: { used_tokens: 10, compaction: { enabled: true, auto_tokens: 500 } },
  });
  assert.equal(on.autoCompactTokens, 500);
});

test('缺字段与空响应都不崩，且都当作"没有"', () => {
  const empty = sessionInfoView(null);
  assert.equal(empty.usedTokens, 0);
  assert.equal(empty.contextWindow, null);
  assert.equal(empty.contextPercent, null);
  assert.equal(empty.cacheHitRate, null);
  assert.equal(empty.messageCount, null);
  assert.equal(sessionInfoView({}).contextPercent, null);
});

test('命中率 0% 与"没给"是两件事', () => {
  // 0 是真实结论（一次都没命中），null 是"服务端没说"。显示上不能混。
  assert.equal(sessionInfoView({ cache_stats: { cache_hit_rate: 0 } }).cacheHitRate, 0);
  assert.equal(sessionInfoView({ cache_stats: {} }).cacheHitRate, null);
});

test('token 数与百分比的可读写法', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1798), '1.8K');
  assert.equal(formatTokenCount(1_250_000), '1.3M');
  assert.equal(formatTokenCount(null), '—');
  assert.equal(formatPercent(85.43), '85%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(null), '—');
});

// ---------------------------------------------------------------- 用过的技能
//
// 桌面端会话信息面板的最后一块（`session-info-panel.vue` 的 Skills 段）。服务端给的
// `skills` 是**字符串数组**（`HandlersSessionInfoResponse.skills?: Array<string>`），
// 这一份断言就是那个形状的护栏——之前客户端把它当成了 `{id,name}[]`。

test('用过的技能名照服务端给的原样列出（含顺序）', () => {
  const view = sessionInfoView({
    message_count: 3,
    skills: ['skill-creator', 'pdf', 'hooks-setup'],
  });
  assert.deepEqual(view.skills, ['skill-creator', 'pdf', 'hooks-setup']);
});

test('技能：空数组、缺字段、脏值都退化成"没用过"', () => {
  assert.deepEqual(sessionInfoView({ skills: [] }).skills, []);
  assert.deepEqual(sessionInfoView({}).skills, []);
  assert.deepEqual(sessionInfoView(null).skills, []);
  // 服务端不该发这些东西；发了也不能把它们画成一行行空名字。
  assert.deepEqual(sessionInfoView({ skills: ['', '  ', null, 42, {}, 'ok'] }).skills, ['ok']);
});

test('同一个技能被列了多次只显示一次（顺序取第一次出现的位置）', () => {
  const view = sessionInfoView({ skills: ['pdf', 'skill-creator', 'pdf'] });
  assert.deepEqual(view.skills, ['pdf', 'skill-creator']);
});
