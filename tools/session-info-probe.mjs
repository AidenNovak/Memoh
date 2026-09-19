#!/usr/bin/env node
/**
 * 会话信息（上下文用量 / cache）在**真实服务端**上的可用性验证。
 *
 * ## 为什么要有它
 *
 * 这个面板的价值全在"数字是真的"。而服务端给什么**取决于部署版本**——这台
 * （memohai/server 8/30 镜像）实测只给 `used_tokens`，没有 `context_window`。
 * 于是最容易犯的错是"照着上游类型写，界面上算出一个百分比"：那个分母是编的，
 * 而用户会拿它判断"还有多少余量"，进而决定要不要压缩/换会话。
 *
 * 所以这个探针断言两件事：
 *   1. 部署上确实能拿到 status（每条字段都按实测形状检查）；
 *   2. 生产逻辑在**没有窗口时不给百分比**（`contextPercent === null`）。
 *
 * 用法：node tools/session-info-probe.mjs [--session <id>]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';

import { MemohClient } from '../apps/mobile/src/api/client.ts';
import {
  formatPercent,
  formatTokenCount,
  sessionInfoView,
} from '../apps/mobile/src/features/session/sessionInfo.ts';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((line) => line.trim().split('='))
    .filter((pair) => pair.length === 2 && pair[0]),
);

const baseUrl = (env.MEMOH_DEV_BASE_URL ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
const args = process.argv.slice(2);
const sessionArg = args.indexOf('--session') >= 0 ? args[args.indexOf('--session') + 1] : undefined;

let passed = 0;
let failed = 0;
function check(condition, label, detail) {
  const suffix = detail === undefined ? '' : ` — ${detail}`;
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}${suffix}`);
  } else {
    failed += 1;
    console.error(`  ✖ ${label}${suffix}`);
  }
}

let token = null;
const client = new MemohClient({ baseUrl, getToken: () => token });
token = (await client.login('admin', env.MEMOH_ADMIN_PASSWORD)).access_token;

const bots = await client.listBots();
const bot = bots.items?.[0];
if (bot === undefined) {
  console.error('没有 bot');
  process.exit(1);
}

let sessionId = sessionArg;
if (sessionId === undefined) {
  const sessions = await client.listSessions(bot.id);
  // 挑一个**有消息**的会话：空会话的统计全是 0，验证不了什么。
  const candidates = (sessions.items ?? []).slice(0, 12);
  let best = null;
  for (const candidate of candidates) {
    try {
      const status = await client.getSessionStatus(bot.id, candidate.id);
      const count = status.message_count ?? 0;
      if (best === null || count > (best.count ?? 0)) best = { id: candidate.id, count, status };
    } catch {
      // 单个会话取不到就跳过。
    }
  }
  if (best === null) {
    console.error('没有会话能取到 status');
    process.exit(1);
  }
  sessionId = best.id;
  console.log(`选中会话 ${sessionId}（消息数 ${best.count}）\n`);
}

console.log(`会话信息 → ${baseUrl}\n`);

const status = await client.getSessionStatus(bot.id, sessionId);
console.log('服务端原始响应：');
console.log(`  ${JSON.stringify(status).slice(0, 300)}\n`);

check(typeof status.message_count === 'number', 'status 给了消息数', String(status.message_count));
check(
  typeof status.context_usage?.used_tokens === 'number',
  'status 给了已用 token',
  String(status.context_usage?.used_tokens),
);
check(status.cache_stats !== undefined, 'status 给了 cache 统计');

const view = sessionInfoView(status);
console.log('\n生产逻辑算出的显示值：');
console.log(`  已用 token：${formatTokenCount(view.usedTokens)}`);
console.log(
  `  上下文窗口：${view.contextWindow === null ? '(服务端未提供)' : formatTokenCount(view.contextWindow)}`,
);
console.log(
  `  上下文占比：${view.contextPercent === null ? '(不显示——没有分母)' : formatPercent(view.contextPercent)}`,
);
console.log(`  缓存命中率：${formatPercent(view.cacheHitRate)}`);
console.log(`  消息数：${formatTokenCount(view.messageCount)}`);

check(
  view.contextWindow !== null || view.contextPercent === null,
  '【核心】没有窗口时绝不给百分比（那个分母会是编的）',
);
check(
  view.contextWindow === null || view.contextPercent !== null,
  '给了窗口就一定给出百分比（不能白白浪费真实数据）',
);
check(view.usedTokens >= 0, '已用 token 非负');
check(
  view.cacheHitRate === null || (view.cacheHitRate >= 0 && view.cacheHitRate <= 100),
  '命中率在 0-100 之间（服务端给的是百分数，不是小数）',
  String(view.cacheHitRate),
);

// 空会话也要说得对：不该因为"全是 0"而崩或显示成"没有数据"。
const emptyView = sessionInfoView({});
check(emptyView.contextPercent === null, '空响应不崩、也不给百分比');
check(emptyView.usedTokens === 0, '空响应的用量按 0 显示');

console.log(`\n通过 ${passed}，失败 ${failed}。`);
process.exit(failed === 0 ? 0 : 1);
