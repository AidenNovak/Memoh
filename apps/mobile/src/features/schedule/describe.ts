/**
 * 定时任务的文字：下次执行、最近一次、上限。
 *
 * 这一层是纯函数（不碰 React），因为"下一次是明天 09:00"这种判断错了没人会发现——
 * 它必须能被 `node --test` 钉住。所有日期都按**任务所属 bot 的时区**算：服务端按那个
 * 时区执行，界面按本地时区显示的话，隔着时区看就会差几小时。
 */
import type { LastRunState } from './model.ts';

/** 取某个时刻在给定时区里的日历字段。`Intl` 是这里唯一的时区手段（不引库）。 */
export function partsInTz(date: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/**
 * 时区兜底。
 *
 * ⚠️ 兜底**不能**用本机时区：服务端在 bot 没有（或写了非法）`timezone` 时回落到
 * **部署默认**，而本部署的默认是 **UTC**（依据见 `docs/research/schedule-server-behaviour.md`）。
 * 用本机时区显示会让"下次执行"和服务端真正执行的时刻差几小时，而且看不出来。
 *
 * 已知局限：部署默认是可配的，客户端读不到它——换了部署我们可能仍然偏。所以这里
 * 取"这个部署的默认值"，并在解析失败时也走同一条路，不假装知道更多。
 */
export function safeTimezone(timezone: string | undefined): string {
  if (timezone === undefined || timezone === '') return DEPLOYMENT_DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return timezone;
  } catch {
    return DEPLOYMENT_DEFAULT_TIMEZONE;
  }
}

/** 本部署服务端的默认时区（bot 没设时用它）。 */
export const DEPLOYMENT_DEFAULT_TIMEZONE = 'UTC';

/** 两个时刻在给定时区里相差几个"天"（只看日历日，不看小时）。 */
export function dayDelta(target: Date, now: Date, timezone: string): number {
  const a = partsInTz(target, timezone);
  const b = partsInTz(now, timezone);
  const toKey = (p: Record<string, string>) =>
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  return Math.round((toKey(a) - toKey(b)) / 86_400_000);
}

export type NextRunLabel =
  | { kind: 'at'; day: 'today' | 'tomorrow' | 'dayAfter' | 'date'; time: string; date: string }
  | { kind: 'unknown' };

/**
 * 下次执行的可读文案。
 *
 * 算不出来时返回 `unknown`——界面据此显示"这个表达式我们算不出来"，而**不是**显示一个
 * 猜的时间。一个错的"下次 09:00"比不显示更糟：它会让人以为任务坏了。
 */
export function nextRunLabel(next: Date | null, now: Date, timezone: string): NextRunLabel {
  if (next === null || Number.isNaN(next.getTime())) return { kind: 'unknown' };
  const parts = partsInTz(next, timezone);
  const time = `${parts.hour}:${parts.minute}`;
  const date = `${parts.month}-${parts.day}`;
  const delta = dayDelta(next, now, timezone);
  if (delta <= 0) return { kind: 'at', day: 'today', time, date };
  if (delta === 1) return { kind: 'at', day: 'tomorrow', time, date };
  if (delta === 2) return { kind: 'at', day: 'dayAfter', time, date };
  return { kind: 'at', day: 'date', time, date };
}

/** 最近一次的状态 → 屏幕上的词。`unknown` 不假装成功。 */
export function lastRunLabelKey(state: LastRunState | null): string | null {
  switch (state) {
    case 'ok':
      return 'schedule.last.ok';
    case 'failed':
      return 'schedule.last.failed';
    case 'running':
      return 'schedule.last.running';
    case 'unknown':
      return 'schedule.last.unknown';
    default:
      return null;
  }
}

/** "最多执行次数"的显示值：`null` 是"不限"，不是 0。 */
export function maxCallsLabelKey(maxCalls: number | null): string {
  return maxCalls === null ? 'schedule.maxCalls.unlimited' : 'schedule.maxCalls.value';
}

/**
 * 用户输入的"最多执行次数" → 值。
 *
 * 空字符串 = **不限**（用户把数字删掉就是取消上限），不是 0。0 是合法输入吗？
 * 服务端把它当作"一次都不跑"，那更像误操作，所以 0 直接不接受。
 */
export function parseMaxCalls(input: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (value <= 0) return { ok: false };
  return { ok: true, value };
}
