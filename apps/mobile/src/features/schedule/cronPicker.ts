/**
 * cron 选择器的界面状态（纯逻辑）。
 *
 * ## 为什么单独一层
 *
 * `features/schedule/cron.ts` 已经是完整的 7 模式模型 + 无损往返校验（23 项测试）。界面这一层
 * 还有三件**自己就会出错**的事，所以也放在能直测的地方：
 *
 * 1. **从当前表达式进选择器**：用户手上可能是手写的、也可能是别人给的，`fromCron` 认不出来时
 *    必须落到「手写」模式并**原样保留那段文本**——把它悄悄换成 `0 9 * * *` 是篡改用户输入。
 * 2. **切模式时保留什么**：从"每天 09:00"切到"每周"时，09:00 该跟过去（用户改的是频率，不是时刻）；
 *    但"多选"的字段不能凭空继承（周一？全选？）——宁可给一个明确的默认（周一 / 每月 1 号）。
 * 3. **写回时的取值**：`toCron` 对越界输入返回 `null`。界面必须**拒绝完成**，而不是把 null 当成
 *    空串写进草稿（那会让用户在编辑页看到一个空表达式，然后保存失败）。
 */
import { fromCron, toCron, type AdvancedSpec, type CronMode, type CronSpec } from './cron.ts';

/** 从已有表达式得到选择器的初始状态。认不出来就是"手写"，文本原样保留。 */
export function specFromPattern(pattern: string): CronSpec {
  const parsed = pattern.trim() === '' ? null : fromCron(pattern);
  if (parsed !== null) return parsed;
  return { mode: 'advanced', expression: pattern };
}

/**
 切模式时保留能保留的东西。

 - 目标模式有"时刻"（hourly 只有分钟；daily/weekly/monthly/yearly 有小时+分钟）→ 从旧状态继承；
 - 旧的没有时刻（minutes / advanced）→ 用 09:00 这个"最像人上班时间"的默认（比 00:00 更常见，
   而且用户一眼能看出这是个可以改的默认值）；
 - 多选字段（星期几 / 每月几号）**不继承**：给周一 / 每月 1 号。
 */
export function switchMode(current: CronSpec, mode: CronMode): CronSpec {
  // 点已经选中的那一行 = 什么都没改。少了这一步，用户碰一下就发现自己选的"周三、周五"
  // 被重置成了默认的周一——那是最让人恼火的一类丢数据。
  if (current.mode === mode) return current;

  const hour = 'hour' in current ? current.hour : 9;
  const minute = 'minute' in current ? current.minute : 0;
  switch (mode) {
    case 'minutes':
      return { mode: 'minutes', step: current.mode === 'minutes' ? current.step : 15 };
    case 'hourly':
      return { mode: 'hourly', minute };
    case 'daily':
      return { mode: 'daily', hour, minute };
    case 'weekly':
      return { mode: 'weekly', hour, minute, weekdays: [1] };
    case 'monthly':
      return { mode: 'monthly', hour, minute, days: [1] };
    case 'yearly':
      return {
        mode: 'yearly',
        hour,
        minute,
        day: current.mode === 'yearly' ? current.day : 1,
        month: current.mode === 'yearly' ? current.month : 1,
      };
    case 'advanced':
      return { mode: 'advanced', expression: toCron(current) ?? advancedFrom(current) };
  }
}

function advancedFrom(current: CronSpec): string {
  const advanced: AdvancedSpec = { mode: 'advanced', expression: '' };
  return advanced.expression;
}

/** 写回编辑页。`null` = 这个状态还写不出合法表达式，界面应当**拒绝完成**。 */
export function patternFromSpec(spec: CronSpec): string | null {
  return toCron(spec);
}

/**
 时刻显示（`9:05` → `09:05`）。

 零填充是刻意的：`9:5` 读起来像错的，而 24 小时制在这个产品的其他位置（定时列表的"下次执行"）
 也是这么显示的，两处必须一致。
 */
export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 步进（`+`/`-`），在 `[min, max]` 上**环回**。 */
export function stepValue(value: number, delta: number, min: number, max: number): number {
  const span = max - min + 1;
  const shifted = (value - min + delta) % span;
  return min + ((shifted + span) % span);
}

/** 多选：加进去或拿掉（拿掉最后一个要拦住——"每周几天"里 0 天不是合法状态）。 */
export function toggleValue(values: number[], value: number): number[] {
  if (!values.includes(value)) return [...values, value].sort((left, right) => left - right);
  if (values.length === 1) return values;
  return values.filter((item) => item !== value);
}

/** 星期几的显示顺序：周一到周日（`Date` 的 0 是周日，但列表从周一排更好读）。 */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
