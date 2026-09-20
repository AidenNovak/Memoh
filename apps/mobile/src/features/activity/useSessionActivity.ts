/**
 * 跨 bot 的运行状态与待审批聚合。
 *
 * ## 为什么需要它
 *
 * 移动端最大的差异化价值是**审批**：agent 7x24 在跑，人不在电脑前，点一下"允许"就能
 * 让它继续。要做到这一点，首页必须能看到"哪个 agent 在等我"，而不是让用户逐个 agent
 * 点进去翻。
 *
 * ## 服务端没有现成的接口
 *
 * 实测确认（`tools/status-probe.mjs`、`tools/sse-probe.mjs`）：
 *   - `GET /sessions/{id}/status` 只给 message_count / context_usage / cache_stats /
 *     skills，**不含运行状态**；
 *   - `GET /sessions/events` 只推 `session_touched` / `ping`，**不含决策状态**。
 *
 * 所以"这个会话在等我批准"唯一权威的来源是 runtime snapshot 里的
 * `current_run_view.status === 'waiting_decision'`——也就是必须**订阅该会话**。
 *
 * ## 因此：每个 bot 一条连接，只订阅它最近活跃的少数会话
 *
 * 代价是 N 个 bot 就有 N 条 WebSocket。这个取舍是有意的：自托管用户通常只有 1–3 个
 * bot；订阅只覆盖最近活跃的少数会话；拿不到状态时只是少显示一个提示，不会让首页变空。
 * 复用 `MemohRealtime`（那条连接已被集成测试验证过），不另写探针。
 */
import { useEffect, useMemo, useState } from 'react';

import type { MemohClient } from '../../api/client.ts';
import { canOpenRealtime, type Bot, type Session } from '../../api/types.ts';
import { MemohRealtime } from '../../api/realtime.ts';
import type { RunStatus } from '../../api/protocol.ts';

/** 每个 bot 订阅多少个最近会话。再多就不划算了。 */
const RECENT_SESSIONS_PER_BOT = 8;
/** 会话多久没动就不再订阅。 */
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SessionActivity {
  sessionId: string;
  botId: string;
  botName: string;
  sessionTitle: string;
  status: RunStatus;
}

export interface ActivityResult {
  /** 正在跑或等决策的会话。按"等你的排在前面"排序。 */
  active: SessionActivity[];
  /** 正在等用户决策的会话。 */
  pending: SessionActivity[];
  /** 至少有一条连接是通的。用来区分"没有待办"和"没连上"。 */
  connected: boolean;
}

/** 只给真正能升级 WebSocket 的 bot 建活动连接；chat-only 的 403 不是网络故障。 */
export function realtimeActivityBots(bots: Bot[]): Bot[] {
  return bots.filter(canOpenRealtime);
}

/**
 * 只有“会影响这批连接”的变化才重建：实时资格、可读名称或 bot 集合。
 * 权限数组顺序与 chat-only bot 的改名都不应让别的 bot 全量重连。
 */
export function activityBotKey(bots: Bot[]): string {
  return realtimeActivityBots(bots)
    .map((bot) => `${bot.id}:${bot.name}:${bot.display_name ?? ''}`)
    .sort()
    .join(',');
}

function isRecent(updatedAt: string): boolean {
  const parsed = Date.parse(updatedAt);
  // 时间戳坏了就当它活跃——宁可多订阅一个，也别漏掉待办。
  if (Number.isNaN(parsed)) return true;
  return Date.now() - parsed < ACTIVITY_WINDOW_MS;
}

/** 会话记录 + 它属于哪个 bot。订阅结果靠这个表翻译成人能读的东西。 */
interface SessionRef {
  botId: string;
  botName: string;
  title: string;
}

export function useSessionActivity(client: MemohClient | null, bots: Bot[]): ActivityResult {
  const [statuses, setStatuses] = useState<Record<string, RunStatus>>({});
  const [connected, setConnected] = useState(false);
  /** sessionId → 归属。渲染会直接读它，所以它就是 state，不用可变 ref 偷渡。 */
  const [sessionRefs, setSessionRefs] = useState<Map<string, SessionRef>>(() => new Map());

  /** 用 bot 列表的稳定标识做依赖，避免每次渲染都重连。 */
  const botKey = useMemo(() => activityBotKey(bots), [bots]);
  // botKey 没变就复用上一份快照：同内容的列表换了数组引用不应重连。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const botSnapshot = useMemo(() => realtimeActivityBots(bots), [botKey]);

  useEffect(() => {
    const currentBots = botSnapshot;
    if (client === null || currentBots.length === 0) {
      setStatuses({});
      setConnected(false);
      setSessionRefs(new Map());
      return;
    }

    // 这是一轮新的订阅集：旧会话的运行态与“曾经连上过”都不能
    // 在新的 bot/client 上冒充当前事实。新连接会用 snapshot 重建这两份状态。
    setStatuses({});
    setConnected(false);
    setSessionRefs(new Map());

    let cancelled = false;
    const realtimes: MemohRealtime[] = [];
    const refs = new Map<string, SessionRef>();
    let anyConnected = false;

    const apply = (sessionId: string, status: RunStatus) => {
      if (cancelled) return;
      setStatuses((current) =>
        current[sessionId] === status ? current : { ...current, [sessionId]: status },
      );
    };

    void (async () => {
      for (const bot of currentBots) {
        if (cancelled) return;

        let sessions: Session[];
        try {
          const response = await client.listSessions(bot.id, { limit: RECENT_SESSIONS_PER_BOT });
          sessions = response.items ?? [];
        } catch {
          continue; // 单个 bot 拉不到不影响其他 bot。
        }
        if (cancelled) return;

        const recent = sessions.filter((session) => isRecent(session.updated_at));
        if (recent.length === 0) continue;

        const botName = bot.display_name !== '' ? bot.display_name : bot.name;
        for (const session of recent) {
          refs.set(session.id, {
            botId: bot.id,
            botName,
            // 空标题保持空——"没标题怎么显示"是渲染层的事（要跟着语言走），
            // 不该在这里固化成一个字符串。见 `sessionDisplayTitle`。
            title: session.title,
          });
        }
        // 用新 Map 发布这一批归属；后续 snapshot 到达时，渲染能同时拿到
        // status 与对应的会话标题，不依赖“碰巧又有一次渲染”。
        setSessionRefs(new Map(refs));

        const realtime = new MemohRealtime({
          baseUrl: client.url,
          botId: bot.id,
          getToken: () => client.token(),
          listener: {
            onStateChange: (connection) => {
              if (cancelled || connection !== 'open') return;
              anyConnected = true;
              setConnected(true);
            },
            onSnapshot: (frame) => {
              // snapshot 是权威状态：没有活跃 run 就是"没有在跑"，不是"未知"。
              const run = frame.snapshot.current_run_view;
              apply(frame.sessionId, run?.status ?? 'completed');
            },
            onDelta: (frame) => {
              // 只认投影里的状态变化，不猜。
              const status = frame.delta.current_run_view?.status ?? frame.delta.run?.status;
              if (status !== undefined) apply(frame.sessionId, status);
            },
            onGap: () => {
              // 视图可能过期。不去改状态（改错比不改更糟），等新的 snapshot 纠正。
            },
          },
        });

        realtime.connect();
        for (const session of recent) realtime.subscribe(session.id);
        realtimes.push(realtime);
      }

      // 全部试过还没连上，说明是网络问题而不是"没有待办"。
      setTimeout(() => {
        if (!cancelled && !anyConnected) setConnected(false);
      }, 5_000);
    })();

    return () => {
      cancelled = true;
      for (const realtime of realtimes) realtime.dispose();
      realtimes.length = 0;
    };
  }, [botKey, botSnapshot, client]);

  // 派生在渲染时做，不额外存一份 state（两份状态一定会不同步）。
  const { active, pending } = useMemo(() => {
    const activeRows: SessionActivity[] = [];
    const pendingRows: SessionActivity[] = [];
    for (const [sessionId, status] of Object.entries(statuses)) {
      if (status !== 'running' && status !== 'waiting_decision' && status !== 'admitting') continue;
      const ref = sessionRefs.get(sessionId);
      if (ref === undefined) continue; // 状态有了但归属表还没填好，下一轮渲染会补上。
      const row: SessionActivity = {
        sessionId,
        botId: ref.botId,
        botName: ref.botName,
        sessionTitle: ref.title,
        status,
      };
      activeRows.push(row);
      if (status === 'waiting_decision') pendingRows.push(row);
    }
    // 等你的排在前面——这是用户最需要先看到的。
    activeRows.sort(
      (a, b) => Number(b.status === 'waiting_decision') - Number(a.status === 'waiting_decision'),
    );
    return { active: activeRows, pending: pendingRows };
  }, [sessionRefs, statuses]);

  return { active, pending, connected };
}
