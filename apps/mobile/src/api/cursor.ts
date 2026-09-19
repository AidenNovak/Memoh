/**
 * 投影帧的序号校验。
 *
 * 从 `realtime.ts` 里抽出来单独成模块，因为这是整个实时层最容易写错、也最难在
 * 真机上复现的部分——错一格就会静默丢内容。抽成纯函数后可以直接测。
 *
 * 规则（依据 `docs/research/memoh-api.md` §2.2 与参考客户端
 * `apps/web/src/store/chat/runtime-client.ts` 的实现）：
 *
 *   - `epoch` 变了 → 重建。epoch 变了 seq 从 0 重来，跨 epoch 比较 seq 没有意义。
 *   - `seq <= 本地 seq` → 重复帧，丢弃。
 *   - `seq != 本地 seq + 1` → 有空洞，必须重新拿 snapshot。
 *   - 没订阅过就收到 delta → 状态不一致，重新订阅。
 *
 * 特别注意第三条：**不能靠 cursor 续传**。服务端明确说 live projection 背后没有
 * 持久事件日志，"在客户端位置和现在之间合成增量等于伪造历史"。所以恢复手段只有
 * 重新订阅要 snapshot。
 */

export interface SubscriptionCursor {
  epoch: string | null;
  seq: number;
}

export type Verdict =
  /** 正常帧，可以应用。 */
  | { action: 'apply'; cursor: SubscriptionCursor }
  /** 重复帧，丢弃且不动游标。 */
  | { action: 'drop' }
  /** 必须重新订阅（会带回权威 snapshot）。 */
  | { action: 'resubscribe'; reason: string };

/**
 * 判定一条 delta 帧。
 *
 * @param current 本地对该会话的游标；`epoch: null` 表示还没收到过 snapshot。
 */
export function judgeDelta(
  current: SubscriptionCursor,
  frame: { epoch: string; seq: number },
): Verdict {
  if (current.epoch === null) {
    return { action: 'resubscribe', reason: 'delta before snapshot' };
  }

  if (current.epoch !== frame.epoch) {
    return { action: 'resubscribe', reason: 'epoch changed' };
  }

  if (frame.seq <= current.seq) {
    return { action: 'drop' };
  }

  if (frame.seq !== current.seq + 1) {
    return { action: 'resubscribe', reason: `seq gap ${current.seq} → ${frame.seq}` };
  }

  return { action: 'apply', cursor: { epoch: frame.epoch, seq: frame.seq } };
}

/**
 * 判定一条 snapshot 帧。
 *
 * snapshot 是权威状态，不存在"比本地旧"的合法情况——直接覆盖游标。
 */
export function judgeSnapshot(frame: { epoch: string; seq: number }): SubscriptionCursor {
  return { epoch: frame.epoch, seq: frame.seq };
}

/** 心跳是否该发：默认 30s。服务端不发 ping，客户端必须自己保活。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 建连超时。
 *
 * 没有它的话，弱网下 `connect()` 会永远停在 `connecting`：iOS 在"有无线但出不去"
 * 的网络里（酒店/机场门户、NAT 黑洞）会一直重传 SYN，WebSocket 可能几十秒都不回调
 * 任何事件。实测（`verification/fixture/netlab.mjs` 的 `hang` 场景）15s 内一次回调
 * 都没有，而且因为 `connect()` 见到 connecting 就返回，这段时间里所有发送都被
 * 默默塞进了队列——用户看到的是"发出去了"。
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * 退避上限。
 *
 * 上限不能太大：移动网络恢复的瞬间用户就在等，等 5 分钟是不可接受的。所以真正的
 * 即时恢复靠两件事——回到前台立刻重连、退避期间做轻量可达性探测（见
 * `realtime.ts` 的 `probe`）。
 */
export const RECONNECT_MAX_MS = 20_000;

/** 退避基数。第一次失败后 1s 再试。 */
export const RECONNECT_BASE_MS = 1_000;

/**
 * "连上多久才算稳定"。
 *
 * 这是防重连风暴的关键：握手成功**不等于**链路可用。网关接受握手后又立刻掐断
 * （代理过载、后端处理器崩掉、token 在升级后才被拒）时，如果一看到 `open` 就把
 * 退避清零，就会变成**每秒一次、永不增长**的重连。实测：15s 内重连 14 次，间隔
 * 恒定 1.08s。
 *
 * 所以只有"连上并活了这么久"才允许把退避清零。
 */
export const STABLE_CONNECTION_MS = 10_000;

/**
 * 心跳之后多久没收到任何帧就判定链路已死。
 *
 * 服务端不发心跳，但**重发 `runtime_subscribe` 一定会换回一个 snapshot**，所以
 * "探针发出去、回音没回来"就是一个可靠的死链判据。NAT/运营商静默断连不会发
 * TCP close，没有这个判据的话客户端会永远停在"看起来连着呢"。
 */
export const LIVENESS_GRACE_MS = 10_000;

/**
 * 同一个会话两次重新订阅之间的最小间隔。
 *
 * 空洞（或 `runtime_dropped`）之后的恢复手段就是重新订阅要 snapshot；但如果服务端
 * 持续处于"快照与 delta 对不上"的状态，一条 delta 触发一次重订阅就会变成订阅风暴。
 * 实测：4s 内对同一个会话订阅了 38 次。所以重新订阅必须节流。
 */
export const RESUBSCRIBE_COOLDOWN_MS = 5_000;

/**
 * 重连退避：指数增长并有上限，带抖动避免多会话同时重连打爆服务端。
 *
 * @param attempt 连续第几次失败，从 1 开始。
 */
export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
  base = RECONNECT_BASE_MS,
  max = RECONNECT_MAX_MS,
): number {
  const delay = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
  const jitter = Math.floor(delay * 0.2 * random());
  return delay + jitter;
}

/**
 * 下一次重连该用第几次退避。
 *
 * `stable` = 这一次的连接**活够久**（见 `STABLE_CONNECTION_MS`）。只有稳定过的连接
 * 才允许把退避清零，否则握手后立刻断的情形会一直停在 1s 上。
 */
export function nextAttempt(current: number, stable: boolean): number {
  return stable ? 1 : current + 1;
}

/** 这一次连接算不算"稳定"。 */
export function isStableConnection(
  openedAt: number | null,
  now: number,
  stableMs = STABLE_CONNECTION_MS,
): boolean {
  if (openedAt === null) return false;
  return now - openedAt >= stableMs;
}

/** 从 `close` 事件里看出来的"这条路以后也走不通"。 */
export interface CloseVerdict {
  /** `retry` = 值得换个时间再试；`stop` = 重试一百次也是一样的结果。 */
  action: 'retry' | 'stop';
  /** `stop` 的原因分类：`auth` 要回登录，`permanent` 是这条路本身没了。 */
  kind?: 'auth' | 'permanent';
  detail: string;
}

/**
 * 判定一次 close 该不该重试（超时和 401 是**两件事**）。
 *
 * 依据是 RN 的实现：`websocketFailed` 那一路 JS 只拿到一个**没有 message 的**
 * `error` 事件，真正的失败原因在随后那个 `close` 事件里
 * （`Libraries/WebSocket/WebSocket.js`：`new CloseEvent('close', {code: 1006,
 * reason: ev.message})`，reason 就是原生 `error.localizedDescription`）。
 * iOS 的 SocketRocket 对"没升成 101"的响应给出的描述形如
 * `Expected HTTP 101 response but was '401 Unauthorized'`。
 *
 * 所以判定放在 reason 里找 HTTP 状态码：**超时、断网、被掐**都没有状态码，照旧重试；
 * 401/403 是凭据没了（重试到天亮也一样）；其余 4xx 是这条路本身不存在（比如 bot 被删）。
 * 拿不到状态码时一律"重试"——宁可多试几次，也不要因为解析不出原因就永久放弃。
 */
export function judgeClose(info: { code?: number; reason?: string }): CloseVerdict {
  const reason = typeof info.reason === 'string' ? info.reason : '';
  const status = httpStatusIn(reason);
  if (status === 401 || status === 403) {
    return { action: 'stop', kind: 'auth', detail: reason === '' ? `handshake ${status}` : reason };
  }
  if (status !== null && status >= 400 && status < 500) {
    return { action: 'stop', kind: 'permanent', detail: reason };
  }
  // 1008 = policy violation。服务端用它在升级后拒绝（权限不足那类）。
  if (info.code === 1008) {
    return { action: 'stop', kind: 'auth', detail: reason === '' ? 'policy violation' : reason };
  }
  return { action: 'retry', detail: reason };
}

/**
 * 从一段文本里找出"对面拒了我们"的 HTTP 状态码（没有就 null）。
 *
 * 刻意只认 4xx：这段文本里往往还带着 `101`（"Expected HTTP **101** response but was
 * '401 Unauthorized'"），按"第一个三位数"取会拿到 101 从而误判成"可以重试"。
 * 5xx 也不在这里处理——那是服务端的临时故障，和断网一样该重试。
 */
function httpStatusIn(text: string): number | null {
  const codes = [...text.matchAll(/\b(\d{3})\b/g)].map((match) => Number(match[1]));
  return codes.find((code) => code >= 400 && code < 500) ?? null;
}

/** 这次要不要真的重新订阅（还是要等冷却期过去）。 */
export function shouldResubscribe(
  lastAt: number | null,
  now: number,
  cooldownMs = RESUBSCRIBE_COOLDOWN_MS,
): boolean {
  if (lastAt === null) return true;
  return now - lastAt >= cooldownMs;
}
