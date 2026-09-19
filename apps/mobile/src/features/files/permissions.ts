/**
 * 文件视图的权限门控。
 *
 * 服务端对 `fs/*` 全部要求 `workspace_read`（`containerd.go:1218-1230`）。
 * 没有这个能力的成员，我们**不渲染入口**——不是渲染一个灰按钮：灰按钮会让人反复点、
 * 猜"是不是我点得不对"，而事实是这件事对他不开放（规格 §6"权限纪律"）。
 *
 * 判据只认 `workspace_read` 本身：`manage` 是"管这个 bot"的权限，不等于"能读它的容器"。
 * 猜错的方向是危险的——猜宽了会给人看一个必然 403 的页面。
 */

export interface PermissionHolder {
  current_user_permissions?: string[];
}

export const WORKSPACE_READ = 'workspace_read';

export function canReadWorkspace(bot: PermissionHolder | null | undefined): boolean {
  if (bot === null || bot === undefined) return false;
  const permissions = bot.current_user_permissions;
  if (!Array.isArray(permissions)) return false;
  return permissions.includes(WORKSPACE_READ);
}
