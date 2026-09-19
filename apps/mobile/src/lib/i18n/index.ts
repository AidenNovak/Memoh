/**
 * 极小 i18n。
 *
 * 文案的唯一真源是 `locales/{en,zh-Hans}.json`（单层扁平 key，点号分层）。
 * `pnpm i18n:check` 保证两个文件的 key 集合完全一致。config plugin `withLocales`
 * 会在 prebuild 时把同一份 JSON 投影成原生 `xcstrings`，让系统控件（返回、
 * 分享菜单、权限弹窗）也吃到本地化。
 *
 * **不含复数规则**（刻意不引 ICU / i18next 这类依赖）：中英都用 `{{count}}` 直接插值。
 * 代价落在英文侧——英文有词形变化，中文没有。所以含 `{{count}}` 的句子要**改写成不含
 * 可数名词的形式**（`Every {{count}} min`、`Lines hidden: {{count}}`），不能写成
 * `Every {{count}} minutes`：那样 `count = 1` 时就是 `1 minutes` / `1 items` 这种病句，
 * 而且只在参数恰好是 1 的那一次出现，人肉 review 基本抓不住。
 *
 * 这条有测试守着：`apps/mobile/tests/locale-copy.test.mjs`（同一份文件里还有一条：中文值
 * 里不许出现英文单词）。写新文案前先看一眼它，别把这句注释当成"英文也不用管"的许可。
 */
import { getLocales } from 'expo-localization';

import en from '../../../locales/en.json';
import zhHans from '../../../locales/zh-Hans.json';

export type Locale = 'en' | 'zh-Hans';

const catalogs: Record<Locale, Record<string, string>> = {
  en,
  'zh-Hans': zhHans,
};

const FALLBACK: Locale = 'en';

let current: Locale = FALLBACK;
const listeners = new Set<() => void>();

function normalize(tag: string | null | undefined): Locale {
  if (!tag) return FALLBACK;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-Hans';
  return 'en';
}

/** 必须在渲染第一帧之前调用（见 `boot.ts`）。 */
export function initI18n(): void {
  try {
    const [first] = getLocales();
    current = normalize(first?.languageTag);
  } catch {
    current = FALLBACK;
  }
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Params = Record<string, string | number>;

/**
 * 按**指定**语言取文案。查不到的 key 原样返回 key 本身——这样 UI 上会立刻看出漏翻，
 * 而不是静默显示空白。
 *
 * 为什么要有一个"显式语言"的版本：`t` 从模块级 `current` 取值，那是一次**隐式读取**。
 * 把它包进 hook 返回给组件时，返回的函数与语言之间就没有任何可见的联系——
 * React Compiler 据此认定它永不变化（见 `useT.ts` 的注释：整棵树的译文被冻在第一次渲染）。
 * `useT` 用它把 locale 变成真正的依赖。
 */
export function translateFor(locale: Locale, key: string, params?: Params): string {
  const template = catalogs[locale][key] ?? catalogs[FALLBACK][key] ?? key;
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** 按**当前**语言取文案（`translateFor` + 模块级 `current`）。React 之外的地方用它。 */
export function t(key: string, params?: Params): string {
  return translateFor(current, key, params);
}

/**
 * 文案表里有这个 key 吗。
 *
 * 用途只有一个：**分辨"我们自己的 key"和"别人写好的句子"**。有些字段两种都可能是
 * （协议里的错误、reducer 里的 `runError`），以前的分辨办法是 `startsWith('error.')`
 * ——那依赖命名约定，改个 key 前缀就静默失效。查表不依赖任何约定。
 */
export function hasTranslation(key: string): boolean {
  if (catalogs[current][key] !== undefined) return true;
  return catalogs[FALLBACK][key] !== undefined;
}

/** 已格式化的展示用语言名。 */
export function localeDisplayName(locale: Locale): string {
  if (locale === 'zh-Hans') return '简体中文';
  return 'English';
}

export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-Hans'];
