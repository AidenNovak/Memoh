/**
 * bot 的**对话语言**（`bot settings` 的 `language` 字段）。
 *
 * ## 对齐桌面端哪一处
 *
 * 桌面端 Global Settings 块的第一行就是它（`pages/bots/components/settings-global-card.vue`）：
 * 一个可搜索的下拉，选项来自 `utils/languages.ts` 的 `ISO639_LANGUAGES`，外加一个
 * `auto`（"跟随"）。这里照抄同一份清单——**不自己挑一个"常用语言"子集**：用户在
 * 桌面端能选的语言，在手机上也得能选，否则同一个 bot 在两个客户端上可表达的范围不同。
 *
 * ## 值域：`auto` 是"没设过"，不是空串
 *
 * 服务端读出来的是字符串 `"auto"`（`internal/settings/types.go` 的 `DefaultLanguage`），
 * 而写进去时空串会被归一化成 `"auto"`（`service.go` 的 `req.Language` 分支）。所以
 * 客户端这边统一用 `auto` 表示"跟随"，**发帧时发空串**（与桌面端一致：下拉里的
 * `auto` 存成 `''`）——两条路在服务端落到同一个值。
 *
 * 实测（2026-09-16，部署实例）：`POST /bots/{id}/settings {"language":"zh"}` 回 200，
 * 随后 `GET` 读回 `"zh"`。
 */

export interface ChatLanguage {
  code: string;
  /** 英文名（搜索时最常用的一列）。 */
  name: string;
  /** 该语言自己的写法——列表的主标题用它（见下）。 */
  nativeName: string;
}

/** "跟随"（服务端的默认值）。 */
export const AUTO_LANGUAGE = 'auto';

/** 与桌面端 `ISO639_LANGUAGES` 逐项一致（顺序也一致：按 code 排）。 */
export const CHAT_LANGUAGES: readonly ChatLanguage[] = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'zh-cn', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-tw', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
];

/**
 把服务端读回来的值收敛成"这一份清单里的一个"。

 三种情形都要当成 `auto`：没这个字段（老服务端）、空串、`auto` 本身。**其余不认识的
 值原样保留**——服务端将来加了新语言，客户端只要不删它就不会在保存时把它改写成 `auto`
 （静默改用户设置比显示一个原始 code 更糟）。
 */
export function normalizeLanguage(value: string | undefined | null): string {
  const code = (value ?? '').trim();
  return code === '' ? AUTO_LANGUAGE : code;
}

/** 清单里查一项；`auto` 与不认识的 code 都返回 `null`（调用方自己决定怎么显示）。 */
export function findLanguage(code: string): ChatLanguage | null {
  const target = code.trim().toLowerCase();
  if (target === '' || target === AUTO_LANGUAGE) return null;
  return CHAT_LANGUAGES.find((language) => language.code === target) ?? null;
}

/**
 列表里那一行的标题。

 用**该语言自己的写法**（"简体中文"而不是 "Chinese (Simplified)"）——与设置页的界面
 语言那一组同一个规矩：把语言名翻译成用户看不懂的那一种，他反而找不到自己要的那一项。
 认不出来的 code 退回它本身（不假装成"自动"）。
 */
export function languageLabel(code: string): string {
  return findLanguage(code)?.nativeName ?? code;
}

/** 副标题：`zh-cn · Chinese (Simplified)`——英文名是搜索时最常想起来的那一列。 */
export function languageSubtitle(code: string): string {
  const language = findLanguage(code);
  return language === null ? '' : `${language.code} · ${language.name}`;
}

/** 用户输入的关键词能匹配到哪几项（code / 英文名 / 母语名三列都算命中）。 */
export function filterLanguages(query: string): ChatLanguage[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...CHAT_LANGUAGES];
  return CHAT_LANGUAGES.filter(
    (language) =>
      language.code.includes(needle) ||
      language.name.toLowerCase().includes(needle) ||
      language.nativeName.toLowerCase().includes(needle),
  );
}
