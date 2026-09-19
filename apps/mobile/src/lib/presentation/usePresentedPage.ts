/**
 * 把一个"该出现了"的状态翻译成一次 `present()`。
 *
 * ## 为什么需要它
 *
 * 审批（以及后面的 ask_user）不是用户点出来的，是**服务端说"我在等你"**：store 里
 * `chat.approval` 一变，界面就该弹出来。这跟"点一下按钮打开一个 sheet"是两种触发方式，
 * 而契约只提供后者（`present()`）。
 *
 * 这个 hook 就是那座桥：调用方给它一把钥匙（审批 id / 提问 id）与参数，它负责
 * **同一把钥匙只打开一次**——重复打开会让用户在屏幕上叠出两个 sheet，那是这一层最容易
 * 犯的错。
 *
 * ## 为什么钥匙用状态自带的 id，而不是 `true/false`
 *
 * 因为"同一个审批"和"又来一个审批"必须区分得开：前者的 id 相同（不重复弹），后者的
 * id 不同（要弹出新的）。用布尔的"有没有待办"就会把第二个审批吞掉。
 *
 * ## effect 跑两次也没关系
 *
 * 开发构建里 effect 会在同一依赖下跑两次（`docs/research/verified-behaviour.md` 第 20 条）。
 * 这里用 `inFlight` 按下钥匙去重：第二次调用看到钥匙在飞就直接返回。结算之后钥匙会被
 * 释放，所以同一个 id 之后仍然可以再打开（比如用户取消了再看一次）。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

import type { PageDefinition, PagePresentationOptions } from './page.tsx';
import { present } from './present.ts';

export function usePresentedPage<TParams, TResult>(
  page: PageDefinition<TParams, TResult>,
  key: string | null,
  params: TParams,
  options?: Partial<PagePresentationOptions>,
): void {
  const inFlight = useRef<Set<string>>(new Set());
  // 参数与形态只在"打开那一刻"用一次；放 ref 里是为了让它们不参与依赖比较——
  // 否则每次渲染一个新对象，effect 会被反复触发。
  const latest = useRef({ params, options });
  // layout effect 先于下面负责 present 的 passive effect：换 key 的同一次 commit
  // 一定使用新参数，同时不会在 render 期把未提交的值暴露给 ref 读者。
  useLayoutEffect(() => {
    latest.current = { params, options };
  }, [options, params]);

  useEffect(() => {
    if (key === null) return;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    void present(page, latest.current.params, latest.current.options).finally(() => {
      inFlight.current.delete(key);
    });
  }, [key, page]);
}
