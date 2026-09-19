/**
 * 时区选择器（bot 设置里那一行点开的原生 sheet）。
 *
 * ## 为什么是 push 子页而不是就地 picker
 *
 * 值域是 **419 项**（`TIMEZONES`）。桌面端能在下拉里塞一个虚拟列表，是因为它有鼠标滚轮和
 * 一屏 80 行的浏览器窗口；手机上把 419 项摊在设置行上，用户唯一的操作方式就变成"滚很久
 * 然后瞎点"。裁决（`docs/research/lody-desktop-vs-ios-feature-surface.md` §3.1）就是
 * 按这个来的：**形态可以完全不同，能力不许少**——所以做成和 `LanguagePickerPage` /
 * `ModelPickerPage` 同一套的可搜索 push 子页，形状与它保持一致（它们是同一个"挑一个"的
 * 瞬时流程，长得不一样只会让人多学一遍）。
 *
 * ## 三件事照着裁决做
 *
 * | 裁决 | 这里 |
 * | --- | --- |
 * | 必须可搜索（别让用户滚 419 项） | 搜索框 + `filterTimezones`（`new york`、`shanghai`、`asia/` 都能命中） |
 * | 进来先回答"我现在是哪个" | 顶部一行**固定的当前生效值**（继承时说明是部署默认），列表里那项也打勾 |
 * | 给一个显式的"继承/默认"档，不猜 | `INHERIT_TIMEZONE` 那一行，排在最上面——改过之后要能改回去 |
 *
 * 选完立刻关（与 `LanguagePickerPage` 一致）：它是"挑一个"的瞬时流程，不是一页内容。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';

import {
  INHERIT_TIMEZONE,
  filterTimezones,
  effectiveTimezone,
  normalizeTimezone,
  timezoneCity,
  timezoneSubtitle,
} from '../features/bots/timezones.ts';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { Row } from './GroupedList.tsx';

export interface TimezonePickerParams {
  /** 当前选择：`''`（继承部署默认）或 IANA 名字。 */
  timezone: string;
}

export interface TimezonePickerResult {
  timezone: string;
}

/** 列表项：`inherit` 那一行 + 全表里的每一项。封闭集合，别用布尔拼。 */
interface PickerOption {
  kind: 'inherit' | 'zone';
  value: string;
}

function TimezonePickerPresentedView() {
  const palette = usePalette();
  const t = useT();
  const runtime = usePageRuntime<TimezonePickerParams, TimezonePickerResult>();
  const [query, setQuery] = useState('');
  const selected = normalizeTimezone(runtime.params.timezone);
  /** 顶部那一行说的就是"现在生效的是哪个"——不是"你选过哪个"。 */
  const current = effectiveTimezone(selected);

  /**
   选项是**一行**（继承）加上过滤后的全表。

   用 `FlatList` 而不是 `ScrollView`：419 项全渲染成视图会让这张 sheet 打开就掉帧，
   `LanguagePickerPage` 那种 `ScrollView` 写法在 39 项时没问题，在这里不行。

   搜索时把"继承"那一行收起来（与语言选择器同一条规矩）：用户已经在按地名找某个
   具体时区了。
  */
  const searching = query.trim() !== '';
  const options = useMemo<PickerOption[]>(() => {
    const zones: PickerOption[] = filterTimezones(query).map((zone) => ({
      kind: 'zone',
      value: zone,
    }));
    if (searching) return zones;
    return [{ kind: 'inherit', value: INHERIT_TIMEZONE }, ...zones];
  }, [query, searching]);

  const pick = useCallback(
    (timezone: string) => {
      runtime.finish({ timezone });
    },
    [runtime],
  );

  return (
    <View style={{ flex: 1, backgroundColor: palette.groupedBackground }}>
      {/* 当前生效值：**在搜索框上面**，因为它回答的问题是"我现在是哪个"，
          不是"我本来想找哪个"。搜索时它不消失——用户随时能拿它跟候选对照。 */}
      <Text
        testID="timezone-current"
        style={[
          typography.footnote,
          { color: palette.secondaryLabel, paddingHorizontal: GROUP_INSET, paddingTop: spacing.md },
        ]}
      >
        {current.inherited
          ? t('timezone.current.inherited', { timezone: current.zone })
          : t('timezone.current.set', { timezone: current.zone })}
      </Text>

      <TextInput
        testID="timezone-search"
        value={query}
        onChangeText={setQuery}
        placeholder={t('timezone.search')}
        placeholderTextColor={palette.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          typography.body,
          {
            marginHorizontal: GROUP_INSET,
            marginTop: spacing.sm,
            marginBottom: spacing.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            minHeight: MIN_TOUCH_TARGET,
            color: palette.label,
            backgroundColor: palette.field,
            borderRadius: radius.md,
          },
        ]}
      />

      {/* 一张卡片装全部行（形状与 GroupedList 的分组一致），但由 FlatList 虚拟化。 */}
      <View
        style={{
          flex: 1,
          marginHorizontal: GROUP_INSET,
          marginBottom: spacing.lg,
          backgroundColor: palette.card,
          borderRadius: radius.md,
          overflow: 'hidden',
        }}
      >
        <FlatList
          testID="timezone-list"
          data={options}
          keyExtractor={(item) => item.value}
          // 边打字边点：不设它的话第一次点击只会收键盘，看起来像"点了没反应"。
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={16}
          renderItem={({ item, index }) => {
            const isInherit = item.kind === 'inherit';
            return (
              <Row
                testID={`timezone-option-${item.value === '' ? 'inherit' : item.value}`}
                title={isInherit ? t('timezone.inherit') : timezoneCity(item.value)}
                subtitle={
                  isInherit
                    ? t('timezone.inherit.hint')
                    : `${item.value} · ${timezoneSubtitle(item.value)}`
                }
                selected={selected === item.value}
                last={index === options.length - 1}
                onPress={() => pick(item.value)}
              />
            );
          }}
        />
      </View>

      {options.length === 0 ? (
        <Text
          testID="timezone-empty"
          style={[
            typography.footnote,
            { color: palette.secondaryLabel, paddingHorizontal: GROUP_INSET },
          ]}
        >
          {t('timezone.empty')}
        </Text>
      ) : null}
    </View>
  );
}

export const TimezonePickerSheet = definePage<TimezonePickerParams, TimezonePickerResult>({
  id: 'timezonePicker',
  title: 'Timezone',
  Component: TimezonePickerPresentedView,
  parseRouteParams: (params) => ({ timezone: normalizeTimezone(String(params.timezone ?? '')) }),
  presentation: {
    dismissible: true,
    detents: [0.7, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});
