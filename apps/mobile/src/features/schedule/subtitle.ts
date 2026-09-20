/**
 * 列表副标题：它要回答"下次什么时候跑 / 上一次怎么样"。
 *
 * 单独一层是为了让 `model.ts` 保持**纯形状**（归一化 + 拼请求体）——那两个函数要能被
 * 直接拿去对着真服务端跑往返验证，不该被 cron 计算牵连进来。
 */
import { lastRunState, type LastRunState, type Schedule, type ScheduleLog } from './model.ts';
import { nextRunAt } from './cron.ts';

/**
 * 列表副标题：它要回答"下次什么时候跑 / 上一次怎么样"。
 *
 * 返回的是**语义片段**而不是拼好的字符串，因为两个片段各自可能要省略
 * （算不出下次执行时第一段就没有），拼接与本地化交给界面。
 */
export function scheduleSubtitleParts(
  schedule: Schedule,
  last: ScheduleLog | undefined,
  timezone: string,
  now: Date,
): { next: string | null; nextAt: Date | null; last: LastRunState | null } {
  const runAt = schedule.enabled ? nextRunAt(schedule.pattern, timezone, now) : null;
  return {
    nextAt: runAt,
    next: runAt === null ? null : runAt.toISOString(),
    last: last === undefined ? null : lastRunState(last.status, last.completedAt),
  };
}
