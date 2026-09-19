/**
 * 语言订阅。
 *
 * i18n 本身是模块级单例（没有 Provider），组件用它来在切换语言时重渲染。
 */
import { useSyncExternalStore } from 'react';

import type { Locale } from './index.ts';
import { getLocale, subscribeLocale } from './index.ts';

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
