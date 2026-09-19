/**
 * cron 选择器（频率 + 时刻，7 种模式）——`present()` 出来的原生 sheet。
 *
 * ## 为什么要有这一层（设计基线 §7.6 的裁决）
 *
 * 那一节的裁决原文是"手机端给 **cron 选择器** + prompt + 次数上限 + 启停 + 执行历史，与桌面
 * 同结构"，并明确否掉了"只读 + 启停"这种更省事的方案。逻辑层（`features/schedule/cron.ts`，
 * 7 模式 + 无损往返）早就就绪了，缺的只是界面——这一页就是那一层。
 *
 * 它同时替掉了原来那四行**预设**（`0 9 * * *` 之类）：预设能表达的东西是这一页的子集，
 * 而选择器还会**把当前设置显示出来**（预设只是"点一下写进去"，看不出现在是什么）。
 * 每个预设仍然在 ≤3 次点击内到达。
 *
 * ## 形态上的两个取舍
 *
 * 1. **时刻用步进行（`−` / `09` / `+`）而不是滚轮**：iOS 的时间滚轮是 `UIDatePicker`，
 *    RN 没有等价控件，本项目也没有那个原生模块。硬做滚轮要引新依赖；而步进行精确、44pt
 *    触控目标、能直测（每一下都是一个确定的 testID）。手写那一档仍然可以打任意表达式。
 * 2. **不重排、不隐藏**：所有模式的字段都摆在同一屏里（滚动），切模式只换"下面显示哪几行"。
 *    把每种模式做成独立子页会让"改一个数字"变成三次跳转。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatTime,
  patternFromSpec,
  specFromPattern,
  stepValue,
  switchMode,
  toggleValue,
  WEEKDAY_ORDER,
} from '../features/schedule/cronPicker.ts';
import type { CronMode, CronSpec } from '../features/schedule/cron.ts';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import {
  GROUP_INSET,
  MIN_TOUCH_TARGET,
  PRESS_OPACITY,
  radius,
  spacing,
  typography,
} from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';

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

function CronPickerView() {
  const palette = usePalette();
  const t = useT();
  const runtime = usePageRuntime<CronPickerParams, CronPickerResult>();
  const [spec, setSpec] = useState<CronSpec>(() => specFromPattern(runtime.params.pattern));

  const pattern = useMemo(() => patternFromSpec(spec), [spec]);
  const canFinish = pattern !== null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl }}
      keyboardShouldPersistTaps="handled"
    >
      {/*
        标题行 = 标题 + **完成**（与 `SessionInfoPage` 同一个形态）。
        原先"完成"在整页最下方：sheet 只有 0.7 高，用户选完星期还得再滚下去才按得到。
        而这一页的默认路径就是"选一下、完成"——把结论与出口都放在**不滚动就能看到**的地方。
      */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: GROUP_INSET,
          marginBottom: spacing.md,
        }}
      >
        <Text style={[typography.title2, { color: palette.label, flex: 1 }]}>
          {t('cron.title')}
        </Text>
        <Pressable
          testID="cron-done"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canFinish }}
          disabled={!canFinish}
          onPress={() => {
            if (pattern === null) return;
            runtime.finish({ pattern });
          }}
          hitSlop={12}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: 'flex-end',
            justifyContent: 'center',
            opacity: canFinish ? 1 : 0.5,
          }}
        >
          <Text style={[typography.body, { color: palette.accent }]}>
            {canFinish ? t('common.done') : t('cron.result.invalid')}
          </Text>
        </Pressable>
      </View>

      {/* 「将会生成」紧跟标题：这是**所见即所得**那一行，远的手写模式也靠它当场知道自己写对没有。
          放在页尾等于"要滚到底才知道自己选出了什么"。 */}
      <Section header={t('cron.section.result')}>
        <View
          testID="cron-result"
          style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 2 }}
        >
          <Text
            style={[
              typography.mono,
              { color: pattern === null ? palette.destructive : palette.label },
            ]}
          >
            {pattern ?? t('cron.result.invalid')}
          </Text>
        </View>
      </Section>

      {/* 频率：7 种模式。选中项打勾——用户一眼看到"我现在是哪种"。 */}
      <Section header={t('cron.section.frequency')}>
        {MODES.map((mode, index) => (
          <Pressable
            key={mode}
            testID={`cron-mode-${mode}`}
            accessibilityRole="button"
            accessibilityState={{ selected: spec.mode === mode }}
            onPress={() => setSpec((current) => switchMode(current, mode))}
            style={({ pressed }) => ({
              minHeight: MIN_TOUCH_TARGET,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              paddingHorizontal: spacing.lg,
              backgroundColor: pressed ? palette.field : 'transparent',
              borderBottomWidth: index === MODES.length - 1 ? 0 : StyleSheet.hairlineWidth,
              borderBottomColor: palette.separator,
            })}
          >
            <Text style={[typography.body, { color: palette.label, flex: 1 }]}>
              {t(MODE_KEY[mode])}
            </Text>
            {spec.mode === mode ? (
              <Text style={[typography.body, { color: palette.accent }]}>✓</Text>
            ) : null}
          </Pressable>
        ))}
      </Section>

      {/* 每种模式的字段 */}
      {spec.mode === 'minutes' ? (
        <Section header={t('cron.section.step')}>
          {MINUTE_STEPS.map((step, index) => (
            <Pressable
              key={step}
              testID={`cron-step-${step}`}
              accessibilityRole="button"
              accessibilityState={{ selected: spec.step === step }}
              onPress={() => setSpec({ mode: 'minutes', step })}
              style={({ pressed }) => ({
                minHeight: MIN_TOUCH_TARGET,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: spacing.lg,
                backgroundColor: pressed ? palette.field : 'transparent',
                borderBottomWidth: index === MINUTE_STEPS.length - 1 ? 0 : StyleSheet.hairlineWidth,
                borderBottomColor: palette.separator,
              })}
            >
              <Text style={[typography.body, { color: palette.label, flex: 1 }]}>
                {t('cron.step.every', { count: step })}
              </Text>
              {spec.step === step ? (
                <Text style={[typography.body, { color: palette.accent }]}>✓</Text>
              ) : null}
            </Pressable>
          ))}
        </Section>
      ) : null}

      {spec.mode === 'hourly' ? (
        <Section header={t('cron.section.minute')}>
          <Stepper
            testID="cron-minute"
            title={t('cron.field.minute')}
            value={spec.minute}
            display={String(spec.minute)}
            onChange={(delta) =>
              setSpec({ mode: 'hourly', minute: stepValue(spec.minute, delta, 0, 59) })
            }
          />
        </Section>
      ) : null}

      {'hour' in spec ? (
        <Section header={t('cron.section.time')}>
          <Stepper
            testID="cron-hour"
            title={t('cron.field.hour')}
            value={spec.hour}
            display={String(spec.hour).padStart(2, '0')}
            onChange={(delta) => setSpec(withHour(spec, stepValue(spec.hour, delta, 0, 23)))}
          />
          <Stepper
            testID="cron-min"
            title={t('cron.field.minute')}
            value={spec.minute}
            display={String(spec.minute).padStart(2, '0')}
            last
            onChange={(delta) => setSpec(withMinute(spec, stepValue(spec.minute, delta, 0, 59)))}
          />
        </Section>
      ) : null}

      {spec.mode === 'weekly' ? (
        <Section header={t('cron.section.weekdays')} footer={t('cron.weekdays.footer')}>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.md }}
          >
            {WEEKDAY_ORDER.map((day) => (
              <Chip
                key={day}
                testID={`cron-weekday-${day}`}
                label={t(`cron.weekday.${day}`)}
                selected={spec.weekdays.includes(day)}
                onPress={() => setSpec({ ...spec, weekdays: toggleValue(spec.weekdays, day) })}
              />
            ))}
          </View>
        </Section>
      ) : null}

      {spec.mode === 'monthly' ? (
        <Section header={t('cron.section.days')} footer={t('cron.days.footer')}>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.md }}
          >
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
              <Chip
                key={day}
                testID={`cron-day-${day}`}
                label={String(day)}
                selected={spec.days.includes(day)}
                onPress={() => setSpec({ ...spec, days: toggleValue(spec.days, day) })}
              />
            ))}
          </View>
        </Section>
      ) : null}

      {spec.mode === 'yearly' ? (
        <Section header={t('cron.section.month')}>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.md }}
          >
            {/* 月份名走 `cron.month.N`（与 `cron.weekday.N` 同一套）：`Month 12` 太宽，
                12 个 chip 挤一行时先被挤掉的就是它。 */}
            {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
              <Chip
                key={month}
                testID={`cron-month-${month}`}
                label={t(`cron.month.${month}`)}
                selected={spec.month === month}
                // 月份是**单选**：`toCron` 的 yearly 只支持单一月。给多选会让某些组合写不出表达式。
                onPress={() => setSpec({ ...spec, month })}
              />
            ))}
          </View>
          <Stepper
            testID="cron-day-of-month"
            title={t('cron.field.day')}
            value={spec.day}
            display={String(spec.day)}
            last
            onChange={(delta) => setSpec({ ...spec, day: stepValue(spec.day, delta, 1, 31) })}
          />
        </Section>
      ) : null}

      {spec.mode === 'advanced' ? (
        <Section header={t('cron.section.expression')} footer={t('cron.expression.footer')}>
          <TextInput
            testID="cron-expression"
            value={spec.expression}
            onChangeText={(expression) => setSpec({ mode: 'advanced', expression })}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="0 9 * * *"
            placeholderTextColor={palette.placeholder}
            style={[
              typography.mono,
              {
                color: palette.label,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                minHeight: MIN_TOUCH_TARGET,
              },
            ]}
          />
        </Section>
      ) : null}

      {/* "时刻按 agent 的时区算"只对**有时刻字段**的模式有意义：每 N 分钟那两种模式里
          提"当前时刻"是噪音，还会让人以为能设置。 */}
      {hasTimeFields(spec) ? (
        <Text
          style={[
            typography.footnote,
            { color: palette.tertiaryLabel, paddingHorizontal: GROUP_INSET, marginTop: spacing.md },
          ]}
        >
          {t('cron.preview.footer', { time: formatTime(spec.hour, spec.minute) })}
        </Text>
      ) : null}
    </ScrollView>
  );
}

/** 这个模式有没有"小时 + 分钟"字段（脚注与时刻那一组都用它判断）。 */
function hasTimeFields(spec: CronSpec): spec is Extract<CronSpec, { hour: number }> {
  return 'hour' in spec && 'minute' in spec;
}

/**
 改小时/分钟：只对**带这两个字段的模式**生效。

 写成 `if`/`switch` 而不是展开重写：`spec` 的联合类型里 `minutes` 没有 hour，
 展开会把它变成"看起来有 hour"的对象（类型上说不通，运行时也会写出一个怪表达式）。
 */
function withHour(spec: CronSpec, hour: number): CronSpec {
  if (
    spec.mode === 'daily' ||
    spec.mode === 'weekly' ||
    spec.mode === 'monthly' ||
    spec.mode === 'yearly'
  ) {
    return { ...spec, hour };
  }
  return spec;
}

function withMinute(spec: CronSpec, minute: number): CronSpec {
  if (spec.mode === 'hourly') return { mode: 'hourly', minute };
  if (
    spec.mode === 'daily' ||
    spec.mode === 'weekly' ||
    spec.mode === 'monthly' ||
    spec.mode === 'yearly'
  ) {
    return { ...spec, minute };
  }
  return spec;
}

function Section({
  header,
  footer,
  children,
}: {
  header: string;
  footer?: string;
  children: React.ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text
        style={[
          typography.footnote,
          {
            color: palette.secondaryLabel,
            paddingHorizontal: GROUP_INSET,
            marginBottom: spacing.xs,
          },
        ]}
      >
        {header}
      </Text>
      <View
        style={{
          backgroundColor: palette.card,
          marginHorizontal: GROUP_INSET,
          borderRadius: radius.md,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
      {footer === undefined ? null : (
        <Text
          style={[
            typography.footnote,
            { color: palette.tertiaryLabel, paddingHorizontal: GROUP_INSET, marginTop: spacing.xs },
          ]}
        >
          {footer}
        </Text>
      )}
    </View>
  );
}

/** 步进行：`−` / 值 / `+`，三段都是 44pt 触控目标。 */
function Stepper({
  testID,
  title,
  display,
  last,
  onChange,
}: {
  testID: string;
  title: string;
  value: number;
  display: string;
  last?: boolean;
  onChange: (delta: number) => void;
}) {
  const palette = usePalette();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: last === true ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: palette.separator,
      }}
    >
      <Text style={[typography.body, { color: palette.label, flex: 1 }]}>{title}</Text>
      <StepButton testID={`${testID}-down`} label="−" onPress={() => onChange(-1)} />
      <Text
        testID={`${testID}-value`}
        style={[typography.mono, { color: palette.label, minWidth: 44, textAlign: 'center' }]}
      >
        {display}
      </Text>
      <StepButton testID={`${testID}-up`} label="+" onPress={() => onChange(1)} />
    </View>
  );
}

function StepButton({
  testID,
  label,
  onPress,
}: {
  testID: string;
  label: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? PRESS_OPACITY.control : 1,
      })}
    >
      <Text style={[typography.title3, { color: palette.accent }]}>{label}</Text>
    </Pressable>
  );
}

function Chip({
  testID,
  label,
  selected,
  onPress,
}: {
  testID: string;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 46,
        minHeight: 38,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.sm,
        borderRadius: radius.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? palette.accent : palette.separator,
        backgroundColor: selected || pressed ? palette.field : 'transparent',
      })}
    >
      <Text
        style={[
          typography.subhead,
          {
            color: selected ? palette.accent : palette.label,
            fontWeight: selected ? '600' : '400',
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const CronPickerSheet = definePage<CronPickerParams, CronPickerResult>({
  id: 'cronPicker',
  title: 'Schedule',
  Component: CronPickerView,
  parseRouteParams: (params) => ({ pattern: String(params.pattern ?? '') }),
  presentation: {
    dismissible: true,
    detents: [0.7, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});
