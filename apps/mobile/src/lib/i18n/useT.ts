/**
 * 翻译 hook。
 *
 * 组件用 `const t = useT()` 拿到翻译函数；语言切换时因为订阅了 locale，会重渲染。
 *
 * ## ⚠️ 为什么是"把 locale 读进闭包里"，而不是 `useCallback(fn, [locale])`
 *
 * 以前这里是 `useCallback((key, params) => translate(key, params), [locale])`——依赖写在
 * 数组里，但**函数体读的是模块级 `current`**，闭包一个响应式值都没捕获。项目开了
 * React Compiler（`app.config.ts` 的 `experiments.reactCompiler`），它按**自己推断的**
 * 依赖决定记忆化，数组里那些"多写的"依赖不算数：它把那个回调提到了**模块级**，
 * `useT()` 于是永远返回同一个函数。
 *
 * 后果是**局部不更新**，比"整个不渲染"更难看出来：`useLocale()` 变的是 `locale` 本身
 * （勾能跟着走），而每一处 `t('...')` 的结果都被编译器按 `t` 的身份记忆下来——
 * `t` 不变，译文就永远停在第一次渲染。E2E 旅程 `language` 抓到的正是这个：
 * 「勾动了、整页文案一个字都不换」（视图树里 `简体中文, ✓` 与 `Settings` 同框）。
 *
 * 现在把 locale 传给 `translateFor`，闭包真读它，编译器据此知道这个函数依赖 locale，
 * 语言一变就换一个新的 `t`，以它为依赖的记忆（每一条译文）随之重算。
 * **别改回"读模块级 current"的写法**，改回去这个 bug 就复现。
 */
import { useMemo } from 'react';

import type { Locale } from './index.ts';
import { translateFor } from './index.ts';
import { useLocale } from './useLocale.ts';

type Params = Record<string, string | number>;

export function useT(): (key: string, params?: Params) => string {
  const locale = useLocale();
  return useMemo(
    () => (key: string, params?: Params) => translateFor(locale, key, params),
    [locale],
  );
}

export type { Locale };
