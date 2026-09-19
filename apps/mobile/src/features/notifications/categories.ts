/**
 * 通知分类（`UNNotificationCategory`）与它的动作。
 *
 * ## 为什么分类名不在这里写死
 *
 * 分类名是**服务端负载里的 `aps.category`** 与客户端注册之间唯一的对接口子，而它的
 * 出处是 `policy.payloadFor(...).category`（判据层已经定过"审批带动作、跑完/失败不带"）。
 * 在这儿再抄一遍字面量，等于多一个会漂移的真源：某天 policy 改了分类名，通知照旧能到，
 * 但按钮不见了——而且只有真机能看到。
 *
 * 所以这里只做两件事：**从 policy 取分类名**，**给审批的两个动作配文案**。
 *
 * ## 为什么是"允许 / 拒绝"而不是 agent 定义的选项
 *
 * 通知里放不下 agent 给的那一串选项（`allow_once` / `allow_always` / …），所以动作
 * 只能表达最朴素的决定。客户端提交时用的是**兜底决策**（`decision: approve` /
 * `reject`，不带 `option_id`）——这正是 `features/chat/reducer.ts` 里为"服务端没给
 * options"准备的那条路，不是为通知另造一套。细粒度选择留给 App 内的审批面板。
 *
 * 动作标题走 JS 的 i18n：通知按钮也是用户要读的字，它必须跟着 App 的语言，
 * 而不是在原生里再维护一份 `.strings`。
 */

import { payloadFor, type NotificationEvent } from './policy.ts';

/** 审批动作的标识符。**改这里等于改契约**：原生那边按同一套字面量认动作。 */
export const ALLOW_ACTION_ID = 'memoh.approval.allow';
export const REJECT_ACTION_ID = 'memoh.approval.reject';

export interface CategoryAction {
  id: string;
  title: string;
}

export interface CategorySpec {
  id: string;
  actions: CategoryAction[];
}

/** 取分类名时的空上下文：`payloadFor` 只用 `category`，不碰会话 id。 */
const NAMELESS = { sessionId: '', botName: '' };

/** 只有审批这一类带动作。 */
const ACTION_EVENTS: readonly NotificationEvent[] = ['approval_waiting'];

/**
 * 要注册的分类。
 *
 * 动作只挂在 `approval_waiting` 对应的分类上，其余事件注册成"有分类、无动作"——
 * 注册一个空分类不是多余：没有它，服务端发来的 `aps.category` 会匹配不到任何分类，
 * 通知会以"裸"形态出现（分组行为与有分类时不同）。
 */
export function categorySpecs(t: (key: string) => string): CategorySpec[] {
  const approval = payloadFor('approval_waiting', NAMELESS).category;
  const run = payloadFor('run_finished', NAMELESS).category;

  const all: Record<NotificationEvent, CategorySpec> = {
    approval_waiting: {
      id: approval,
      actions: [
        { id: ALLOW_ACTION_ID, title: t('notifications.action.allow') },
        { id: REJECT_ACTION_ID, title: t('notifications.action.reject') },
      ],
    },
    run_finished: { id: run, actions: [] },
    run_failed: { id: run, actions: [] },
  };

  // 去重：两条"跑完"事件共用同一个分类，注册两次会被系统当成一个。
  const specs: CategorySpec[] = [];
  for (const event of ['approval_waiting', 'run_finished', 'run_failed'] as const) {
    if (specs.some((spec) => spec.id === all[event].id)) continue;
    specs.push(all[event]);
  }
  return specs;
}

/** 原生 `notificationsRegisterCategories(json)` 的入参。 */
export function categorySpecsJSON(t: (key: string) => string): string {
  return JSON.stringify(categorySpecs(t));
}

/** 这个分类有没有动作（验收与测试用它确认"审批是可点的"）。 */
export function actionsForCategory(specs: readonly CategorySpec[], id: string): CategoryAction[] {
  return specs.find((spec) => spec.id === id)?.actions ?? [];
}

/** 这两个动作在事件集合里的归属（`ACTION_EVENTS` 只给测试与文档用）。 */
export const ACTIONS_ONLY_FOR: readonly NotificationEvent[] = ACTION_EVENTS;
