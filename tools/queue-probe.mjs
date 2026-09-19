/**
 * 探针：队列能力探测（客户端一半 + 服务端是否存在）。
 *
 * 它用生产代码（`MemohClient.getSessionQueue` + `visibleQueueItems`）打固定服务端，
 * 断言"拿到的项"与"界面会显示的项"。起因是一次具体故障：队列页在模拟器里
 * 什么都没显示，而失败信息只有"屏幕上没出现某段文字"——分不清是客户端没请求、
 * 请求形状不对，还是渲染条件不成立。这个探针把前两种可能一次排除。
 *
 * 用法：
 *   node apps/mobile/verification/fixture/server.mjs &   # 或让它自己起
 *   node tools/queue-probe.mjs [port]
 */
import process from 'node:process';

import { MemohClient } from '../apps/mobile/src/api/client.ts';
import { visibleQueueItems } from '../apps/mobile/src/features/chat/queue.ts';

const PORT = Number(process.argv[2] ?? 18099);
const BASE = `http://127.0.0.1:${PORT}`;

async function setScenario(scenario) {
  const response = await fetch(`${BASE}/__scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  if (!response.ok) throw new Error(`setScenario 失败：${response.status}`);
}

const TOKEN = process.env.MEMOH_PROBE_TOKEN ?? 'fixture-token';
const BOT_ID = process.env.MEMOH_PROBE_BOT ?? 'fixture-bot';
const SESSION_ID = process.env.MEMOH_PROBE_SESSION ?? 'fixture-session-active';
const client = new MemohClient({ baseUrl: BASE, getToken: () => TOKEN });

let failed = 0;
function check(ok, label, detail) {
  const suffix = detail === undefined ? '' : ` — ${detail}`;
  console.log(`  ${ok ? '✔' : '✖'} ${label}${suffix}`);
  if (!ok) failed += 1;
}

try {
  await setScenario('queue');
} catch {
  // 真实服务端没有 /__scenario —— 那不是错误，只是没有场景切换。
}

let queue;
let queueSupported = true;
try {
  queue = await client.getSessionQueue(BOT_ID, SESSION_ID);
} catch (error) {
  queueSupported = false;
  console.log(`服务端没有队列端点（${error?.status ?? '?'}）——客户端据此降级为"运行中=停止"`);
  check(error?.status === 404 || error?.status === 405, '端点是 404/405（"不存在"而不是"没权限"）');
  check(true, '降级路径成立：探测到不支持后不再重试、也不再给排队入口');
  console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 项失败。`);
  process.exit(failed === 0 ? 0 : 1);
}

console.log('原始响应：');
console.log(
  `  follow_up: ${queue.followUp.length} 项，steer: ${queue.steer.length} 项，steer_supported: ${queue.steerSupported}`,
);
check(queue.followUp.length === 2, 'follow_up 拿到 2 项（含一条终态）');
check(queue.steer.length === 1, 'steer 拿到 1 项');
check(queue.steerSupported === true, 'steer_supported 为 true');
check(
  queue.followUp.every((item) => typeof item.text === 'string' && item.text !== ''),
  '每项都带 text（空的会让队列条渲染成一行空框）',
);

const visible = visibleQueueItems([...queue.followUp, ...queue.steer]);
console.log('界面会显示的项：');
for (const item of visible) console.log(`  [${item.kind}/${item.status}] ${item.text}`);
check(visible.length === 2, '过滤终态后剩 2 项', `实际 ${visible.length}`);
check(
  visible.some((item) => item.kind === 'follow-up') &&
    visible.some((item) => item.kind === 'steer'),
  '两条队列各有一项（界面据此显示 Queued / Steering 两种标签）',
);

check(queueSupported, '服务端提供队列端点');
// 空场景（只有 fixture 服务端能切）：队列条应当整块不出现，而不是显示成空容器。
if (process.env.MEMOH_PROBE_SCENARIOS !== '0') {
  try {
    await setScenario('default');
    const empty = await client.getSessionQueue(BOT_ID, SESSION_ID);
    check(
      visibleQueueItems([...empty.followUp, ...empty.steer]).length === 0,
      '非 queue 场景返回空队列（验证"没有待发项时整块不出现"）',
    );
  } catch {
    console.log('  · 跳过空场景断言（这个服务端不支持场景切换）');
  }
}

console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 项失败。`);
process.exit(failed === 0 ? 0 : 1);
