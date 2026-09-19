/**
 * 对话语言选择器（bot 设置里那一行点开的原生 sheet）。
 *
 * ## 对齐桌面端哪一处
 *
 * 桌面端 Global Settings 的 `Language` 是一个**可搜索的下拉**（`SearchableSelectPopover`，
 * 选项来自 `utils/languages.ts`），当前项打勾、`Auto` 在最上面。这里逐条对应：
 *
 * | 桌面端 | 这里 |
 * | --- | --- |
 * | 搜索框 | 同（39 项里找"简体中文"或 "Chinese" 都得能找；code / 英文名 / 母语名三列都算命中） |
 * | `Auto`（跟随） | 同，排在最上面——改过之后要能改回去 |
 * | 当前项打勾 | 同（`Row` 的 `selected`） |
 * | 项文案 `${code} (${name} / ${nativeName})` | **主标题用母语名、副标题放 `code · name`**：手机上列表窄，三样塞进一行只会三样都读不清（与设置页界面语言那一组同一个规矩） |
 *
 * 选完立刻关（与 `ModelPickerSheet` 一致）——它是"挑一个"的瞬时流程，不是一页内容。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';

import {
  AUTO_LANGUAGE,
  filterLanguages,
  languageSubtitle,
  normalizeLanguage,
} from '../features/bots/languages.ts';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { Group, Row } from './GroupedList.tsx';

export interface LanguagePickerParams {
  /** 当前选择（`auto` 或 code）。 */
  language: string;
}

export interface LanguagePickerResult {
  language: string;
}

function LanguagePickerPresentedView() {
  const palette = usePalette();
  const t = useT();
  const runtime = usePageRuntime<LanguagePickerParams, LanguagePickerResult>();
  const [query, setQuery] = useState('');
  const selected = normalizeLanguage(runtime.params.language);

  const options = useMemo(() => filterLanguages(query), [query]);
  const searching = query.trim() !== '';

  const pick = useCallback(
    (language: string) => {
      runtime.finish({ language });
    },
    [runtime],
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl }}
      // 边打字边点：不设它的话第一次点击只会收键盘，看起来像"点了没反应"。
      keyboardShouldPersistTaps="handled"
    >
      <TextInput
        testID="language-search"
        value={query}
        onChangeText={setQuery}
        placeholder={t('chatLanguage.search')}
        placeholderTextColor={palette.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          typography.body,
          {
            marginHorizontal: GROUP_INSET,
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

      <Group>
        {/* 搜索时把"跟随"一起收起来：用户已经在按关键词找某一门语言了。 */}
        {searching ? null : (
          <Row
            testID={`language-option-${AUTO_LANGUAGE}`}
            title={t('chatLanguage.auto')}
            subtitle={t('chatLanguage.auto.hint')}
            selected={selected === AUTO_LANGUAGE}
            onPress={() => pick(AUTO_LANGUAGE)}
          />
        )}
        {options.map((language, index) => (
          <Row
            key={language.code}
            testID={`language-option-${language.code}`}
            title={language.nativeName}
            subtitle={languageSubtitle(language.code)}
            selected={selected === language.code}
            last={index === options.length - 1}
            onPress={() => pick(language.code)}
          />
        ))}
      </Group>

      {options.length === 0 ? (
        <Text
          testID="language-empty"
          style={[
            typography.footnote,
            { color: palette.secondaryLabel, paddingHorizontal: GROUP_INSET },
          ]}
        >
          {t('chatLanguage.empty')}
        </Text>
      ) : null}
    </ScrollView>
  );
}

export const LanguagePickerSheet = definePage<LanguagePickerParams, LanguagePickerResult>({
  id: 'languagePicker',
  title: 'Language',
  Component: LanguagePickerPresentedView,
  parseRouteParams: (params) => ({ language: normalizeLanguage(String(params.language ?? '')) }),
  presentation: {
    dismissible: true,
    detents: [0.7, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});
