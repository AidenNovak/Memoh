import type { SymbolViewProps } from 'expo-symbols';

/**
 * SF Symbol 名 → 过桥用的普通字符串。
 *
 * `SymbolViewProps['name']` 允许按平台给不同名字（对象形状），而原生宿主只认 iOS 那一档。
 * 在桥边归一化，保证过桥的 `symbol` 永远是字符串——不然原生侧解出来的就是"什么都没有"，
 * 画一个空白图标。
 */
export function symbolName(name: SymbolViewProps['name']): string {
  if (typeof name === 'string') return name;
  return name.ios ?? '';
}
