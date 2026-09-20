/**
 * 从工作区路径算出路由地址。
 *
 * 两种跳转都要拼 URL，拼错了的后果是"点进去还是这一页"或"打开了一个空目录"，
 * 而且只在真机上才发现，所以把路由形状集中在这一处。
 *
 * 形态：
 *   - 目录：`/files/...`（一页一目录的 push，根 `/files` 就是 `/data`）
 *   - 预览：`/preview?path=...`（query 带绝对路径，屏幕层再归一化一次）
 */

import { WORKSPACE_ROOT, normalizeWorkspacePath } from './paths.ts';

/**
 * 目录路由。
 *
 * 路径段用 `encodeURIComponent` 逐个编码：文件名里合法地含有空格、`#`、`?`
 * （`report #3.md`），不编码会被 expo-router 当成 fragment/query 切掉。
 */
export function filesRoute(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === null) return '/files';
  if (normalized === WORKSPACE_ROOT) return '/files';
  const relative = normalized.slice(WORKSPACE_ROOT.length + 1);
  const encoded = relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/files/${encoded}`;
}

export function previewRoute(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === null) return '/preview';
  return `/preview?path=${encodeURIComponent(normalized)}`;
}

/**
 * 从 query 里取路径。
 *
 * expo-router 一般已经解好码了，所以这里只在**结构上必须解码**时才动它：编码过的 `/`
 * （`%2F`）会让一个绝对路径变成"一个没有斜杠的名字"，那会静静地指向错误的位置。
 * 其余情况原样返回——文件名里本来就可能有 `%`，无条件解码会把 `a%20b.md` 改坏。
 */
export function queryPathParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return '';
  if (!raw.includes('%2F') && !raw.includes('%2f')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 路由参数（expo-router 把 `[...path]` 切成数组）→ 一个路径字符串。 */
export function pathFromSegments(value: unknown): string {
  if (Array.isArray(value)) return value.join('/');
  if (typeof value === 'string') return value;
  return WORKSPACE_ROOT;
}
