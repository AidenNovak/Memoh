/**
 * bot 配置面的权限门控。
 *
 * ## 为什么要有这一条
 *
 * memoh 的 bot 是可以**共享给别人的**（`acl_preset` + `POST /bots/{id}/user-access`），
 * 所以"能看到这个 bot"和"能改这个 bot"是两件事。服务端把这件事放在
 * `bot.current_user_permissions`（`GET /bots` 每一条都带）里，判据与桌面端同一份：
 * `utils/bot-detail-tabs.ts` 的 `canManageBot`——**权限数组缺失或为空视为可管理**
 * （老服务端 / 自托管的单用户部署本来就不发这个字段，那时没有理由把人挡在外面），
 * 非空且不含 `manage` 才是只读成员。
 *
 * ## 判据只认 `manage`
 *
 * 不拿 `workspace_exec` 或 `workspace_read` 凑数：那三个是**不同的能力**（能不能跑、
 * 能不能读容器、能不能管这个 bot）。用错方向很危险——猜宽了会给人一个按下去必然
 * 403 的入口，猜窄了会把 bot 的主人挡在自己的设置外面。
 *
 * ## 用它的地方：**不渲染**，不是置灰
 *
 * 与本仓库 `features/files/permissions.ts` 的纪律一致：不可用的入口直接不出现。
 * 灰按钮会让人反复点、猜"是不是我点得不对"，而事实是这件事对他不开放
 * （`ios-config-spec.md` §2「只读时不要渲染灰掉的行」）。
 */
import type { Bot } from '../../api/types.ts';

export const MANAGE = 'manage';

/** 只取权限这一件事，方便调用方传 `null` / 部分对象。 */
export interface PermissionHolder {
  current_user_permissions?: string[];
}

/**
 * 这个人能不能改这个 bot 的配置。
 *
 * `bot` 为 `null`（还没选/还没拉到）一律 `false`——没有对象就无从谈"管理它"，
 * 调用方也不该在这种状态下渲染入口。
 */
export function canManageBot(bot: Bot | PermissionHolder | null | undefined): boolean {
  if (bot === null || bot === undefined) return false;
  const permissions = bot.current_user_permissions;
  // 缺失或空数组 = 服务端没有表达"只读"，按可管理处理（与桌面端 `canManageBot` 一致）。
  if (!Array.isArray(permissions) || permissions.length === 0) return true;
  return permissions.includes(MANAGE);
}
