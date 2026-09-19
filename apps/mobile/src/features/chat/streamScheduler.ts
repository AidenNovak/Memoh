/**
 * 流式期间的性能护栏（纯逻辑：**不 import react / react-native**，时钟注入，
 * `node --test` 能直接验）。这一文件管两件事，都是"高频 delta 下的代价与残留"：
 *
 * ## A. 转录快照的发布节奏（`createSnapshotScheduler`）
 *
 * `ChatScreen` 给原生列表喂的是 `turnsForDisplay(chat)` 的 JSON——对长转录这是
 * O(整份转录) 的投影 + 序列化，每个 realtime delta 都做一次会把桥前的 JS 线程占满
 * （原生 `NativeMessageList` 已经在 30fps 合并 prop，JS 侧不跟上同样的节奏，
 * 桥前的开销就没有被抑制）。
 *
 * 调度器的语义：
 *
 *   - **leading + trailing，窗口上限 33ms**：持续高频输入每个窗口至少发一次最新值，
 *     不会饿死；窗口内只记最新值，不为每个 delta 都投影一次；
 *   - **同一个引用反复前馈不重复发布**（React 重渲染但状态没变时，一次都不多发）；
 *   - `flush()`：立即发布最新值（run 停止等"最终值必须落地"的时刻），并取消 trailing；
 *   - `reset()`：丢弃未发布的值并清掉定时器，**不发布**（切会话 / 卸载）——
 *     旧会话的 trailing 值不能泄漏进新会话。
 *
 * ## B. 会话缓存的释放判据（`closeSessionCache` / `clearedSessionMaps`）
 *
 * store 的 `chats` / `queues` / `sessionStatus` 只增不清。释放只有两条路径：
 *
 *   - 关会话：必须带**预期的 sessionId**，只在它仍是当前会话时才清——旧屏幕迟到的
 *     unmount 不能把用户新打开的会话清掉（`/chat/new` 的空/合成 id 同理不得误删）；
 *   - 切 bot：三份缓存整个属于旧 bot，全清。
 *
 * 删 key 时若 key 不存在，保留原对象引用——不为"没删到东西"付出一次整表拷贝。
 */

/** 转录快照的发布窗口：与原生列表 30fps 的合并节奏同一量级。 */
export const TRANSCRIPT_SNAPSHOT_INTERVAL_MS = 33;

/** 计时器句柄。RN 上是 number，Node 上是 `Timeout`——两边都用，所以不写死。 */
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * 时间源。
 *
 * 注入它是为了**能测**（与 `features/session/coordinator.ts` 的 `TimerSource` 同一
 * 纪律）：测试给一个可以 `advance(ms)` 的假时钟，把"过多久才该发布"变成确定性断言，
 * 不靠墙钟。
 */
export interface ThrottleClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** 真实时间源：App 里用的就是这几个全局函数。 */
export const REAL_CLOCK: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * 快照调度器。三个动词对应调用方的三种时刻：
 *
 *   - `push`：新值到了（每个 delta / 每次状态变化）；
 *   - `flush`：现在就要最终值（run 停止）；
 *   - `reset`：这份值的上下文没了（切会话 / 卸载），扔掉，别发。
 */
export interface SnapshotScheduler<T> {
  push(value: T): void;
  flush(): void;
  reset(): void;
}

export function createSnapshotScheduler<T>(options: {
  intervalMs?: number;
  publish: (value: T) => void;
  clock?: ThrottleClock;
}): SnapshotScheduler<T> {
  const intervalMs = options.intervalMs ?? TRANSCRIPT_SNAPSHOT_INTERVAL_MS;
  const clock = options.clock ?? REAL_CLOCK;

  let latest: T | null = null;
  let hasPending = false;
  let timer: TimerHandle | null = null;
  let lastPublishAt: number | null = null;

  const cancelTimer = (): void => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };

  const emit = (value: T): void => {
    lastPublishAt = clock.now();
    options.publish(value);
  };

  return {
    push(value) {
      // 同一个引用反复前馈（重渲染但状态没变）：不值得再发一次，也别为此排定时器。
      if (!hasPending && value === latest) return;
      latest = value;
      const elapsed = lastPublishAt === null ? intervalMs : clock.now() - lastPublishAt;
      if (elapsed >= intervalMs) {
        // leading：距上一次发布已经超过一个窗口（或第一次），立即发。
        cancelTimer();
        hasPending = false;
        emit(value);
        return;
      }
      // 窗口内：只记最新值；trailing 定时器已经排着就别再排一个（它发的就是最新值）。
      hasPending = true;
      if (timer !== null) return;
      timer = clock.setTimeout(
        () => {
          timer = null;
          if (!hasPending || latest === null) return;
          hasPending = false;
          emit(latest);
        },
        // 对齐窗口边界，而不是"再过一个整窗口"——否则实际发布间隔会漂到 2 倍。
        intervalMs - elapsed,
      );
    },
    flush() {
      cancelTimer();
      if (!hasPending || latest === null) return;
      hasPending = false;
      emit(latest);
    },
    reset() {
      cancelTimer();
      latest = null;
      hasPending = false;
      lastPublishAt = null;
    },
  };
}

/**
 * 按 key 删条目；**key 不存在时返回原对象**（引用相等）。
 *
 * 释放路径每次关会话都会走，三份 map 挨个删一遍——没有这条护栏，关一个三条记录
 * 都没有的会话也会付出三次整表拷贝（纯无效分配，还会让依赖引用相等的 memo 失效）。
 */
export function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (!Object.hasOwn(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** store 里那三份按会话 id 索引的缓存。 */
export interface SessionCacheMaps<C, Q, S> {
  chats: Record<string, C>;
  queues: Record<string, Q>;
  sessionStatus: Record<string, S>;
}

export interface ClosedSessionCache<C, Q, S> extends SessionCacheMaps<C, Q, S> {
  currentSessionId: string | null;
}

/**
 * `closeSession` 的缓存释放判据。
 *
 * 返回 `null` = **什么都不动**（调用方保持原 state）。两种情况：
 *
 *   1. 要关的已经不是当前会话——旧屏幕迟到的 unmount。这时用户可能已经打开了
 *      另一个会话，它的 `chats` / `queues` / `sessionStatus` 条目必须原样留着；
 *   2. 空 id——`/chat/new` 的合成态，绝不匹配任何真实会话。
 *
 * 命中时：当前会话 id 归零，并把该 id 在三份缓存里的条目删掉。
 */
export function closeSessionCache<C, Q, S>(
  currentSessionId: string | null,
  sessionId: string,
  maps: SessionCacheMaps<C, Q, S>,
): ClosedSessionCache<C, Q, S> | null {
  if (sessionId === '' || currentSessionId !== sessionId) return null;
  return {
    currentSessionId: null,
    chats: omitKey(maps.chats, sessionId),
    queues: omitKey(maps.queues, sessionId),
    sessionStatus: omitKey(maps.sessionStatus, sessionId),
  };
}

/** 切 bot：三份缓存整个属于旧 bot，全清（留着只会越攒越多）。 */
export function clearedSessionMaps<C, Q, S>(): SessionCacheMaps<C, Q, S> {
  return { chats: {}, queues: {}, sessionStatus: {} };
}
