/**
 * 当前 bot 在会话 tab 里真正可用的视图。
 *
 * 服务端的权限门是事实源：会话列表只要 `chat`，文件要 `workspace_read`，定时任务要
 * `manage`。不可用的视图不画成灰按钮——灰按钮只会让用户反复点一个必然 403 的入口。
 */
import type { Bot } from '../../api/types.ts';
import { canReadWorkspace } from '../files/permissions.ts';
import { canManageBot } from './permissions.ts';

export type HubView = 'sessions' | 'files' | 'schedule';

export const ALL_HUB_VIEWS: readonly HubView[] = ['sessions', 'files', 'schedule'];

export function hubViewsFor(bot: Bot | null | undefined): readonly HubView[] {
  const views: HubView[] = ['sessions'];
  if (canReadWorkspace(bot)) views.push('files');
  if (canManageBot(bot)) views.push('schedule');
  return views;
}

/**
 * 鉴权完成前与无权深链都只挂载 Sessions。
 *
 * `requested` 仍由外壳保留：有权限的 bot 回来后可以继续兑现 `?view=files/schedule`；
 * 这里只决定这一帧真正能挂载哪个子页，避免权限未知时先触发一个注定 403 的请求。
 */
export function visibleHubView(bot: Bot | null | undefined, requested: HubView): HubView {
  if (bot === null || bot === undefined) return 'sessions';
  return hubViewsFor(bot).includes(requested) ? requested : 'sessions';
}
