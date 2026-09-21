/**
 * 「运行位置」选择器：新会话 / 复用某个已有会话。
 *
 * 这一份替掉 `ui/RunTargetPickerPage.tsx`（那张 RN sheet 已删除）。**约束一条没动**：
 * `run_target = existing_session` 与一个非空的 `target_session_id` 必须同时成立，
 * 判据仍然由 `features/schedule/runTarget.ts` 的 `checkRunTarget` 把着——这里每一次
 * 要给出结论之前都先过一遍它（编辑页读的是同一份判断）。
 *
 * ## 这一页为什么要用 `onSelect` 拦一道
 *
 * 其余 6 个选择器是"点一行 = 选中它"，所以它们直接吃原生的 `select`（解析 `valueJson`
 * 就结算）。这一页不是：
 *
 * 1. **两段式**（原页的形状）：先选"新会话 / 复用已有"，复用时才列会话。点"复用已有"
 *    不是一个结论，只是换一屏内容。
 * 2. **要校验**：会话 id 与 `run_target` 必须一起合法（见上）。
 * 3. **"再拉一批"是一行动作**，不是一项选择（`GET /sessions` 默认一页 50 条，而定时任务
 *    经常复用一个很久以前建的会话——它很可能不在第一页）。
 *
 * 所以这里每一行的 `valueJson` 都带一个 `action` 标记，`onSelect` 按它分派：动作行自己处理，
 * 选择行过完校验再 `finish()`。**每一行都标了 `staysOpen`**：结算只能由 RN 做——原生若在
 * 校验之前就把 sheet 收掉，一次"校验没过"的点击会让那次出席永远等不到结论。
 * **行值仍然是不透明的**（原生只回传，不解析）。
 *
 * ## 与原页的差别（明说）
 *
 * | 原页 | 这里 |
 * | --- | --- |
 * | 顶部一个"完成"按钮，未选会话时置灰 + 一行问题说明 | 没有顶部按钮：选一行就是结论（选择即提交），校验在 `finish` 前把关 |
 * | 会话列表下面一行脚注（"50 条以前的按需拉取"） | 不画（契约里没有脚注位），意思由"再拉一批"那一行承担 |
 * | 列表加载中转圈 / 失败一行红字 | 交给 `status`（`loading` / `error` + 重试钮） |
 *
 * 会话列表的加载/失败是**整张 sheet 的状态**（契约里 `status` 只有一份）：加载中或失败时
 * 用户看到的是状态而不是上面那两行"运行位置"。失败态给了重试钮，且下滑关掉随时可退。
 */
import type { Session } from '../../api/types.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
  type NativePickerSection,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import { canRetry, presentError, reasonKeyOf, type ErrorPresentation } from '../errors/present.ts';
import { sessionSourceFromApi } from '../session/sourceLabel.ts';
import { checkRunTarget, sessionLabel, type RunTarget } from './runTarget.ts';

/** 这一页只用得上"列会话"这一个方法（与 `features/chat/models.ts` 的 `CatalogSource` 同一条规矩）。 */
export interface SessionListSource {
  listSessions(
    botId: string,
    options: { limit?: number; cursor?: string },
  ): Promise<{ items?: Session[]; next_cursor?: string }>;
}

export interface RunTargetPickerParams {
  client: SessionListSource | null;
  /** 会话列表是按 bot 分的；null = 还没有当前 bot，这时不开这张 sheet。 */
  botId: string | null;
  runTarget: string;
  targetSessionId: string;
}

export interface RunTargetPickerResult {
  runTarget: RunTarget;
  targetSessionId: string;
}

const PAGE_SIZE = 50;

/**
 行值里的动作标记。

 行值是不透明字符串，原生不解析它——**这一层怎么编码只有这里知道**。四种行对应四种动作，
  `onSelect` 按它分派（见文件头）。
 */
type RowAction = 'new' | 'mode' | 'session' | 'more';

interface PickerRow {
  action?: RowAction;
  targetSessionId?: string;
}

export function presentRunTargetPicker(
  params: RunTargetPickerParams,
): Promise<PresentationResult<RunTargetPickerResult>> {
  const { botId, client } = params;
  if (client === null || botId === null) return Promise.resolve({ status: 'cancelled' });

  /** 当前选的是哪一档。初始值只认 `existing_session`，别的（空、坏值）都当新会话。 */
  let runTarget: RunTarget =
    params.runTarget === 'existing_session' ? 'existing_session' : 'new_session';
  /** 已生效的会话 id（进来时草稿里那个）。它在选择器里只用来打勾——选一行就是结论。 */
  const targetSessionId = params.targetSessionId;

  let sessions: Session[] | null = null;
  let cursor: string | null = null;
  let loadingMore = false;
  let failure: ErrorPresentation | null = null;

  const buildRequest = (): NativePickerRequest => {
    const check = checkRunTarget({ runTarget, targetSessionId });
    const groups: NativePickerSection[] = [
      {
        id: 'mode',
        header: t('schedule.runTarget.group'),
        rows: [
          {
            id: 'new-session',
            label: t('schedule.runTarget.newSession'),
            detail: t('schedule.runTarget.newSession.hint'),
            selected: runTarget === 'new_session',
            // 这一页**每一行都由 RN 结算**（要过校验），所以连"就是它了"这一行也 `staysOpen`：
            // 原生提前收掉的话，万一校验不过就没有人再去结算那次出席，调用方的 await 会永远悬着。
            staysOpen: true,
            valueJson: JSON.stringify({ action: 'new' } satisfies PickerRow),
          },
          {
            id: 'existing-session',
            label: t('schedule.runTarget.existingSession'),
            detail: t('schedule.runTarget.existingSession.hint'),
            selected: runTarget === 'existing_session',
            // **不是结论**：切过去只是把会话列表画出来（原页的两段式）。
            staysOpen: true,
            valueJson: JSON.stringify({ action: 'mode' } satisfies PickerRow),
          },
        ],
      },
    ];

    // 会话那一组只在"复用已有"时画（原页同一条）：选新会话的人不需要看一屏会话。
    if (runTarget === 'existing_session' && sessions !== null) {
      const list = sessions;
      /** 一行会话都没有：把"还要选一个会话"这句话摆出来（原页那行红字说的是同一句）。 */
      const nothingToPick: NativePickerSection['rows'] =
        list.length === 0 && cursor === null
          ? [
              {
                id: 'no-session',
                label: t(check.problemKey ?? 'schedule.runTarget.needsSession'),
                // 没有东西可点：画灰、不响应（点了也不会发生什么，别让它看起来像能点）。
                disabled: true,
                valueJson: '',
              },
            ]
          : [];
      groups.push({
        id: 'sessions',
        header: t('schedule.runTarget.sessions'),
        rows: [
          ...nothingToPick,
          ...list.map((session) => ({
            id: session.id,
            label: sessionLabel(session),
            // 副标题走和其它会话行同一个纯函数：这台部署服务端**不返回** channel_type，
            // 直接拼会让副标题变成" · chat"（见 `session/sourceLabel.ts`）。
            detail: sessionSourceFromApi(session),
            selected: session.id === targetSessionId,
            // 同上：结算前要先过 `checkRunTarget`，所以不交给原生自动收。
            staysOpen: true,
            valueJson: JSON.stringify({
              action: 'session',
              targetSessionId: session.id,
            } satisfies PickerRow),
          })),
          ...(cursor === null
            ? []
            : [
                {
                  id: 'more',
                  // 拉的时候把这一行换成"载入中"：没有它，点了之后到新行出现之间没有任何反馈。
                  label: loadingMore ? t('common.loading') : t('schedule.runTarget.more'),
                  // **不是结论**：这是一行动作，点完列表往下长一页，sheet 留在台上。
                  staysOpen: true,
                  valueJson: JSON.stringify({ action: 'more' } satisfies PickerRow),
                },
              ]),
        ],
      });
    }

    return {
      title: t('schedule.runTarget.title'),
      sections: groups,
      status: statusOf(runTarget, sessions, failure),
      loadingLabel: t('common.loading'),
      errorTitle: t('schedule.runTarget.loadFailed'),
      errorBody: failure === null ? '' : t(reasonKeyOf(failure)),
      retryLabel: failure !== null && canRetry(failure) ? t('common.retry') : '',
      // 空态那句话走不到（这一页永远有"运行位置"那两行），所以不设——需要解释的
      // "还没有会话可选"由上面对话组里那行不可选的占位承担。
      emptyLabel: '',
    };
  };

  const loadFirstPage = async (handle: NativePickerHandle) => {
    try {
      const page = await client.listSessions(botId, { limit: PAGE_SIZE });
      sessions = page.items ?? [];
      cursor = nextCursorOf(page);
      failure = null;
    } catch (caught) {
      failure = presentError(caught);
    }
    handle.update(buildRequest());
  };

  const loadMore = async (handle: NativePickerHandle) => {
    if (cursor === null || loadingMore) return;
    loadingMore = true;
    handle.update(buildRequest());
    try {
      const page = await client.listSessions(botId, { limit: PAGE_SIZE, cursor });
      sessions = [...(sessions ?? []), ...(page.items ?? [])];
      cursor = nextCursorOf(page);
    } catch (caught) {
      failure = presentError(caught);
    } finally {
      loadingMore = false;
    }
    handle.update(buildRequest());
  };

  /**
   给这一次出席下结论。**每一种结论都要先过 `checkRunTarget`**：
   校验不过就什么都不做（界面不动，用户还能改主意），而不是把一条服务端必然拒的草稿交出去。
   */
  const conclude = (next: RunTargetPickerResult, handle: NativePickerHandle) => {
    const verdict = checkRunTarget(next);
    if (!verdict.ok) return;
    handle.finish(next);
  };

  return presentNativePicker<RunTargetPickerResult>(buildRequest(), {
    onPresented: (handle) => {
      void loadFirstPage(handle);
    },
    onSelect: (valueJson, handle) => {
      const row = readRow(valueJson);
      // 认不出的行：不结算、也不动界面（宁可什么都不发生，也不要给出一个假结论）。
      if (row === null) return true;

      if (row.action === 'more') {
        void loadMore(handle);
        return true;
      }
      if (row.action === 'mode') {
        runTarget = 'existing_session';
        // 第一次切过来时列表可能还没到（或上次拉失败了）——重新拉一遍，别让用户盯着一张空表。
        if (sessions === null) void loadFirstPage(handle);
        else handle.update(buildRequest());
        return true;
      }
      if (row.action === 'session') {
        const sessionId = row.targetSessionId ?? '';
        conclude({ runTarget: 'existing_session', targetSessionId: sessionId }, handle);
        return true;
      }
      // `new`：切回新会话时**顺手清掉**残留的会话 id（见 `runTarget.ts` 文件头第 1 条）。
      conclude({ runTarget: 'new_session', targetSessionId: '' }, handle);
      return true;
    },
    onRetry: (handle) => {
      sessions = null;
      failure = null;
      handle.update(buildRequest());
      void loadFirstPage(handle);
    },
  });
}

/**
 这一次响应的"下一页游标"。

 `next_cursor` 是**空串**表示到底（`ListSessionsResponse` 的约定）。这里同时容忍"字段缺失"
 ——那说明对面版本旧/实现不全，把它当成到底比当成"还有"更安全（后者会让"再拉一批"永远挂着，
 点下去拿到空页）。
 */
function nextCursorOf(page: { next_cursor?: string }): string | null {
  const cursor = page.next_cursor;
  if (typeof cursor !== 'string' || cursor === '') return null;
  return cursor;
}

/** 行值解析。坏 JSON / 不是对象都回 null（这一行我们认不出来）。 */
function readRow(valueJson: string): PickerRow | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as PickerRow;
  } catch {
    return null;
  }
}

/**
 现在是什么状态。

 只有**用户正在看会话列表**时，加载/失败才配占住整张 sheet（契约里 `status` 只有一份）：
 选"新会话"的人不该因为会话列表拉不到而看到一张错误页。
 */
function statusOf(
  runTarget: RunTarget,
  sessions: Session[] | null,
  failure: ErrorPresentation | null,
): 'ready' | 'loading' | 'error' {
  if (runTarget !== 'existing_session' || sessions !== null) return 'ready';
  if (failure === null) return 'loading';
  return 'error';
}
