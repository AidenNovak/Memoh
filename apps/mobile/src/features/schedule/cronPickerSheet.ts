/**
 * cron 选择器：**组装原生表单 sheet 的模型 + 等一个结论**。
 *
 * 这一份替掉 `ui/CronPickerPage.tsx`（那张 RN sheet 已删除）。**搬走的只有"画"**：7 种模式、
 * 步进环回、星期多选、手写表达式、无效时拒绝完成——每一条判据都还在 RN 这一侧，
 * 而且用的还是原来那几个纯函数（`cronPicker.ts` / `cron.ts`，一行没动）。
 *
 * ## 原生回什么、RN 算什么
 *
 * 表单里每一颗按键（7 种模式、`−`/`+`、星期/日期格）都**不是结论**：它们只把
 * "用户按了哪一颗"报回来，RN 重算 spec 之后 `update` 一份新模型。所以：
 *
 * - 每一行都标 `staysOpen`（原生不会替这次出席结算——结算只能由 RN 做，见 `nativePicker.ts`）；
 * - 每一颗按键的载荷都是**这一层**序列化的不透明字符串（`{"action":"mode",…}` 之类），
 *   原生只原样回传，不知道里面是什么；
 * - 方向由 RN 给成两份载荷（`downValueJson` / `upValueJson`）：原生不去改载荷里的 `delta`。
 *
 * ## 与原页的三处差别（明说）
 *
 * | 原页 | 这里 |
 * | --- | --- |
 * | 右上角"完成"（无效时置灰、文案换成"还写不出合法表达式"） | 底部输入区的主按钮：文案在无效时同样换成 `cron.result.invalid`；按钮**不能置灰**（契约里没有"主按钮不可用"这一档），无效时按下去什么都不发生，sheet 留在台上 |
 * | 手写表达式只在「手写」模式下出现（分组里的输入框） | 底部那个受控输入框**一直在**（原页的输入框与它是一条路：改它就等于切到手写模式）。分组里的 `kind: 'text'` 行因此不再重复一个同样的框 |
 * | 结果行与预览脚注分居页首页尾 | 结果行（等宽、可长按复制）与预览句放在同一个只读分组里（`info` 布局） |
 *
 * ## 已知没搬过来的东西
 *
 * - **"完成"按钮的置灰态**：见上表。无效时给的是文案（`cron.result.invalid`）与结果行
 *   的危险色，不是一颗按不动的按钮。
 * - **滚到底才看得到的提示**：原页的预览脚注在页尾，现在跟结果行同组（更近，不是更远）。
 */
import {
  formatTime,
  patternFromSpec,
  specFromPattern,
  stepValue,
  switchMode,
  toggleValue,
  WEEKDAY_ORDER,
} from './cronPicker.ts';
import type { CronMode, CronSpec } from './cron.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
  type NativePickerRow,
  type NativePickerSection,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';

export interface CronPickerParams {
  /** 当前表达式（可能是手写的）。 */
  pattern: string;
}

/** 返回选好的表达式；取消 = `cancelled`（编辑页不动草稿）。 */
export interface CronPickerResult {
  pattern: string;
}

const MODES: CronMode[] = ['minutes', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'advanced'];
const MODE_KEY: Record<CronMode, string> = {
  minutes: 'cron.mode.minutes',
  hourly: 'cron.mode.hourly',
  daily: 'cron.mode.daily',
  weekly: 'cron.mode.weekly',
  monthly: 'cron.mode.monthly',
  yearly: 'cron.mode.yearly',
  advanced: 'cron.mode.advanced',
};
/** 每 N 分钟的候选值。给全 1..59 太长，而这些覆盖了真实用法。 */
const MINUTE_STEPS = [1, 2, 5, 10, 15, 20, 30, 45];

/**
 行值里的动作标记。
 
 行值是不透明字符串，原生不解析它——**这一层怎么编码只有这里知道**（与
 `features/schedule/runTargetPicker.ts` 同一条约定）。
 */
type CronAction =
  | { action: 'mode'; mode: CronMode }
  /** 「每 N 分钟」那 8 行：它们换掉的是整个 spec（minutes 模式只有 step 一个字段）。 */
  | { action: 'minutes'; step: number }
  | { action: 'step'; field: StepField; delta: number }
  | { action: 'toggle'; field: 'weekdays' | 'days'; day: number }
  | { action: 'month'; month: number };

/** 能被 `−`/`+` 改的字段。`day` 是「每月几号」（yearly 那一组）。 */
type StepField = 'hour' | 'minute' | 'day';

export function presentCronPicker(
  params: CronPickerParams,
): Promise<PresentationResult<CronPickerResult>> {
  /** 选择器的当前状态。**判据全在纯逻辑层**，这里只负责把它翻成一张表单。 */
  let spec = specFromPattern(params.pattern);

  const buildRequest = (): NativePickerRequest => {
    const pattern = patternFromSpec(spec);
    return {
      title: t('cron.title'),
      sections: sectionsFor(spec),
      // 底部是"自定义表达式"：受控输入（改它就切到手写模式）+ 主按钮（完成）。
      input: {
        label: t('cron.section.expression'),
        placeholder: ADVANCED_PLACEHOLDER,
        value: inputValue(spec, pattern),
        // 无效时按钮上写的就是结果行里那句话（原页的"完成"也是这么换的）。
        submitLabel: pattern === null ? t('cron.result.invalid') : t('common.done'),
      },
      // 这一页永远有行（结果行 + 频率），没有空态与加载态。
      emptyLabel: '',
    };
  };

  /**
   按了表单里的一颗键/一格：**先重算 spec，再下发新模型**。
   
   认不出的载荷什么都不做（宁可这一次点击没有反应，也不要凭空改掉用户的设置）。
   每一行都 `staysOpen`，所以这里必须自己把事件接住——不然 `valueJson` 会被当成"选中了"结算掉。
   */
  const apply = (valueJson: string, handle: NativePickerHandle) => {
    const next = applyAction(spec, readAction(valueJson));
    if (next === null) return;
    spec = next;
    handle.update(buildRequest());
  };

  return presentNativePicker<CronPickerResult>(buildRequest(), {
    onSelect: (valueJson, handle) => {
      apply(valueJson, handle);
      return true;
    },
    onInput: (text, handle) => {
      // 底部输入框是**受控**的：用户一改，这一页就切到手写模式（原页的输入框也是这个行为）。
      spec = { mode: 'advanced', expression: text };
      handle.update(buildRequest());
    },
    onSubmit: (text, handle) => {
      // 输入框是受控的，所以这里**以框里的字为准**（用户可能在最后一次击键之后立刻按了完成）：
      // 按下去就等于"按我写的这串来"——原页的表达式框也是这个意思。
      const next: CronSpec = { mode: 'advanced', expression: text };
      const pattern = patternFromSpec(next);
      // 写不出来就**不结算**：sheet 留在台上，结果行是危险色、按钮文案也是"还写不出合法表达式"。
      if (pattern === null) return;
      spec = next;
      handle.finish({ pattern });
    },
  });
}

/** 手写模式的占位符。与原页的 `placeholder="0 9 * * *"` 一字不差。 */
const ADVANCED_PLACEHOLDER = '0 9 * * *';

/**
 一份 spec → 表单分组。

 形状照原页：结果 → 频率（7 种模式）→ 这一种模式自己的字段。**不重排、不隐藏**——
 所有模式的字段都在同一屏里（滚动），切模式只换"下面显示哪一组"。
 */
function sectionsFor(spec: CronSpec): NativePickerSection[] {
  const pattern = patternFromSpec(spec);
  const sections: NativePickerSection[] = [
    {
      id: 'result',
      // 结果与预览同组：它们是"现在会生成什么"的两个侧面（表达式 + 时刻说明）。
      footer: spec.mode === 'advanced' ? t('cron.expression.footer') : '',
      rows: [
        {
          id: 'cron-result',
          label: t('cron.section.result'),
          // 写不出表达式时**如实说**（原页在同一位置也是这么做的），不显示一个假的表达式。
          value: pattern ?? t('cron.result.invalid'),
          mono: true,
          tone: pattern === null ? 'destructive' : '',
          valueJson: '',
        },
        ...previewRows(spec),
      ],
    },
    {
      id: 'mode',
      header: t('cron.section.frequency'),
      layout: 'form',
      rows: MODES.map((mode) => ({
        id: `cron-mode-${mode}`,
        label: t(MODE_KEY[mode]),
        kind: 'radio',
        selected: spec.mode === mode,
        // 点已选中的那一行 = 什么都没改（`switchMode` 里那条防丢数据的判断）。
        staysOpen: true,
        valueJson: JSON.stringify({ action: 'mode', mode } satisfies CronAction),
      })),
    },
  ];

  sections.push(...modeSections(spec));
  return sections;
}

/**
 当前时刻的说明句（"时刻按 agent 的时区算，当前时刻字段：09:00"）。

 只对**有时刻字段**的模式有意义：每 N 分钟那两种模式里提"当前时刻"是噪音，还会让人以为能设置。
 */
function previewRows(spec: CronSpec): NativePickerRow[] {
  if (!('hour' in spec) || !('minute' in spec)) return [];
  return [
    {
      id: 'cron-preview',
      label: '',
      detail: t('cron.preview.footer', { time: formatTime(spec.hour, spec.minute) }),
      valueJson: '',
    },
  ];
}

/** 这一种模式自己的字段（原页里那几段条件渲染，逐条搬过来）。 */
function modeSections(spec: CronSpec): NativePickerSection[] {
  switch (spec.mode) {
    case 'minutes':
      return [
        {
          id: 'step',
          header: t('cron.section.step'),
          layout: 'form',
          rows: MINUTE_STEPS.map((step) => ({
            id: `cron-step-${step}`,
            label: t('cron.step.every', { count: step }),
            kind: 'radio',
            selected: spec.step === step,
            staysOpen: true,
            valueJson: JSON.stringify({ action: 'minutes', step } satisfies CronAction),
          })),
        },
      ];
    case 'hourly':
      return [
        {
          id: 'minute',
          header: t('cron.section.minute'),
          layout: 'form',
          rows: [stepperRow('cron-minute', t('cron.field.minute'), spec.minute, 'minute')],
        },
      ];
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'yearly':
      return withTimeSections(spec);
    case 'advanced':
      // 手写模式的输入框在底部（见文件头"与原页的三处差别"），这一组没有字段。
      return [];
  }
}

/** daily / weekly / monthly / yearly 共有的"时刻"那一组 + 各自的多选字段。 */
function withTimeSections(spec: Extract<CronSpec, { hour: number }>): NativePickerSection[] {
  const sections: NativePickerSection[] = [
    {
      id: 'time',
      header: t('cron.section.time'),
      layout: 'form',
      rows: [
        stepperRow('cron-hour', t('cron.field.hour'), spec.hour, 'hour'),
        stepperRow('cron-min', t('cron.field.minute'), spec.minute, 'minute'),
      ],
    },
  ];

  if (spec.mode === 'weekly') {
    sections.push({
      id: 'weekdays',
      header: t('cron.section.weekdays'),
      footer: t('cron.weekdays.footer'),
      layout: 'form',
      rows: [
        {
          id: 'cron-weekdays',
          label: '',
          // 摘要句由 RN 拼（原生只画格子）：选得多了以后，一眼看出"选了哪几天"比数格子快。
          detail: weekdaySummary(spec.weekdays),
          kind: 'weekday',
          staysOpen: true,
          valueJson: '',
          chips: WEEKDAY_ORDER.map((day) => ({
            id: String(day),
            label: t(`cron.weekday.${day}`),
            selected: spec.weekdays.includes(day),
            valueJson: JSON.stringify({
              action: 'toggle',
              field: 'weekdays',
              day,
            } satisfies CronAction),
          })),
        },
      ],
    });
  }

  if (spec.mode === 'monthly') {
    sections.push({
      id: 'days',
      header: t('cron.section.days'),
      footer: t('cron.days.footer'),
      layout: 'form',
      rows: [
        {
          id: 'cron-days',
          label: '',
          detail: daySummary(spec.days),
          kind: 'weekday',
          staysOpen: true,
          valueJson: '',
          chips: daysOfMonth().map((day) => ({
            id: String(day),
            label: String(day),
            selected: spec.days.includes(day),
            valueJson: JSON.stringify({
              action: 'toggle',
              field: 'days',
              day,
            } satisfies CronAction),
          })),
        },
      ],
    });
  }

  if (spec.mode === 'yearly') {
    sections.push({
      id: 'month',
      header: t('cron.section.month'),
      layout: 'form',
      rows: [
        {
          id: 'cron-month',
          label: '',
          detail: t(`cron.month.${spec.month}`),
          kind: 'weekday',
          staysOpen: true,
          valueJson: '',
          // 月份名走 `cron.month.N`（与 `cron.weekday.N` 同一套）：`Month 12` 太宽，
          // 12 个格子挤一行时先被挤掉的就是它。
          chips: months().map((month) => ({
            id: String(month),
            label: t(`cron.month.${month}`),
            // 月份是**单选**：`toCron` 的 yearly 只支持单一月。给多选会让某些组合写不出表达式。
            selected: spec.month === month,
            valueJson: JSON.stringify({ action: 'month', month } satisfies CronAction),
          })),
        },
        stepperRow('cron-day-of-month', t('cron.field.day'), spec.day, 'day'),
      ],
    });
  }

  return sections;
}

/** 一条步进行。两颗键的载荷在这里就分好方向（原生不改载荷里的 `delta`）。 */
function stepperRow(id: string, label: string, value: number, field: StepField): NativePickerRow {
  return {
    id,
    label,
    kind: 'stepper',
    // 零填充是刻意的：`9:5` 读起来像错的（原页的 `display` 就是这么补的）。
    value: field === 'day' ? String(value) : String(value).padStart(2, '0'),
    staysOpen: true,
    valueJson: '',
    downValueJson: JSON.stringify({ action: 'step', field, delta: -1 } satisfies CronAction),
    upValueJson: JSON.stringify({ action: 'step', field, delta: 1 } satisfies CronAction),
  };
}

/**
 一颗按键被按下之后的新 spec；认不出/不该动就回 `null`。

 **每一个分支都要先确认"当前模式真的有这个字段"**：原生按下的那一刻与 RN 收到事件之间，
 spec 可能已经被前一次点击改过（两次点击落在同一帧里就会）。照着 `spec.mode` 判一遍，
 比相信事件里的字段名安全。
 */
function applyAction(spec: CronSpec, action: CronAction | null): CronSpec | null {
  if (action === null) return null;

  if (action.action === 'minutes') {
    return { mode: 'minutes', step: action.step };
  }

  if (action.action === 'mode') {
    return switchMode(spec, action.mode);
  }

  if (action.action === 'toggle') {
    if (action.field === 'weekdays') {
      if (spec.mode !== 'weekly') return null;
      return { ...spec, weekdays: toggleValue(spec.weekdays, action.day) };
    }
    if (spec.mode !== 'monthly') return null;
    return { ...spec, days: toggleValue(spec.days, action.day) };
  }

  if (action.action === 'month') {
    if (spec.mode !== 'yearly') return null;
    return { ...spec, month: action.month };
  }

  return withStepped(spec, action.field, action.delta);
}

/**
 改小时 / 分钟 / 每月几号。

 写成 `if`/`switch` 而不是展开重写：`spec` 的联合类型里 `minutes` 没有 hour，
 展开会把它变成"看起来有 hour"的对象（类型上说不通，运行时也会写出一个怪表达式）。
 这三段与原页 `withHour` / `withMinute` 的取值逐条一致（环回区间也一样）。
 */
function withStepped(spec: CronSpec, field: StepField, delta: number): CronSpec | null {
  if (field === 'hour') {
    if (spec.mode === 'hourly' || spec.mode === 'minutes' || spec.mode === 'advanced') return null;
    return { ...spec, hour: stepValue(spec.hour, delta, 0, 23) };
  }

  if (field === 'minute') {
    if (spec.mode === 'minutes' || spec.mode === 'advanced') return null;
    if (spec.mode === 'hourly')
      return { mode: 'hourly', minute: stepValue(spec.minute, delta, 0, 59) };
    return { ...spec, minute: stepValue(spec.minute, delta, 0, 59) };
  }

  if (spec.mode !== 'yearly') return null;
  return { ...spec, day: stepValue(spec.day, delta, 1, 31) };
}

/**
 底部输入框显示什么。

 - **手写模式显示用户自己写的那串**（不加工）：`toCron` 会把 5 段重新拼一遍（吃掉多余空格），
   拿它当受控值的话，用户打一个尾空格就被回灌掉——打字打到一半的字符串不该被规范化。
 - 其余模式显示**当前生成出来的表达式**：所见即所得，用户想改就从这串开始写。
 */
function inputValue(spec: CronSpec, pattern: string | null): string {
  if (spec.mode === 'advanced') return spec.expression;
  return pattern ?? '';
}

/** 星期摘要（"Mon Tue Wed"）。文案走与格子同一套 key，两处不会说两样话。 */
function weekdaySummary(days: number[]): string {
  return WEEKDAY_ORDER.filter((day) => days.includes(day))
    .map((day) => t(`cron.weekday.${day}`))
    .join(' ');
}

/** 每月几号的摘要（"1 5 12"）。数字本身就是它的文案（与原页的格子一致）。 */
function daySummary(days: number[]): string {
  return [...days].sort((left, right) => left - right).join(' ');
}

/** 1..31。 */
function daysOfMonth(): number[] {
  return Array.from({ length: 31 }, (_, index) => index + 1);
}

/** 1..12。 */
function months(): number[] {
  return Array.from({ length: 12 }, (_, index) => index + 1);
}

/** 行值解析。坏 JSON / 不是对象都回 null（这一颗我们认不出来）。 */
function readAction(valueJson: string): CronAction | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as CronAction;
  } catch {
    return null;
  }
}
