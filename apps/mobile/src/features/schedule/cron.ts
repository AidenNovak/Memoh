/**
 * 定时任务的 cron：可视化 ⇄ 表达式双向转换，以及「下次执行」。
 *
 * ## 为什么这个模块到处都是 `null`
 *
 * 上游（Web 端）用 `cron-parser` 算下次执行、用 `cronstrue` 生成描述，iOS 侧这两个依赖
 * 都没有、也不打算加。而这两件事**都是会显示给用户看的**：列表上写着「下次 09:00」，
 * 用户就照着这个时间等。算错比不显示更糟——不显示用户会自己看 cron 表达式，算错用户会
 * 以为任务没跑。所以这个模块的规则是：
 *
 *   - 能**无损**理解才返回结果（`fromCron` 认不出来就 `null`，调用方保持「手写 cron」状态）；
 *   - `nextRunAt` 只支持我们自己的选择器会生成的形态 + 常见等价手写，超出能力就 `null`，
 *     绝不猜（例如运行时区的「日 OR 星期」语义，见下）；
 *   - `toCron` 拿到的 spec 自相矛盾（2 月 31 日、小时 25）也返回 `null`，宁可不给表达式。
 *
 * 这跟 `src/features/files/paths.ts` 里「越界就是失败，不顺手修正」是同一个取舍：模块
 * 给不出正确结果时返回 `null`，把决定权留给界面。
 *
 * ## 时区
 *
 * 不引库。用 `Intl.DateTimeFormat` + `formatToParts` 读「某个时区里的墙上时间」，
 * 反解时做两次偏移迭代（先当成 UTC 猜一个时刻，取该时刻的时区偏移再修正一次），
 * 最后**回读校验**墙上时间是否真的是目标值。校验不通过说明这个本地时间在当天不存在
 * （春季 DST 前跳），此时跳过这一次而不是硬凑一个时刻——硬凑出来的时刻它的本地时间
 * 不是用户写的那个，等于骗人。
 *
 * 纯函数，不 import react / react-native；`tests/cron.test.mjs` 用 `node --test` 直接跑。
 */

/** 频率模式，与上游 Web 端的 7 种一致。 */
export type CronMode =
  'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'advanced';

/** 每 N 分钟（`*\/N * * * *`，N ∈ 1..59）。 */
export interface MinutesSpec {
  mode: 'minutes';
  step: number;
}

/** 每小时的第 M 分钟（`M * * * *`）。 */
export interface HourlySpec {
  mode: 'hourly';
  minute: number;
}

/** 每天 H:M（`M H * * *`）。 */
export interface DailySpec {
  mode: 'daily';
  hour: number;
  minute: number;
}

/** 每周的某几天 H:M（`M H * * 天`）。星期多选，0 = 周日、6 = 周六。 */
export interface WeeklySpec {
  mode: 'weekly';
  hour: number;
  minute: number;
  weekdays: number[];
}

/** 每月的某几号 H:M（`M H 号 * *`）。号多选，1..31。 */
export interface MonthlySpec {
  mode: 'monthly';
  hour: number;
  minute: number;
  days: number[];
}

/** 每年某月某日 H:M（`M H 日 月 *`）。上游约束：单一小时、单一日、单一月。 */
export interface YearlySpec {
  mode: 'yearly';
  hour: number;
  minute: number;
  day: number;
  month: number;
}

/** 手写表达式：原样保留，我们只做「是 5 段」这一层校验。 */
export interface AdvancedSpec {
  mode: 'advanced';
  expression: string;
}

export type CronSpec =
  MinutesSpec | HourlySpec | DailySpec | WeeklySpec | MonthlySpec | YearlySpec | AdvancedSpec;

// ---------------------------------------------------------------- 字段解析

/** 解析出来的 5 段字段。`dayOfMonth` / `month` / `dayOfWeek` 为 `null` 表示该段是 `*`。 */
interface CronFields {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number> | null;
  month: ReadonlySet<number> | null;
  dayOfWeek: ReadonlySet<number> | null;
}

const MINUTE_MIN = 0;
const MINUTE_MAX = 59;
const HOUR_MIN = 0;
const HOUR_MAX = 23;
const DAY_MIN = 1;
const DAY_MAX = 31;
const MONTH_MIN = 1;
const MONTH_MAX = 12;
/** 星期允许 0..7：cron 里 0 和 7 都是周日。 */
const WEEKDAY_MAX = 7;

/** 一个字段的取值区间。 */
interface FieldRange {
  min: number;
  max: number;
}

/**
 * 解析单个字段为去重后的取值集合。
 *
 * 只认这些写法：`*`、`*\/N`、`a`、`a-b`、`a-b/N`，以及它们用 `,` 拼起来的列表。
 * **不认** `MON` / `JAN` 这类名字（要一张名字表，而且各实现的大小写/缩写不一）、
 * 不认 `5/2`（非标准，含义是实现相关的）、不认 `?` / `L` / `W` / `#`（Quartz 扩展，
 * Vixie cron 里没有）。认不出来返回 `null`，让调用方去显示「手写确认」。
 */
function parseField(part: string, range: FieldRange, collapseSunday = false): Set<number> | null {
  const values = new Set<number>();
  for (const raw of part.split(',')) {
    const element = raw.trim();
    if (!parseElement(element, range, values, collapseSunday)) return null;
  }
  return values.size > 0 ? values : null;
}

function parseElement(
  element: string,
  range: FieldRange,
  out: Set<number>,
  collapseSunday: boolean,
): boolean {
  const stepSplit = element.split('/');
  if (stepSplit.length > 2) return false;
  const base = stepSplit[0] ?? '';
  let step = 1;
  if (stepSplit.length === 2) {
    const parsedStep = parseInteger(stepSplit[1] ?? '');
    // 步长必须 ≥ 1：`*/0` 是没有意义的，`*/`（空步长）也是。
    if (parsedStep === null || parsedStep < 1) return false;
    step = parsedStep;
  }

  if (base === '*') {
    for (let value = range.min; value <= range.max; value += step)
      addValue(out, value, collapseSunday);
    return true;
  }

  const dash = base.indexOf('-');
  if (dash > 0) {
    const from = parseInteger(base.slice(0, dash));
    const to = parseInteger(base.slice(dash + 1));
    // 这里必须显式查 null：`NaN < x` 是 false，漏掉判断就会让 `5-a` 这种
    // 乱写的范围"通过"校验（只是往里塞不进任何值），然后整条表达式被静默截断。
    if (from === null || to === null) return false;
    if (from < range.min || to > range.max || from > to) return false;
    for (let value = from; value <= to; value += step) addValue(out, value, collapseSunday);
    return true;
  }

  // 单值不允许带步长：`5/2` 在 Vixie cron 里不是「从 5 开始每 2」，别替它解释。
  if (stepSplit.length === 2) return false;
  const single = parseInteger(base);
  if (single === null || single < range.min || single > range.max) return false;
  addValue(out, single, collapseSunday);
  return true;
}

function addValue(out: Set<number>, value: number, collapseSunday: boolean): void {
  out.add(collapseSunday && value === 7 ? 0 : value);
}

/** 只接受纯十进制（不认 `+5` / `0x5` / 空串 / `5.0`），不是数字返回 `null`。 */
function parseInteger(text: string): number | null {
  if (!/^\d{1,2}$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** 解析整条表达式；`null` 表示我们不认识它。 */
function parseCron(expression: string): CronFields | null {
  if (typeof expression !== 'string') return null;
  const parts = expression.trim().split(/\s+/);
  // 5 段是 Vixie cron 的形态。6 段（多一个秒）和 1 段（`@daily`）都是别的方言，
  // 我们一律不认——猜错了会把「每天」当成「每分钟」。
  if (parts.length !== 5) return null;
  const [minuteText = '', hourText = '', dayText = '', monthText = '', weekText = ''] = parts;

  const minute = parseField(minuteText, { min: MINUTE_MIN, max: MINUTE_MAX });
  const hour = parseField(hourText, { min: HOUR_MIN, max: HOUR_MAX });
  const dayOfMonth = dayText === '*' ? null : parseField(dayText, { min: DAY_MIN, max: DAY_MAX });
  const month =
    monthText === '*' ? null : parseField(monthText, { min: MONTH_MIN, max: MONTH_MAX });
  const dayOfWeek =
    weekText === '*' ? null : parseField(weekText, { min: 0, max: WEEKDAY_MAX }, true);

  if (!minute || !hour) return null;
  if (dayText !== '*' && !dayOfMonth) return null;
  if (monthText !== '*' && !month) return null;
  if (weekText !== '*' && !dayOfWeek) return null;

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** 两个字段集是否等价（用于「无损」判断：集合相同就是同一个含义）。 */
function sameValues(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function sameFields(a: CronFields, b: CronFields): boolean {
  const optional = (x: ReadonlySet<number> | null, y: ReadonlySet<number> | null): boolean => {
    if (x === null || y === null) return x === y;
    return sameValues(x, y);
  };
  return (
    sameValues(a.minute, b.minute) &&
    sameValues(a.hour, b.hour) &&
    optional(a.dayOfMonth, b.dayOfMonth) &&
    optional(a.month, b.month) &&
    optional(a.dayOfWeek, b.dayOfWeek)
  );
}

function ascending(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** 集合里的唯一取值；不是恰好一个就返回 `null`。 */
function singleValue(values: ReadonlySet<number>): number | null {
  if (values.size !== 1) return null;
  const list = ascending(values);
  return list[0] ?? null;
}

/**
 * 集合是否「从最小值开始、等步长、一直到上限」——也就是 `*\/N` 生成的形态。
 *
 * 不记录表达式原文，直接从集合反推：`{0,15,30,45}` 只能来自 `*\/15`（在 0..59 里
 * 从 0 起步长 15 恰好停在 45），所以反推是唯一的。反推对了再由 `fromCron` 做
 * 一次「重新生成再比对」，写错了也出不了错。
 */
function stepFromZero(values: ReadonlySet<number>, min: number, max: number): number | null {
  const list = ascending(values);
  if (list.length < 2) return null;
  if (list[0] !== min) return null;
  const step = (list[1] ?? 0) - (list[0] ?? 0);
  if (step < 1) return null;
  for (let i = 1; i < list.length; i += 1) {
    if ((list[i] ?? 0) - (list[i - 1] ?? 0) !== step) return null;
  }
  const last = list[list.length - 1] ?? 0;
  // 再多一个刻度就超上限，才说明集合是完整的一串（不是 `0,15,30` 这种被截断的）。
  return last + step > max ? step : null;
}

function isFullRange(values: ReadonlySet<number>, min: number, max: number): boolean {
  return values.size === max - min + 1;
}

/** 某年某月的天数（闰年由 2 月天数体现）。 */
function daysInMonth(year: number, month: number): number {
  // 用 UTC 的「下个月 0 日」拿到当月天数，不手写闰年判断。
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 校验用的闰年：2 月 29 日只在闰年存在，判定「这个日期在日历上存在吗」时用它。 */
const LEAP_YEAR = 2024;

// ---------------------------------------------------------------- 可视化 → cron

/**
 * 把选择器的 spec 写成规范的 5 段表达式；spec 自相矛盾时返回 `null`。
 *
 * 返回 `null` 而不是抛异常：spec 只会来自我们的选择器（值域由 UI 保证），真出现越界值
 * 说明有 bug，此时宁可不给表达式，也不要写一个看着像样、跑起来不对的 cron。
 */
export function toCron(spec: CronSpec): string | null {
  switch (spec.mode) {
    case 'minutes': {
      if (!Number.isInteger(spec.step) || spec.step < 1 || spec.step > MINUTE_MAX) return null;
      return `*/${spec.step} * * * *`;
    }
    case 'hourly': {
      const minute = validMinute(spec.minute);
      if (minute === null) return null;
      return `${minute} * * * *`;
    }
    case 'daily': {
      const hour = validHour(spec.hour);
      const minute = validMinute(spec.minute);
      if (hour === null || minute === null) return null;
      return `${minute} ${hour} * * *`;
    }
    case 'weekly': {
      const hour = validHour(spec.hour);
      const minute = validMinute(spec.minute);
      const weekdays = validValues(spec.weekdays, 0, 6);
      if (hour === null || minute === null || weekdays === null) return null;
      return `${minute} ${hour} * * ${weekdays.join(',')}`;
    }
    case 'monthly': {
      const hour = validHour(spec.hour);
      const minute = validMinute(spec.minute);
      const days = validValues(spec.days, DAY_MIN, DAY_MAX);
      if (hour === null || minute === null || days === null) return null;
      return `${minute} ${hour} ${days.join(',')} * *`;
    }
    case 'yearly': {
      const hour = validHour(spec.hour);
      const minute = validMinute(spec.minute);
      if (hour === null || minute === null) return null;
      if (!Number.isInteger(spec.month) || spec.month < MONTH_MIN || spec.month > MONTH_MAX)
        return null;
      if (!Number.isInteger(spec.day) || spec.day < DAY_MIN || spec.day > DAY_MAX) return null;
      // 2 月 31 日这种日期在日历上不存在：写成表达式就等于一个永不执行的任务，
      // 而且 `fromCron` 也会拒它——那样双向转换就不再是同一个集合了，所以在源头就拒。
      if (spec.day > daysInMonth(LEAP_YEAR, spec.month)) return null;
      return `${minute} ${hour} ${spec.day} ${spec.month} *`;
    }
    case 'advanced': {
      // 手写模式：只确认它还是 5 段，不做别的加工（我们自己加工过的表达式，
      // 用户再切回手写时会看到不一样的字符串，那才叫奇怪）。
      if (typeof spec.expression !== 'string') return null;
      const parts = spec.expression.trim().split(/\s+/);
      return parts.length === 5 ? parts.join(' ') : null;
    }
    default:
      return null;
  }
}

function validMinute(value: number): number | null {
  return Number.isInteger(value) && value >= MINUTE_MIN && value <= MINUTE_MAX ? value : null;
}

function validHour(value: number): number | null {
  return Number.isInteger(value) && value >= HOUR_MIN && value <= HOUR_MAX ? value : null;
}

/** 去重、升序、做值域检查；空数组返回 `null`（「一周的哪几天」不能是空集）。 */
function validValues(values: readonly number[], min: number, max: number): number[] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const unique = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value < min || value > max) return null;
    unique.add(value);
  }
  return ascending(unique);
}

// ---------------------------------------------------------------- cron → 可视化

/**
 * 把表达式还原成 spec；**只在无损（含义完全一致）时**返回，否则 `null`。
 *
 * 这里刻意不推断 `advanced`：调用方用 `null` 表示「保持手写 cron 状态」，
 * 如果我们把 `0 9-17 * * *` 这种能读但没法用选择器表达的表达式也包成 `advanced` 返回，
 * 界面就会切进一个「高级模式」，而用户看到的其实是同一串文字——不如老老实实返回 `null`。
 */
export function fromCron(expression: string): CronSpec | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  const spec = specFromFields(fields);
  if (!spec) return null;

  // 无损校验：把 spec 写回去再解析一次，字段集合必须和输入一模一样。
  // 这一层是保险丝——`specFromFields` 或 `toCron` 哪天写错了，结果是「认不出来」，
  // 而不是「认成了一个不一样的表达式」。
  const canonical = toCron(spec);
  if (canonical === null) return null;
  const roundTrip = parseCron(canonical);
  if (!roundTrip || !sameFields(fields, roundTrip)) return null;
  return spec;
}

function specFromFields(fields: CronFields): CronSpec | null {
  const minute = singleValue(fields.minute);
  const hour = singleValue(fields.hour);
  const hourIsEvery = isFullRange(fields.hour, HOUR_MIN, HOUR_MAX);

  // 日 + 星期同时被限定：Vixie cron 的语义是 **OR**（「每月 1 号 *或* 每个周一」）。
  // 这是个连老手都会看错的坑，选择器里没有对应模式，所以不表示它，返回 null。
  if (fields.dayOfMonth && fields.dayOfWeek) return null;

  if (!fields.dayOfMonth && !fields.dayOfWeek) {
    if (fields.month) return null;
    // `*\/N`：分钟从 0 起等步长。
    if (hourIsEvery) {
      const step = stepFromZero(fields.minute, MINUTE_MIN, MINUTE_MAX);
      if (step !== null) return { mode: 'minutes', step };
    }
    if (hourIsEvery && minute !== null) return { mode: 'hourly', minute };
    if (hour !== null && minute !== null) return { mode: 'daily', hour, minute };
    // 走到这里就是「分钟/小时是多选但又不是 `*\/N`」，例如 `0,30 9 * * *`。
    // 选择器没有「一小时里的第 0 和第 30 分钟」这一档，不猜。
    return null;
  }

  // 上游约束：weekly / monthly / yearly 只支持单个小时值（<input type="time"> 决定的），
  // 多值小时没有对应控件。
  if (hour === null || minute === null) return null;

  if (fields.dayOfWeek) {
    if (fields.month) return null;
    const weekdays = ascending(fields.dayOfWeek);
    if (weekdays.length === 0) return null;
    return { mode: 'weekly', hour, minute, weekdays };
  }

  const days = ascending(fields.dayOfMonth ?? new Set<number>());
  if (days.length === 0) return null;

  if (!fields.month) return { mode: 'monthly', hour, minute, days };

  // 月也被限定 → 只能是 yearly，且日、月都必须是单值（「每年 1 号和 15 号」没有控件）。
  const months = ascending(fields.month);
  const day = days.length === 1 ? (days[0] ?? 0) : null;
  const month = months.length === 1 ? (months[0] ?? 0) : null;
  if (day === null || month === null) return null;
  // `0 0 31 2 *`：语法合法、日历上不存在 → 认不出来（界面上会提示手写确认）。
  if (day > daysInMonth(LEAP_YEAR, month)) return null;
  return { mode: 'yearly', hour, minute, day, month };
}

// ---------------------------------------------------------------- 时区

/** `Intl.DateTimeFormat` 的例子有成本，按时区缓存。 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** 系统时区；拿不到就按 UTC（至少是个确定的答案，不会把本地时间当 UTC 用）。 */
export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
}

/**
 * 把服务端给的时区名收敛成一个 `Intl` 认识的时区。
 *
 * 服务端的时区字段可能是空的、可能是 `Local`、也可能是它自己都不认识的字符串，
 * 这些都退回**系统时区**：任务列表是「这台手机上看起来几点跑」，本地时间不对至少是
 * 用户能理解的错；抛异常或者按 UTC 显示才是真的无法解释。
 */
export function resolveTimeZone(input: string | null | undefined): string {
  const candidate = typeof input === 'string' ? input.trim() : '';
  if (candidate === '') return systemTimeZone();
  try {
    // 构造是唯一可靠的校验方式：`Intl.supportedValuesOf('timeZone')` 会漏掉别名。
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return systemTimeZone();
  }
}

/** 某个时区里的一天（不含时刻）。 */
interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface WallClock extends CalendarDate {
  hour: number;
  minute: number;
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(zone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    // 固定 h23：默认的 `hour12: false` 在有些 ICU 里会把午夜格式化成 24 点。
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  zoneFormatters.set(zone, formatter);
  return formatter;
}

/** 读某个时刻在 `zone` 里的墙上时间。 */
function wallClockAt(timestamp: number, zone: string): WallClock {
  const parts = formatterFor(zone).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const text = parts.find((part) => part.type === type)?.value ?? '';
    return Number.parseInt(text, 10);
  };
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // 兜底：万一某个 ICU 版本忽略了 hourCycle，午夜会读成 24。
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
  };
}

/** 墙上时间按 UTC 解释时的毫秒数（用来求时区偏移，不做真实时刻）。 */
function wallClockAsUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
}

/** `zone` 在某个真实时刻的偏移（东为正）。 */
function zoneOffsetMs(timestamp: number, zone: string): number {
  return wallClockAsUtcMs(wallClockAt(timestamp, zone)) - timestamp;
}

/**
 * 墙上时间 → 真实时刻。
 *
 * 用两次迭代：先把墙上时间当 UTC 猜一个时刻，用它的偏移修正；偏移在修正后变了（跨了
 * 转换点）就再修一次。最后**回读校验**：解出来的时刻在那个时区里的墙上时间必须与目标
 * 完全一致，不一致说明这个本地时间当天不存在（春季前跳，例如 America/New_York 的
 * 03-08 02:30），返回 `null` 让调用方跳过这一次。
 *
 * 秋季回拨那种「同一个本地时间出现两次」的情况，两次迭代会落在**第一次**上
 * （先得到的那个时刻偏移正确、回读也通过）。真 cron 在回拨当天也只跑一次，
 * 所以这里不额外区分——但要注意它的**后果**：`0 1 * * *` 在 America/New_York 的
 * 2026-11-01，如果 `from` 已经过了第一次 01:00（EDT，05:00Z），答案是**次日**的 01:00，
 * 而不是 06:00Z 那个"第二次 01:00"。这条已经和 Python `zoneinfo` 的独立实现对照过。
 */
function instantFromWallClock(wall: WallClock, zone: string): Date | null {
  const guessedAsUtc = wallClockAsUtcMs(wall);
  const firstOffset = zoneOffsetMs(guessedAsUtc, zone);
  let timestamp = guessedAsUtc - firstOffset;
  const secondOffset = zoneOffsetMs(timestamp, zone);
  if (secondOffset !== firstOffset) timestamp = guessedAsUtc - secondOffset;

  const readBack = wallClockAt(timestamp, zone);
  if (
    readBack.year !== wall.year ||
    readBack.month !== wall.month ||
    readBack.day !== wall.day ||
    readBack.hour !== wall.hour ||
    readBack.minute !== wall.minute
  ) {
    return null;
  }
  return new Date(timestamp);
}

// ---------------------------------------------------------------- 下次执行

/**
 * 扫描窗口：按本地日期逐天找，最多找 5 年。
 *
 * 为什么是 5 年：最坏的可执行表达式是「每年 2 月 29 日」，闰年间隔最长 4 年
 * （1900 类世纪年跳过的情况在 2100 年前不会出现）。超出窗口就是「这个任务近几年都不会
 * 跑」——`0 0 31 2 *` 这种永远不跑的表达式最终落在 `null` 上，正是我们要的答案。
 */
const MAX_SCAN_DAYS = 366 * 5;

/**
 * 下一次执行时刻；**算不出来就 `null`**，不要给一个可能错的时间。
 *
 * 支持的形态（覆盖我们自己的选择器会生成的全部表达式，加上常见等价手写）：
 *
 * | 段 | 支持 |
 * |---|---|
 * | 全部 5 段 | `*`、单值、列表 `1,2,3`、区间 `1-5`、步长 `*\/5`、区间加步长 `1-9/2` |
 * | 星期 | `0` 与 `7` 都算周日；`5-7` 是 周五/周六/周日 |
 *
 * 返回 `null` 的情况：
 *
 * - 解析不了（不是 5 段、用了名字/`?`/`L`、值越界）；
 * - **日与星期同时被限定**：Vixie cron 在这两段同时限定时是 OR 语义（「每月 1 号或每周一」），
 *   按 AND 算会漏掉一半执行，按 OR 算又要多解释一层，我们没有对应界面，所以拒绝；
 * - 窗口内没有匹配（`0 0 31 2 *`）；
 * - `from` 本身不是有效时间。
 *
 * 时区：`tz` 认不出来时退回系统时区（`resolveTimeZone`）。
 */
export function nextRunAt(cron: string, tz: string, from: Date): Date | null {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return null;
  const fields = parseCron(cron);
  if (!fields) return null;
  if (fields.dayOfMonth && fields.dayOfWeek) return null;

  const zone = resolveTimeZone(tz);
  const fromMs = from.getTime();
  const start = wallClockAt(fromMs, zone);
  const hours = ascending(fields.hour);
  const minutes = ascending(fields.minute);

  let cursor: CalendarDate = { year: start.year, month: start.month, day: start.day };
  for (let scanned = 0; scanned <= MAX_SCAN_DAYS; scanned += 1) {
    if (matchesDate(cursor, fields)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const instant = instantFromWallClock({ ...cursor, hour, minute }, zone);
          // instant 为 null：这个墙上时间当天不存在（DST 前跳），跳过该次而不是硬凑。
          if (instant && instant.getTime() > fromMs) return instant;
        }
      }
    }
    cursor = addDays(cursor, 1);
  }
  return null;
}

function matchesDate(date: CalendarDate, fields: CronFields): boolean {
  if (fields.month && !fields.month.has(date.month)) return false;
  if (fields.dayOfMonth && !fields.dayOfMonth.has(date.day)) return false;
  if (fields.dayOfWeek) {
    // 本地日期的星期几：按「本地日历日」算，与时刻无关，用 UTC 的日期算法即可。
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!fields.dayOfWeek.has(weekday)) return false;
  }
  return true;
}

/** 本地日历日 + N 天（纯日期运算，不碰时区）。 */
function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
