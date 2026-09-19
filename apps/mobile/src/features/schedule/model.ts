/**
 * 定时任务的领域模型：把服务端的 JSON 收成一组有类型的值，以及"写回时该怎么发"。
 *
 * ## 为什么这里要单独一层
 *
 * 服务端两处形状**不一样**，而且这是最容易写错的一处：
 *
 * - `POST`（新建）把执行参数**平铺**在顶层（Go 的 `CreateRequest` 直接内嵌 `ExecutionConfig`）；
 * - `PUT`（修改）用的是**嵌套**的 `execution` 对象，而且是**整块替换**——只改其中一项也要
 *   把另外八项一起发回去，否则它们会被清空（Go 注释写得很明确：块里字段之间有交叉约束，
 *   服务端只接受"完整状态"）。
 * - `GET`（读取）又是**平铺**的（`Schedule` 内嵌同一个结构）。
 *
 * 所以在客户端必须显式做两件事：**读的时候把平铺的九个字段收成一个对象**，
 * **写的时候按动词选平铺还是嵌套**。把这件事留给各个界面各自的 `fetch` 一定会漏。
 */
/** 执行参数块。九个字段一一对应服务端 `ExecutionConfig`（`internal/schedule/types.go`）。 */
export interface ScheduleExecution {
  runTarget: string;
  targetSessionId: string;
  runtimeType: string;
  botAgentId: string;
  acpAgentId: string;
  modelId: string;
  acpModelId: string;
  reasoningEffort: string;
  workdirId: string;
}

export interface Schedule {
  id: string;
  name: string;
  description: string;
  /** cron 五段。 */
  pattern: string;
  /** 上限；`null` = 不限。注意"不限"与"0"不是一回事。 */
  maxCalls: number | null;
  /** 已经跑过多少次（服务端算好的，只读）。 */
  currentCalls: number;
  enabled: boolean;
  /** 到点发给 agent 的**消息文本**，不是 shell 命令。 */
  command: string;
  botId: string;
  createdAt: string;
  updatedAt: string;
  execution: ScheduleExecution;
}

export interface ScheduleLog {
  scheduleId: string;
  status: string;
  startedAt: string;
  /** 空 = 还没跑完。**这是判断"正在跑"的唯一依据**，见 `lastRunState`。 */
  completedAt: string | null;
  errorMessage: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeSchedule(raw: Record<string, unknown>): Schedule {
  return {
    id: str(raw.id),
    name: str(raw.name),
    description: str(raw.description),
    pattern: str(raw.pattern),
    // `max_calls` 是 `omitempty` 的指针：没设上限时这个键**根本不在响应里**，
    // 所以"缺失"必须读成 null（不限），不能读成 0（那会变成一个立刻停掉的任务）。
    maxCalls: num(raw.max_calls),
    currentCalls: num(raw.current_calls) ?? 0,
    enabled: raw.enabled === true,
    command: str(raw.command),
    botId: str(raw.bot_id),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    execution: {
      runTarget: str(raw.run_target),
      targetSessionId: str(raw.target_session_id),
      runtimeType: str(raw.runtime_type),
      botAgentId: str(raw.bot_agent_id),
      acpAgentId: str(raw.acp_agent_id),
      modelId: str(raw.model_id),
      acpModelId: str(raw.acp_model_id),
      reasoningEffort: str(raw.reasoning_effort),
      workdirId: str(raw.workdir_id),
    },
  };
}

/**
 * 新建用的请求体：执行参数**平铺**。
 *
 * `max_calls` 显式给 `null` 表示"不限"；给数字表示上限。
 */
export function createPayload(input: {
  name: string;
  description: string;
  pattern: string;
  command: string;
  enabled: boolean;
  maxCalls: number | null;
  execution: ScheduleExecution;
}): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    pattern: input.pattern,
    command: input.command,
    enabled: input.enabled,
    max_calls: input.maxCalls,
    run_target: input.execution.runTarget,
    target_session_id: input.execution.targetSessionId,
    runtime_type: input.execution.runtimeType,
    bot_agent_id: input.execution.botAgentId,
    acp_agent_id: input.execution.acpAgentId,
    model_id: input.execution.modelId,
    acp_model_id: input.execution.acpModelId,
    reasoning_effort: input.execution.reasoningEffort,
    workdir_id: input.execution.workdirId,
  };
}

/**
 * 修改用的请求体：`execution` **嵌整套**，其余字段只带要改的。
 *
 * 为什么"其余字段只带要改的"：`PUT` 是 patch（Go 里那些字段是指针，省略=不改）。
 * 为什么 execution 反过来要整块：见文件头。
 *
 * `maxCalls` 用三态：`undefined`=不改，`null`=取消上限，数字=设上限。
 */
export function updatePayload(input: {
  name?: string;
  description?: string;
  pattern?: string;
  command?: string;
  enabled?: boolean;
  maxCalls?: number | null;
  execution?: ScheduleExecution;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.pattern !== undefined) body.pattern = input.pattern;
  if (input.command !== undefined) body.command = input.command;
  if (input.enabled !== undefined) body.enabled = input.enabled;
  if (input.maxCalls !== undefined) body.max_calls = input.maxCalls;
  if (input.execution !== undefined) {
    body.execution = {
      run_target: input.execution.runTarget,
      target_session_id: input.execution.targetSessionId,
      runtime_type: input.execution.runtimeType,
      bot_agent_id: input.execution.botAgentId,
      acp_agent_id: input.execution.acpAgentId,
      model_id: input.execution.modelId,
      acp_model_id: input.execution.acpModelId,
      reasoning_effort: input.execution.reasoningEffort,
      workdir_id: input.execution.workdirId,
    };
  }
  return body;
}

/**
 就地启停的**状态转移**：乐观改 + 失败拨回。

 抽成纯函数是因为它是"界面会不会撒谎"的那一处判据：开关拨下去立刻要响应（等一个来回
 会显得卡），而**请求失败必须回到原值**——否则界面在撒谎。它原来是 `useSchedule` 里
 两段内联的 `map`，而 hook 在这个仓库没有测试面（`pnpm test` 跑的是纯模块，没有渲染器），
 所以判据抽到这里来，能在 node 侧钉住（见 `tests/schedule-toggle.test.mjs`）。

 `items === null`（列表还没拉回来）时原样返回 `null`：那时候没有开关可拨。
 */
export function withEnabled(
  items: Schedule[] | null,
  id: string,
  enabled: boolean,
): Schedule[] | null {
  return items?.map((item) => (item.id === id ? { ...item, enabled } : item)) ?? null;
}

export function normalizeLog(raw: Record<string, unknown>): ScheduleLog {
  const completedAt = str(raw.completed_at);
  return {
    scheduleId: str(raw.schedule_id),
    status: str(raw.status),
    startedAt: str(raw.started_at),
    completedAt: completedAt === '' ? null : completedAt,
    errorMessage: str(raw.error_message),
  };
}

/**
 * 一次拿回全部任务的日志，按 `schedule_id` 归并出"最近一次"。
 *
 * 为什么在这里归并而不是逐条任务查：任务列表本身**没有** `last_run` 字段，
 * 而 `/schedule/logs` 是一次调用就能拿全的聚合端点——按任务逐个查会变成 N 次请求，
 * 任务多的时候这就是首屏最慢的一环。
 */
export function lastRuns(logs: ScheduleLog[]): Record<string, ScheduleLog> {
  const out: Record<string, ScheduleLog> = {};
  for (const log of logs) {
    if (log.scheduleId === '') continue;
    const current = out[log.scheduleId];
    if (current === undefined || Date.parse(log.startedAt) > Date.parse(current.startedAt)) {
      out[log.scheduleId] = log;
    }
  }
  return out;
}

export type LastRunState = 'ok' | 'failed' | 'running' | 'unknown';

/**
 * 把一次执行收成四态。认不出来的一律 `unknown`，不猜"成功"。
 *
 * ⚠️ **不能只看 `status`**：服务端从不发 `running`——正在跑的那次是 `status='ok'`
 * 且 `completed_at` 为空（dev 实例上抓到过这样一行）。只看 status 会把"正在跑"
 * 显示成"成功"，而这个列表最容易撒的谎就是这个。
 */
export function lastRunState(status: string, completedAt?: string | null): LastRunState {
  if (completedAt === null || completedAt === '') return 'running';
  switch (status) {
    case 'ok':
    case 'success':
    case 'completed':
      return 'ok';
    case 'error':
    case 'failed':
    case 'failure':
      return 'failed';
    case 'running':
    case 'started':
      return 'running';
    default:
      return 'unknown';
  }
}
