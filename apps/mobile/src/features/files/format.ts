/**
 * 列表里的那两行字：大小 / 时间 / 目录项数。
 *
 * 数字与单位不进 i18n（`218 B`、`4.2 KB` 在两门语言里一样），**但相对时间的用词进**
 * （"昨天" / "yesterday"）。所以这里的做法是：纯函数只算出一个 `{unit, count}`
 * 的结构，由界面上那层把它翻成文案。这样这一层可以被 `node --test` 直接跑，
 * 不需要在测试里塞一份 i18n 表。
 */

import type { WorkspaceEntry } from './entries.ts';

/** 与 `useT()` 一致的最小签名，避免这个模块 import i18n 运行时。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * 人类可读的大小（1024 进制，10 KB 以下保留一位小数）。
 *
 * 进制选 1024：iOS 的文件大小显示就是这一套，`196608` 应当显示成 `192 KB`
 * 而不是 `197 KB`——数字对不上时用户会以为列表在骗他。
 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return `0 ${UNITS[0]}`;
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  // 10 KB 以下带小数才有信息量（4.2 KB）；再往上小数只是噪声（192 KB 比 192.0 KB 好读）。
  const text = rounded < 10 && unit > 0 ? rounded.toFixed(1) : String(Math.round(rounded));
  return `${text} ${UNITS[unit]}`;
}

export type RelativeUnit = 'now' | 'minutes' | 'hours' | 'yesterday' | 'days' | 'unknown';

export interface RelativeTime {
  unit: RelativeUnit;
  count: number;
}

/**
 * 相对时间的分档。
 *
 * 分到 `hours` 就够，精确到分钟没有意义——列表是用来扫一眼的（首页的时间也是这个粒度）。
 * `24–48h` 单独一档写"昨天"：手机上"28 小时前"要心算，"昨天"不用。
 */
export function relativeTime(iso: string, now: number): RelativeTime {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return { unit: 'unknown', count: 0 };
  const seconds = Math.floor((now - then) / 1000);
  // 服务端时钟比手机快时会出现负数：当成"刚刚"，不要显示"-3 分钟前"。
  if (seconds < 60) return { unit: 'now', count: 0 };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  if (hours < 48) return { unit: 'yesterday', count: 1 };
  return { unit: 'days', count: Math.floor(hours / 24) };
}

const RELATIVE_KEYS: Record<RelativeUnit, string> = {
  now: 'files.time.now',
  minutes: 'files.time.minutes',
  hours: 'files.time.hours',
  yesterday: 'files.time.yesterday',
  days: 'files.time.days',
  unknown: 'files.time.unknown',
};

export function relativeText(time: RelativeTime, t: Translate): string {
  return t(RELATIVE_KEYS[time.unit], { count: time.count });
}

/**
 * 目录行的副标题：「目录 · 12 项」。
 *
 * 项数**只有进过这个目录才知道**——服务端不给目录的子项数，而递归预取会变成 N 次
 * 串行请求（规格 §6 明确不做）。所以拿不到就只写「目录」，不显示 0。
 */
export function directorySubtitle(count: number | null, t: Translate): string {
  if (count === null || count <= 0) return t('files.dir.subtitle.plain');
  return t('files.dir.subtitle', { count });
}

/** 文件行的副标题：「4.2 KB · 2 小时前」。时间拿不到就只给大小。 */
export function fileSubtitle(entry: WorkspaceEntry, t: Translate, now: number): string {
  const size = formatBytes(entry.size);
  const time = relativeTime(entry.modTime, now);
  if (time.unit === 'unknown') return size;
  return `${size} · ${relativeText(time, t)}`;
}
