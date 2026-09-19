/**
 * 会话协调层：**计时器驱动的轮询 + run 结束的边沿检测**。
 *
 * ## 为什么要单独一层
 *
 * 这一段逻辑原来长在 `session/store.tsx` 里（一个 1000+ 行的 React 组件），三条路径
 * 全部靠 `setInterval` + `stateRef` 现读，**除了一整套真界面之外没有任何办法验它**：
 *
 *   1. 队列兜底轮询（10s，只在"有东西排队"时打服务端）
 *   2. 孤儿 run 巡检（15s，owner 死了但投影停在 running 时收尾）
 *   3. run 结束的边沿检测（跑着 → 不跑，**只触发一次**）
 *
 * 它们的失效方式全是**静默**的：轮询停了用户只是"队列永远显示还在排队"、边沿重复触发
 * 就是每渲染一次打三个请求、清理漏了就是卸载之后还在打服务端。没有断言就发现不了。
 *
 * 所以把这三条搬到这里，做到：
 *
 *   - **不 import react / react-native**——纯 TS，`node --test` 能直接 import；
 *   - **时间源、日志、网络（host 端口）全部注入**——测试用可推进的假时钟，不靠墙钟；
 *   - React 层退化成一个薄壳：装配 host、`start()` / `stop()`、以及每次 chats 变化调一次
 *     `observeRunState()`。
 *
 * ## 行为与重构前逐条对齐
 *
 * 三条路径的判据、触发时机、失败处理（队列读失败静默、状态读失败静默）都保持原样，
 * 连"巡检因何跳过"都按原来的 `return` 逐条对应。这是一次搬迁，不是改功能。
 */

import { isRunAbandoned, type ChatState } from './reducer-exports.ts';

/**
 * 队列兜底轮询的周期。
 *
 * 触发队列刷新主要是事件（入队、删除、run 状态变化）；这个定时器只覆盖"服务端把一条
 * follow-up 取走执行了、而客户端没接到任何帧"的情况。上游同样有一个 10s 兜底
 * （`QUEUE_FALLBACK_REFRESH_MS`），理由相同：让"还在排队"这件事不会永远显示下去。
 */
export const QUEUE_POLL_INTERVAL_MS = 10_000;

/** 孤儿 run 巡检的周期。 */
export const ORPHAN_RUN_POLL_INTERVAL_MS = 15_000;

/** 计时器句柄。RN 上是 number，Node 上是 `Timeout`——两边都用，所以不写死。 */
export type TimerHandle = ReturnType<typeof globalThis.setInterval>;

/**
 * 时间源。
 *
 * 注入它是为了**能测**：本仓库已经吃过一次亏——`realtime-weaknet.test.mjs` 里那条
 * 时序断言在负载下会假红（5 秒的墙钟等待），单独跑 4 次全绿。所以这里不给自己留
 * "等 10 秒看看"的余地：测试注入一个可以 `advance(ms)` 的假时钟，把"过多久才该发生"
 * 变成确定性断言。
 */
export interface TimerSource {
  setInterval(handler: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** 真实时间源：App 里用的就是这两个全局函数。 */
export const REAL_TIMERS: TimerSource = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * 一次决策的日志。
 *
 * 这里**只提供接缝，默认什么都不做**：重构前的组件在这三条路径上一个字都不打，
 * 顺手加日志就是改行为（还可能在发布构建里刷屏）。接缝的意义是字段排查——
 * "10s 的定时器到了但队列是空的所以没打服务端"这类判断，事后只能靠它复现。
 */
export interface CoordinatorLogRecord {
  /** 注入时钟读到的时刻（毫秒）。 */
  at: number;
  /** `queue-poll` / `orphan-poll` / `run-edge`。 */
  event: string;
  sessionId: string | null;
  /** 这一跳做了什么（或为什么没做）。 */
  outcome: string;
}

export type CoordinatorLog = (record: CoordinatorLogRecord) => void;

const NO_LOG: CoordinatorLog = () => {};

/**
 * 轮询要读的那几个字段。
 *
 * 刻意只留布尔与计数：协调层不需要理解 `ChatState`，它只需要知道"这个会话在不在跑、
 * 是不是已经被遗弃、队列里还有几条"。这样测试不必造一整个聊天状态出来，
 * 而"遗弃"的判据仍然只有一处（`chat/reducer.ts` 的 `isRunAbandoned`）。
 */
export interface CoordinatorView {
  currentSessionId: string | null;
  /** 当前会话的 chat 状态在不在（不在 = 还没 `openSession`）。 */
  runKnown: boolean;
  /** run 是否在跑。 */
  running: boolean;
  /** run 是否已被遗弃（owner 进程死了、投影永远停在 running）。 */
  abandoned: boolean;
  /** 当前会话的队列里还有几条待发项。 */
  pendingItems: number;
}

/**
 * 从一份 store 状态读出轮询视图（纯函数）。
 *
 * React 层每次 tick 现读一份最新的 —— 轮询**不能吃缓存**：`setInterval` 的回调里
 * 拿到的闭包变量永远是挂载那一刻的值，而那正是重构前每一处都用 `stateRef.current`
 * 现读的原因。这里把"现读"这件事交回给调用方，协调层只认这份快照。
 */
export function coordinatorView(state: {
  currentSessionId: string | null;
  chats: Record<string, ChatState>;
  queues: Record<string, { items: readonly unknown[] }>;
}): CoordinatorView {
  const sessionId = state.currentSessionId;
  if (sessionId === null) {
    return {
      currentSessionId: null,
      runKnown: false,
      running: false,
      abandoned: false,
      pendingItems: 0,
    };
  }
  const chat = state.chats[sessionId];
  return {
    currentSessionId: sessionId,
    runKnown: chat !== undefined,
    running: chat?.running ?? false,
    abandoned: chat !== undefined && isRunAbandoned(chat),
    pendingItems: state.queues[sessionId]?.items.length ?? 0,
  };
}

/**
 * 协调层要用到的宿主能力（网络与 dispatch 都在这里）。
 *
 * **网络就是这几个方法**：`refreshQueue` 打 `/queue`、`refreshHistory` 打
 * `/messages`、`refreshSessionStatus` 打 `/status`。测试注入的假实现只记录调用，
 * 于是"到底打了几次、什么时候打的"成了可断言的事实——这正是重构前拿不到的证据。
 */
export interface CoordinatorHost {
  /** 现读一份最新快照。轮询每次都要调它，不许自己缓存。 */
  view(): CoordinatorView;
  /** 重拉当前会话的待发队列。 */
  refreshQueue(sessionId: string): void;
  /** 重拉当前会话的历史（run 结束后服务端历史才是权威的）。 */
  refreshHistory(sessionId: string): void;
  /**
   * 重拉当前会话的信息。
   *
   * **必须自己吞掉失败**：调用方是后台刷新，它不影响任何操作，读不到就是面板里少几行。
   * （`store` 的实现在这里 `.catch(() => {})`，与重构前一致。）
   */
  refreshSessionStatus(sessionId: string): void;
  /** 把"owner 已消失"落成终态：dispatch 一次 `settleAbandonedRun`。 */
  settleAbandonedRun(sessionId: string): void;
}

export interface SessionCoordinator {
  /** 装上两个定时器。幂等：重复调用不会装第二套。 */
  start(): void;
  /** 卸掉两个定时器。幂等：卸载之后这两条路径不会再打一次服务端。 */
  stop(): void;
  /** 队列兜底轮询走一跳（正常由 `start()` 的定时器驱动）。 */
  pollQueueOnce(): void;
  /** 孤儿 run 巡检走一跳。 */
  pollOrphanRunOnce(): void;
  /** run 状态的边沿检测走一次（React 层每次 chats / 当前会话变化调它）。 */
  observeRunState(): void;
}

export function createSessionCoordinator(deps: {
  host: CoordinatorHost;
  timers?: TimerSource;
  clock?: () => number;
  log?: CoordinatorLog;
}): SessionCoordinator {
  const timers = deps.timers ?? REAL_TIMERS;
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.log ?? NO_LOG;
  const { host } = deps;

  /**
   * sessionId → 上一次看到的 run 在不在跑。
   *
   * 边缘的前提是"记得上一次"，所以这份记忆必须活在组件之外（原来的 `prevRunningRef`
   * 就是干这个的）——它按会话分别记，切会话不会互相污染；会话被删之后那一条也不需要
   * 清（它的 id 不会再被问到）。
   */
  const prevRunning = new Map<string, boolean>();

  /** 当前的定时器句柄。空数组 = 没在跑。 */
  let handles: TimerHandle[] = [];

  function note(event: string, outcome: string, sessionId: string | null): void {
    log({ at: clock(), event, sessionId, outcome });
  }

  /**
   * 队列兜底轮询走一跳。
   *
   * 只在"有东西排队"时才打服务端：空队列不用一直打（而且队列为空是绝大多数时间）。
   */
  function pollQueueOnce(): void {
    const view = host.view();
    if (view.currentSessionId === null) {
      note('queue-poll', 'skip-no-session', null);
      return;
    }
    if (view.pendingItems === 0) {
      note('queue-poll', 'skip-empty-queue', view.currentSessionId);
      return;
    }
    note('queue-poll', 'refresh-queue', view.currentSessionId);
    host.refreshQueue(view.currentSessionId);
  }

  /**
   * 孤儿 run 巡检走一跳。
   *
   * 实测（`tools/orphan-run-probe.mjs`）：run 正常失败时投影会给 `errored`，但 owner
   * 进程死掉时投影永远停在 `running`——不报错、不收敛。这时**服务端给的租约到期时间**
   * 是唯一线索。没有这一跳，界面就是一直转圈，用户只能杀进程。
   */
  function pollOrphanRunOnce(): void {
    const view = host.view();
    if (view.currentSessionId === null || !view.runKnown) {
      note('orphan-poll', 'skip-no-run', view.currentSessionId);
      return;
    }
    if (!view.abandoned) {
      note('orphan-poll', 'skip-live-run', view.currentSessionId);
      return;
    }
    note('orphan-poll', 'settle-abandoned-run', view.currentSessionId);
    host.settleAbandonedRun(view.currentSessionId);
  }

  /**
   * run 从跑着变成结束 → 历史现在是权威的，拉一次覆盖本地推测。
   *
   * **只在下降沿触发一次**：这是一个状态变化，不是"当前不跑"这个状态本身。
   * 按后者写就是每次渲染打三个请求（而且是在流式回复的每一帧之后）。
   */
  function observeRunState(): void {
    const view = host.view();
    // 会话没打开、或者 chat 还没建：不动记忆，也不触发。
    // （与重构前一致：那时这两条也是 `return`，不会把记忆写成 false。）
    if (view.currentSessionId === null || !view.runKnown) return;
    const sessionId = view.currentSessionId;
    const wasRunning = prevRunning.get(sessionId) === true;
    prevRunning.set(sessionId, view.running);
    if (!wasRunning || view.running) return;
    note('run-edge', 'run-finished', sessionId);
    host.refreshHistory(sessionId);
    // run 结束 = 队列被消费的时机：follow-up 这时候才开始跑。
    host.refreshQueue(sessionId);
    // 用量在每一轮之后变化最明显，这时刷新才有意义。
    host.refreshSessionStatus(sessionId);
  }

  return {
    start(): void {
      if (handles.length > 0) return;
      handles = [
        timers.setInterval(pollQueueOnce, QUEUE_POLL_INTERVAL_MS),
        timers.setInterval(pollOrphanRunOnce, ORPHAN_RUN_POLL_INTERVAL_MS),
      ];
    },
    stop(): void {
      for (const handle of handles) timers.clearInterval(handle);
      handles = [];
    },
    pollQueueOnce,
    pollOrphanRunOnce,
    observeRunState,
  };
}
