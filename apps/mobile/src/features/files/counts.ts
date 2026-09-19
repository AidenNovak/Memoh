/**
 * 目录项数的记忆。
 *
 * ## 为什么只能靠"进过才知道"
 *
 * 服务端不给目录的子项数（`fs/list` 只回条目本身），而递归预取 = N 次串行请求，
 * 弱网上会拖垮（规格 §6 明确不做）。所以这里记住**见过的**目录有几项，
 * 父级列表就能显示「目录 · 12 项」；没见过的目录只写「目录」——**不编造，也不显示 0**。
 *
 * 存在模块级 Map 里而不是 state：它跨越路由（在子目录里数完、返回父目录时要用），
 * 而返回父目录会让父页面重新渲染，正好读到新值。
 */

const counts = new Map<string, number>();

export function rememberDirectoryCount(path: string, count: number): void {
  counts.set(path, count);
}

export function directoryCount(path: string): number | null {
  return counts.get(path) ?? null;
}

/** 验收用：种子重启 App 会重来，但同一进程里切换场景要能清干净。 */
export function clearDirectoryCounts(): void {
  counts.clear();
}
