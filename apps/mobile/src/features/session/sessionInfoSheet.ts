/**
 * 会话信息面板：**组装原生只读面板的模型**（`layout: 'info'`）。
 *
 * 这一份替掉 `ui/SessionInfoPage.tsx`（那张 RN sheet 已删除）。搬走的只有"画"，
 * 原页那三条判据一条都没丢：
 *
 * 1. **不编数**：有没有上下文窗口**由这里判**（`features/session/sessionInfo.ts` 的
 *    `sessionInfoView`）。有窗口才下发那条进度行；没有窗口就只报绝对值，并在分组脚注里
 *    说清为什么没有比例（"没有分母的百分比是编出来的"——原页文件头第 2 条硬规则）。
 * 2. **打开就拉一次**：`/status` 必须是"现在的"，不能是进会话时那一份。所以
 *    `onPresented` 里先 `refresh()` 再重画（原页是进页面时的一次 effect）。
 * 3. **拉失败分两种**：手里**没有数**时才画错误块（能不能重试由 `presentError` 那套
 *    白名单判）；已经有数时一次刷新失败**不改界面**——那会把"有数据但没刷新上"说成
 *    "读不到"。
 *
 * 只读面板没有"结论"：它靠下滑关掉（`cancelled`）。唯一可点的是"立即压缩"那一行
 * （`staysOpen`，由这里结算：压完重拉数字再重画）。
 */
import type { SessionStatus } from '../../models/chat.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
  type NativePickerRow,
  type NativePickerSection,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import { canRetry, presentError, reasonKeyOf, type ErrorPresentation } from '../errors/present.ts';
import {
  compactFailureOf,
  compactOutcomeOf,
  compactSummaryText,
  type CompactOutcome,
  type CompactResult,
} from './compaction.ts';
import { formatPercent, formatTokenCount, sessionInfoView } from './sessionInfo.ts';

/** 这一屏只用得上"手动压缩"这一个方法（与 `features/chat/models.ts` 的 `CatalogSource` 同一条规矩）。 */
export interface SessionCompactSource {
  compactSession(botId: string, sessionId: string): Promise<CompactResult>;
}

export interface SessionInfoParams {
  sessionId: string;
  /**
   * 读一份当前状态。
   *
   * 为什么是"读"而不是"传一份值进来"：压缩与刷新都会改它，而面板要画的是**改完之后**那份。
   * 调用方给的是 store 里的读取函数（`useSession().sessionStatusFor`），所以每次重画都拿最新的。
   */
  readStatus: () => SessionStatus | null;
  /** 拉一次最新的 `/status`（原页一进来就 refresh）。 */
  refresh: () => Promise<void>;
  /** 压缩的来源；`client` / `botId` 缺一个就不提供这个动作（深链进来、会话还没落地）。 */
  compact: { client: SessionCompactSource; botId: string } | null;
}

/** 面板上唯一一个动作（压缩）。只读面板本身没有结论，调用方也不看这个值。 */
export interface SessionInfoAction {
  action: 'compact';
}

export function presentSessionInfo(
  params: SessionInfoParams,
): Promise<PresentationResult<SessionInfoAction>> {
  const { compact, readStatus, refresh, sessionId } = params;

  let status: SessionStatus | null = readStatus();
  let failure: ErrorPresentation | null = null;
  /** 手动压缩：busy + 结论。它是写操作，状态留在这一层（原生只管画）。 */
  let busy = false;
  let outcome: CompactOutcome | null = null;

  const buildRequest = (): NativePickerRequest => {
    const view = sessionInfoView(status);
    const compactText = outcome === null ? null : compactTextOf(outcome);
    const sections: NativePickerSection[] = [];

    if (status !== null) {
      sections.push({
        id: 'context',
        header: t('sessionInfo.group.context'),
        layout: 'info',
        // 压缩结论是"这一组刚才发生了什么"，挂在上下文这一组的脚注上（原页也在同一位置）。
        footer: compactText ?? '',
        rows: contextRows(view, compact, busy),
      });
      sections.push({
        id: 'session',
        header: t('sessionInfo.group.session'),
        layout: 'info',
        // 没有窗口时说明为什么这一屏没有比例（原页的分组 footer，一字不差）。
        footer: view.contextWindow === null ? t('sessionInfo.noWindowFooter') : '',
        rows: [
          {
            id: 'session-info-messages',
            label: t('sessionInfo.messages'),
            value: formatTokenCount(view.messageCount),
            valueJson: '',
          },
        ],
      });
      sections.push({
        id: 'cache',
        header: t('sessionInfo.group.cache'),
        layout: 'info',
        rows: [
          infoRow(
            'session-info-hit-rate',
            t('sessionInfo.hitRate'),
            formatPercent(view.cacheHitRate),
          ),
          infoRow(
            'session-info-cache-read',
            t('sessionInfo.cacheRead'),
            formatTokenCount(view.cacheReadTokens),
          ),
          infoRow(
            'session-info-input',
            t('sessionInfo.input'),
            formatTokenCount(view.totalInputTokens),
          ),
        ],
      });
      sections.push({
        id: 'skills',
        header: t('sessionInfo.group.skills'),
        layout: 'info',
        // 一个技能都没用过时说一句（原页的 footer），不画一片空白。
        footer: view.skills.length === 0 ? t('sessionInfo.skills.empty') : '',
        rows: view.skills.map((name) => ({
          id: `session-skill-${name}`,
          label: name,
          valueJson: '',
        })),
      });
    }

    return {
      title: t('sessionInfo.title'),
      sections,
      status: statusOf(status, failure),
      loadingLabel: t('sessionInfo.loading'),
      errorTitle: t('sessionInfo.loadFailed'),
      errorBody: failure === null ? '' : t(reasonKeyOf(failure)),
      retryLabel: failure !== null && canRetry(failure) ? t('common.retry') : '',
    };
  };

  /**
   拉一次最新状态。

   失败**不清已有的数**（`readStatus` 是 store 里那份，失败时它原样不动）——原页同一条：
   已经有数的情况下，一次刷新失败不该把面板变成一片红。
   */
  const load = async (handle: NativePickerHandle) => {
    try {
      await refresh();
      failure = null;
    } catch (caught) {
      failure = presentError(caught);
    }
    status = readStatus();
    handle.update(buildRequest());
  };

  const runCompact = (handle: NativePickerHandle) => {
    if (compact === null || busy) return;
    busy = true;
    outcome = null;
    handle.update(buildRequest());
    void (async () => {
      try {
        const result = await compact.client.compactSession(compact.botId, sessionId);
        busy = false;
        outcome = compactOutcomeOf(result);
        // 压缩真的动了上下文，所以面板上的数字必须**重新拉**——不拉的话用户看到的还是
        // 压缩前那一份，会以为刚才那一按什么都没发生。
        await refresh().catch(() => undefined);
        status = readStatus();
      } catch (caught) {
        busy = false;
        outcome = compactFailureOf(caught);
      }
      handle.update(buildRequest());
    })();
  };

  return presentNativePicker<SessionInfoAction>(buildRequest(), {
    onPresented: (handle) => {
      void load(handle);
    },
    onSelect: (valueJson, handle) => {
      // 这一屏只有"压缩"一个动作，而且**由这里结算**（要发请求、要重拉），所以整行都
      // `staysOpen`：原生提前收掉的话，一次压缩的结果就没有地方可以画了。
      if (readAction(valueJson) === 'compact') runCompact(handle);
      return true;
    },
    onRetry: (handle) => {
      // 重试走的是与首次完全相同的一条路（同样清掉上一次的失败）。
      failure = null;
      handle.update(buildRequest());
      void load(handle);
    },
  });
}

/** 上下文那一组：有分母才有进度行，没有分母就只有绝对值（见文件头第 1 条）。 */
function contextRows(
  view: ReturnType<typeof sessionInfoView>,
  compact: SessionInfoParams['compact'],
  busy: boolean,
): NativePickerRow[] {
  const rows: NativePickerRow[] = [];

  // 有窗口才有比例。没有分母时这一行不出现——不是显示 0%。
  if (view.contextPercent !== null) {
    rows.push({
      id: 'session-info-context',
      label: t('sessionInfo.contextUsage'),
      // 条的比例是 0…1 的字符串（原生不重算百分比）；右边那串百分比文案是 RN 算好的。
      value: String(view.contextPercent / 100),
      detail: formatPercent(view.contextPercent),
      kind: 'progress',
      valueJson: '',
    });
  }

  rows.push(
    infoRow('session-info-used', t('sessionInfo.usedTokens'), formatTokenCount(view.usedTokens)),
  );
  if (view.contextWindow !== null) {
    rows.push(
      infoRow('session-info-window', t('sessionInfo.window'), formatTokenCount(view.contextWindow)),
    );
  }
  if (view.autoCompactTokens !== null) {
    rows.push(
      infoRow(
        'session-info-auto-compact',
        t('sessionInfo.autoCompact'),
        formatTokenCount(view.autoCompactTokens),
      ),
    );
  }

  // 立即压缩：它作用的对象就是上下文，所以留在这一组里（原页同一条）。
  if (compact !== null) {
    rows.push({
      id: 'session-info-compact',
      // busy 时换成"保存中"并置灰：服务端是同步跑完才回，没有进度可报，但必须让人知道
      // "这一按已经发出去了"（原页是在按钮里画一颗转圈）。
      label: busy ? t('botSettings.saving') : t('sessionInfo.compact'),
      disabled: busy,
      staysOpen: true,
      valueJson: JSON.stringify({ action: 'compact' } satisfies SessionInfoAction),
    });
  }

  return rows;
}

/** 一条只读行（`label + value`）。 */
function infoRow(id: string, label: string, value: string): NativePickerRow {
  return { id, label, value, valueJson: '' };
}

/** 现在是什么状态。**手里没有数**时失败才配画成错误页（见文件头第 3 条）。 */
function statusOf(
  status: SessionStatus | null,
  failure: ErrorPresentation | null,
): 'ready' | 'loading' | 'error' {
  if (status !== null) return 'ready';
  if (failure === null) return 'loading';
  return 'error';
}

/** 压缩结果那一行。文案 key 由纯逻辑给（见 `features/session/compaction.ts`）。 */
function compactTextOf(outcome: CompactOutcome): string | null {
  const line = compactSummaryText(outcome);
  if (line === null) return null;
  // `unavailable` 带着服务端写的原因（哪个模型不可用），原样附在后面——那是唯一能
  // 告诉用户"该怎么办"的信息。
  if (outcome.kind === 'unavailable' && outcome.reason !== '') {
    return `${t(line.key)}${outcome.reason}`;
  }
  return line.values === undefined ? t(line.key) : t(line.key, line.values);
}

/** 行值解析。认不出就回 null（这一行我们不知道它要做什么）。 */
function readAction(valueJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const action = (parsed as { action?: unknown }).action;
    return typeof action === 'string' ? action : null;
  } catch {
    return null;
  }
}
