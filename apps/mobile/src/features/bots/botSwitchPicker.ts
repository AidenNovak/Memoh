/**
 * agent 切换选择器：**组装原生选择器的模型 + 等一个结论**。
 *
 * 这一份替掉 `ui/BotSwitchPage.tsx`（那张 RN sheet 已删除）。原页那几条判据一条没动：
 *
 * | 判据 | 为什么（原页的理由，照抄） |
 * | --- | --- |
 * | 不可点的行按 `check_state === 'issue'` 挡，不按 `bot.status === 'error'` | 服务端 `bot.status` 只有 `creating / ready / deleting`，`error` 永远不会出现——照抄桌面端那句等于抄一段死代码 |
 * | 一个 bot 都没有时说"没拉到 / 还没有 agent"（`agentPlaceholderKey`） | "没拉到"和"真的没有"是两件事，不能都念成空态 |
 * | 「Agent settings」只在 `canManageBot` 时出现 | 共享 bot 的成员能切到它、能聊，但改不了它；摆一个必然 403 的入口只会让人白点一次 |
 * | 标题 `display_name \|\| name` | 与列表、页头同一处显示规则 |
 *
 * ## 两处与原页的差别（明说）
 *
 * 1. **两行动作并进列表**：原页底部那两行（「新建 Bot」/「Agent settings」）各自一张卡片，
 *    这里作为第二组的行（id 分别是 `new` / `settings`）。它们仍是"点一下就到位"。
 * 2. **「Agent settings」的跳转在调用方**：原页是"先 `finish` 再 `router.push`"，现在这一层
 *    只回一个 `{kind:'settings', botId}`，由 `useAgentSwitcher` 跳（路由在那一侧，
 *    与"原生不认识路由"同一条边界）。
 *
 * 上面表格第 1 条现在是**行上的 `disabled` 字段**（判据仍然在 RN 算，原生只画灰态、
 * 不响应点击）——所以这一页不需要 `onSelect` 拦截：每一行点下去就是一个结论。
 *
 * 桌面端的置顶/拖拽排序仍然不搬：它存在浏览器 localStorage 里，**没有对应的服务端字段**，
 * 搬过来只会是一个不同步的副本。
 */
import type { Bot } from '../../api/types.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerRequest,
  type NativePickerSection,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import type { ErrorPresentation } from '../errors/present.ts';
import { agentPlaceholderKey } from './label.ts';

/** 结论：选了某个 bot、要新建一个、或要进当前 bot 的设置。取消就是 `cancelled`。 */
export type BotSwitchResult =
  { kind: 'bot'; botId: string } | { kind: 'new' } | { kind: 'settings'; botId: string };

export interface BotSwitchPickerParams {
  bots: Bot[];
  botsLoading: boolean;
  botsError: ErrorPresentation | null;
  /** 当前 agent（打勾用的）。null = 还没选中/还没拉到。 */
  currentBotId: string | null;
  /** 能不能管理**当前**这个 bot（`features/bots/permissions.ts` 的判据，调用方已经判好）。 */
  canManageCurrent: boolean;
}

export function presentBotSwitchPicker(
  params: BotSwitchPickerParams,
): Promise<PresentationResult<BotSwitchResult>> {
  const { bots, botsError, botsLoading, canManageCurrent, currentBotId } = params;

  const actions: NativePickerSection['rows'] = [
    {
      id: 'new',
      label: t('bots.create'),
      valueJson: JSON.stringify({ kind: 'new' } satisfies BotSwitchResult),
    },
  ];
  // 没有 `manage` 的人不出现这一行（见文件头表格第 3 条）。
  if (canManageCurrent && currentBotId !== null) {
    actions.push({
      id: 'settings',
      label: t('botSettings.open'),
      valueJson: JSON.stringify({
        kind: 'settings',
        botId: currentBotId,
      } satisfies BotSwitchResult),
    });
  }

  const request: NativePickerRequest = {
    // 原页这一行是分组标题；原生契约里 sheet 有一行标题，正好放它。
    title: t('bots.group'),
    sections: [
      {
        id: 'bots',
        rows:
          bots.length === 0
            ? [
                // 一个 bot 都没有（或还没拉到）也要给结论。原页这里是卡片里一段文案，而原生
                // 只在"一行都没有"时才画 `emptyLabel`——这一组之外还有动作行，所以那一条
                // 走不到，于是把它画成一行不可选的占位（灰态读起来正好是"这里没有东西"）。
                {
                  id: 'placeholder',
                  label: t(agentPlaceholderKey({ loading: botsLoading, failure: botsError })),
                  disabled: true,
                  valueJson: '',
                },
              ]
            : bots.map((bot) => {
                const blocked = bot.check_state === 'issue';
                return {
                  id: bot.id,
                  label: bot.display_name !== '' ? bot.display_name : bot.name,
                  detail: blocked ? t('bots.issue', { count: bot.check_issue_count }) : '',
                  selected: bot.id === currentBotId,
                  // 有毛病的行**灰掉且不响应**（原生照 `disabled` 画）：判据是 `check_state`，
                  // 不是 `bot.status === 'error'`——那个值服务端永远不会给（见文件头表格）。
                  disabled: blocked,
                  // 行值就是结论本身。
                  valueJson: JSON.stringify({
                    kind: 'bot',
                    botId: bot.id,
                  } satisfies BotSwitchResult),
                };
              }),
      },
      { id: 'actions', rows: actions },
    ],
    // 不设 `emptyLabel`：这一页永远至少有一行（动作行，或上面那条占位），
    // 原生只在"一行都没有"时才画它——设了也是死字段。
  };

  return presentNativePicker<BotSwitchResult>(request);
}
