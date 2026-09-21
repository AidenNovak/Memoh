/**
 * 对话语言选择器：**组装原生选择器的模型 + 等一个结论**。
 *
 * 这一份替掉 `ui/LanguagePickerPage.tsx`（那张 RN sheet 已删除）。逐条对应原来的行为：
 *
 * | 原页 | 这里 |
 * | --- | --- |
 * | 搜索框（code / 英文名 / 母语名三列都算命中） | 同一个（`filterLanguages`，留在 RN） |
 * | `Auto`（跟随）排在最上面 | 同 |
 * | 搜索时把 `Auto` 收起来 | 同（用户已经在按关键词找某一门语言了） |
 * | 主标题用母语名、副标题放 `code · name` | 同（`languageSubtitle`） |
 * | 当前项打勾 | 同（行的 `selected`） |
 * | 选完立刻关 | 同（`select` 即结算） |
 *
 * 值的归一化（空串 / 缺失都算 `auto`）读 `normalizeLanguage`，这里不自己判一遍。
 */
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import {
  AUTO_LANGUAGE,
  filterLanguages,
  languageSubtitle,
  normalizeLanguage,
} from './languages.ts';

export interface LanguagePickerParams {
  /** 当前选择（`auto` 或 code）。 */
  language: string;
}

export interface LanguagePickerResult {
  language: string;
}

export function presentLanguagePicker(
  params: LanguagePickerParams,
): Promise<PresentationResult<LanguagePickerResult>> {
  const selected = normalizeLanguage(params.language);
  /** 搜索框里的字。过滤留在 RN（`filterLanguages`），原生只把击键报回来。 */
  let query = '';

  const buildRequest = (): NativePickerRequest => {
    const searching = query.trim() !== '';
    const options = filterLanguages(query);
    return {
      title: t('chatLanguage.label'),
      searchPlaceholder: t('chatLanguage.search'),
      // 沿用原页的标识（`ui/LanguagePickerPage.tsx` 的搜索框就是 `language-search`）。
      searchTestID: 'language-search',
      sections: [
        {
          id: 'languages',
          rows: [
            // 搜索时把"跟随"一起收起来：用户已经在按关键词找某一门语言了。
            ...(searching
              ? []
              : [
                  {
                    id: AUTO_LANGUAGE,
                    label: t('chatLanguage.auto'),
                    detail: t('chatLanguage.auto.hint'),
                    selected: selected === AUTO_LANGUAGE,
                    valueJson: JSON.stringify({ language: AUTO_LANGUAGE }),
                  },
                ]),
            ...options.map((language) => ({
              id: language.code,
              label: language.nativeName,
              detail: languageSubtitle(language.code),
              selected: selected === language.code,
              valueJson: JSON.stringify({ language: language.code }),
            })),
          ],
        },
      ],
      emptyLabel: t('chatLanguage.empty'),
    };
  };

  return presentNativePicker<LanguagePickerResult>(buildRequest(), {
    onSearch: (text, handle: NativePickerHandle) => {
      query = text;
      handle.update(buildRequest());
    },
  });
}
