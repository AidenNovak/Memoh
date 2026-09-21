/**
 * 定时任务的取数与写回。
 *
 * 三件事各自独立，所以分成三个 hook，而不是一个大 store：
 *
 * - `useSchedules`：列表 + 一次聚合拿回"最近一次结果"；
 * - `toggleSchedule`：列表行上的就地启停（L2，改一个字段就够，走 patch）；
 * - `useScheduleEditor`：编辑页的草稿与保存（新建走 create 的平铺形状，修改走嵌套 execution）。
 *
 * ## 一个必须遵守的顺序
 *
 * 保存修改时，**`execution` 整块要回写**（服务端只接受完整状态）。所以编辑页必须先把
 * `GET /schedule/{id}` 拿到的九个字段收进草稿，保存时原样发回——只改用户真的改过的那一项。
 * 漏掉这一步的表现是"改了个名字，把模型覆盖和推理强度清空了"，而且不会有任何报错。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MemohClient } from '../../api/client.ts';
import { presentError, type ErrorPresentation } from '../errors/present.ts';
import {
  createPayload,
  lastRuns,
  normalizeLog,
  normalizeSchedule,
  updatePayload,
  withEnabled,
  type Schedule,
  type ScheduleExecution,
  type ScheduleLog,
} from './model.ts';

interface LoadState<T> {
  data: T | null;
  loading: boolean;
  /**
   失败要说清是"拉不到"，不是"没有任务"——后者会让用户以为任务被删了。

   存的是 `presentError()` 的结论而不是一个字符串：**"能不能重试"必须跟着错误的性质走**
   （没网 → 给重试；凭据失效 → 说重新登录；服务端明确拒绝 → 不给动作）。
   存字符串的话，屏那边只能靠猜，猜错的形态就是"点一百次也不会好"。
   */
  error: ErrorPresentation | null;
  /**
   这一次失败是**哪件事**失败：拉列表，还是拨开关。

   两件事的标题不同（"定时任务没拉到" vs "这次开关没改成功"），而动作也不同——
   拨开关失败时用户手上就有那个开关，面板上再挂一个"重试"是多余的一步。
   */
  errorKind: 'list' | 'toggle' | null;
}

function itemsOf(raw: unknown): Record<string, unknown>[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

export function useSchedules(client: MemohClient | null, botId: string | null) {
  const [state, setState] = useState<LoadState<Schedule[]>>({
    data: null,
    loading: false,
    error: null,
    errorKind: null,
  });
  const [logs, setLogs] = useState<ScheduleLog[]>([]);

  const load = useCallback(async () => {
    if (client === null || botId === null) return;
    setState((prev) => ({ ...prev, loading: true, error: null, errorKind: null }));
    try {
      // 两个请求一起发：日志是列表要用的第二份数据，串行会让首屏慢一倍。
      const [list, logPage] = await Promise.all([
        client.listSchedules(botId),
        client.listScheduleLogs(botId, { limit: 50 }),
      ]);
      setState({
        data: itemsOf(list).map(normalizeSchedule),
        loading: false,
        error: null,
        errorKind: null,
      });
      setLogs(itemsOf(logPage).map(normalizeLog));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: presentError(error),
        errorKind: 'list',
      }));
    }
  }, [botId, client]);

  useEffect(() => {
    void load();
  }, [load]);

  const lastBySchedule = useMemo(() => lastRuns(logs), [logs]);

  /** 就地启停。乐观更新：开关是立刻要响应的控件，等一个来回再动会显得卡。 */
  const toggleEnabled = useCallback(
    async (schedule: Schedule, enabled: boolean) => {
      if (client === null || botId === null) return;
      setState((prev) => ({
        ...prev,
        data: withEnabled(prev.data, schedule.id, enabled),
      }));
      try {
        await client.updateSchedule(botId, schedule.id, updatePayload({ enabled }));
      } catch (error) {
        // 失败要把开关拨回去，否则界面在撒谎。
        setState((prev) => ({
          ...prev,
          data: withEnabled(prev.data, schedule.id, schedule.enabled),
          error: presentError(error),
          errorKind: 'toggle',
        }));
      }
    },
    [botId, client],
  );

  return { ...state, lastBySchedule, reload: load, toggleEnabled };
}

export interface ScheduleDraft {
  name: string;
  description: string;
  pattern: string;
  command: string;
  enabled: boolean;
  /** `null` = 不限。 */
  maxCalls: number | null;
  execution: ScheduleExecution;
}

const EMPTY_EXECUTION: ScheduleExecution = {
  runTarget: 'new_session',
  targetSessionId: '',
  runtimeType: '',
  botAgentId: '',
  acpAgentId: '',
  modelId: '',
  acpModelId: '',
  reasoningEffort: '',
  workdirId: '',
};

/** 新建时的默认草稿：每天 09:00、新会话、启用。 */
export function emptyDraft(): ScheduleDraft {
  return {
    name: '',
    description: '',
    pattern: '0 9 * * *',
    command: '',
    enabled: true,
    maxCalls: null,
    execution: { ...EMPTY_EXECUTION },
  };
}

export function draftOf(schedule: Schedule): ScheduleDraft {
  return {
    name: schedule.name,
    description: schedule.description,
    pattern: schedule.pattern,
    command: schedule.command,
    enabled: schedule.enabled,
    maxCalls: schedule.maxCalls,
    execution: { ...schedule.execution },
  };
}

export function useScheduleEditor(
  client: MemohClient | null,
  botId: string | null,
  scheduleId: string | null,
) {
  const [draft, setDraft] = useState<ScheduleDraft>(emptyDraft);
  const [loading, setLoading] = useState(scheduleId !== null);
  /**
   * 这一刻是不是正有一次在跑。
   *
   * 只为了删除确认里那句话：服务端删任务**不会**取消已经在跑的那一轮
   * （`context.WithoutCancel`），而那一轮的日志会随任务 CASCADE 删掉。用户按删除前
   * 有权知道这件事，否则他会以为删除等于取消。
   */
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 取数失败与保存失败共用一块：形状相同（标题由屏给），但原因来自服务端。 */
  const [error, setError] = useState<ErrorPresentation | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (client === null || botId === null || scheduleId === null) {
      setDraft(emptyDraft());
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    void (async () => {
      try {
        const raw = await client.getSchedule(botId, scheduleId);
        if (!cancelled) setDraft(draftOf(normalizeSchedule(raw)));
        // 顺手看一眼日志：只是为了那句"正在跑"。拿不到就不说（宁可少一句，不猜）。
        try {
          const logs = await client.listScheduleLogs(botId, { limit: 20 });
          const items = Array.isArray((logs as { items?: unknown }).items)
            ? (logs as { items: Record<string, unknown>[] }).items
            : [];
          const latest = lastRuns(
            items.map(normalizeLog).filter((log) => log.scheduleId === scheduleId),
          )[scheduleId];
          if (!cancelled) setRunning(latest !== undefined && latest.completedAt === null);
        } catch {
          if (!cancelled) setRunning(false);
        }
      } catch (err) {
        if (!cancelled) setError(presentError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId, client, scheduleId]);

  const patch = useCallback((next: Partial<ScheduleDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  /**
   * 保存。返回保存后的任务（新建时就是要拿回 id），失败返回 null 并且 `error` 里有原因。
   *
   * 保存失败**不给"重试"按钮**：Save 就在屏幕上，用户再按一次就是重试；
   * 面板上再挂一个只是把同一个动作说两遍（见 `docs/research/ios-error-and-feedback.md` R19）。
   */
  const save = useCallback(
    async (override: Partial<ScheduleDraft> = {}): Promise<Schedule | null> => {
      if (client === null || botId === null) return null;
      setSaving(true);
      setError(null);
      const nextDraft = { ...draft, ...override };
      try {
        const saved =
          scheduleId === null
            ? await client.createSchedule(botId, createPayload(nextDraft))
            : await client.updateSchedule(
                botId,
                scheduleId,
                updatePayload({
                  name: nextDraft.name,
                  description: nextDraft.description,
                  pattern: nextDraft.pattern,
                  command: nextDraft.command,
                  enabled: nextDraft.enabled,
                  maxCalls: nextDraft.maxCalls,
                  // 整块回写：只改用户改过的项，其余原样带回去（见文件头）。
                  execution: nextDraft.execution,
                }),
              );
        return normalizeSchedule(saved);
      } catch (err) {
        setError(presentError(err));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [botId, client, draft, scheduleId],
  );

  return { draft, patch, loading, saving, error, running, save };
}
