import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';
import { Platform } from 'react-native';

/**
 * 取 MemohKit 里的一个原生宿主视图（薄壳包装器共用）。
 *
 * 取不到就返回 `null`（更老的 dev client 里还没有这个模块，或者不是 iOS），调用方据此
 * 渲染"重建 App"的提示——**不**给 RN 兜底实现：迁移的判据就是可见 UI 归原生。
 *
 * ## 为什么结果要缓存
 *
 * 两件事都必须只发生一次：
 *
 * 1. **组件类型**：`requireNativeView` 每次都返回新对象的话，React 会当成"换了一个组件
 *    类型"，整棵子树重建；
 * 2. **"有没有这个视图"这个答案**：它由当前 client 的构建决定，首帧之后不会再变，
 *    所以解析一次就够（包括"解析结果是 null"这一次）。
 */
const cache = new Map<string, unknown>();

export function resolveMemohNativeView<P extends object>(name: string): ComponentType<P> | null {
  if (cache.has(name)) return cache.get(name) as ComponentType<P> | null;

  let view: ComponentType<P> | null = null;
  if (Platform.OS === 'ios') {
    try {
      const module = requireOptionalNativeModule('MemohKit');
      // Expo registers host views lazily: module presence alone cannot prove a view exists.
      const runtime = globalThis as typeof globalThis & {
        expo?: { getViewConfig?: (module: string, view: string) => unknown };
      };
      if (module && runtime.expo?.getViewConfig?.('MemohKit', name)) {
        view = requireNativeView<P>('MemohKit', name);
      }
    } catch {
      // An older dev client may not contain the native module yet.
    }
  }
  cache.set(name, view);
  return view;
}
