/**
 * 通知的**宿主**：把桥接到会话 store 与路由上（一个薄组件，没有界面）。
 *
 * ## 为什么是一个挂在根上的组件
 *
 * 通知到的时候用户可能在任何页面（甚至刚冷启动）。这部分逻辑只有三个依赖：
 * 会话 store（打开会话、回应审批）、路由（跳到会话）、i18n（动作文案）。
 * 挂在 `SessionProvider` 里面、`Stack` 旁边，就同时拿到了这三个，且不往任何
 * 产品页面里塞"如果是从通知进来的"这类分支。
 *
 * ## 点了"允许/拒绝"之后发生什么
 *
 * 1. 深链到 `/chat/<sessionId>` 并让 store 订阅那个会话；
 * 2. 等**那一次**审批（`approvalId` 必须相等）出现，然后按兜底决策提交
 *    （`decision: approve|reject`，不带 `option_id`——通知里没有 agent 的选项表）；
 * 3. 等不到就放弃（20s）：界面里的审批面板还在，用户可以在那儿决定。
 *
 * 第 2 步与第 3 步的判据在 `openRouting.submissionFor`（纯函数、有测试）。
 * 这里只负责"什么时候问它"和"把它说的动作做掉"。
 */
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getSession } from '../../api/credentials.ts';
import { useSession } from '../session/store.tsx';
import { reportDeviceRegistration, startNotificationBridge } from './bridge.ts';
import {
  APPROVAL_WAIT_MS,
  matchesCurrentUser,
  routeFor,
  submissionFor,
  type NotificationOpen,
} from './openRouting.ts';

/** 评估提交条件的间隔。够快（用户点完按钮就看到会话动），也不至于每帧跑一遍。 */
const TICK_MS = 400;

interface PendingIntent {
  open: NotificationOpen;
  at: number;
}

export function NotificationOpenHandler() {
  const router = useRouter();
  const { state, openSession, respondApproval } = useSession();
  const [intent, setIntent] = useState<PendingIntent | null>(null);

  /**
   * 桥是长驻订阅，不该跟着每次渲染重连；但它需要读到最新的会话状态与当前用户。
   * 用 ref 供桥读取，避免把 state 变成 effect 依赖（那会每次渲染都重装一遍代理）。
   *
   * 当前用户 id 来自凭据（`getSession()` 是内存读，不用等 Keychain）：它只在一处
   * 有意义——负载声称的通知归属跟它对不上时，**这条通知不是这个账号的**。
   */
  const liveRef = useRef({
    currentSessionId: state.currentSessionId,
    userId: getSession()?.userId ?? null,
    approval: state.chats[state.currentSessionId ?? '']?.approval ?? null,
  });
  const liveUserId = getSession()?.userId ?? null;
  const liveApproval = state.chats[state.currentSessionId ?? '']?.approval ?? null;
  // 通知回调可能在任意页面到达。commit 时先同步 latest-ref，再让系统有机会投递事件，
  // 避免 render 期写 ref 暴露尚未提交的会话/账号状态。
  useLayoutEffect(() => {
    liveRef.current = {
      currentSessionId: state.currentSessionId,
      userId: liveUserId,
      approval: liveApproval,
    };
  }, [liveApproval, liveUserId, state.currentSessionId]);

  useEffect(() => {
    const stop = startNotificationBridge(
      {
        context: () => ({
          visibleSessionId: liveRef.current.currentSessionId,
          currentUserId: liveRef.current.userId,
        }),
      },
      {
        onOpen: (open) => {
          /**
           * 防串号：负载声称的归属跟当前登录用户对不上时，**这条通知不属于这个账号**
           * （换号之后前一个用户的审批弹到了新用户手机上，Lody 第 24 条）。这时什么都
           * 不做——不深链、不提交（`submissionFor` 里还有第二道同样的闸）。
           */
          if (!matchesCurrentUser(open, liveRef.current.userId)) return;
          // 会话先订阅起来（store 会拉历史、拉状态、挂实时），再跳路由。
          openSession(open.sessionId);
          // `routeFor` 回的是拼好的字符串（通知的落点是运行时才知道的会话 id），
          // 而 expo-router 的 `Href` 是**字面量联合**——与仓库其它地方一样显式转一次。
          router.push(routeFor(open) as never);
          setIntent({ open, at: Date.now() });
        },
        onDelivery: () => {
          // 前台那条已经由 policy 判成 in_app / drop，系统侧不弹横幅；
          // in_app 的落点是**首页那份跨 bot 待审批聚合**（同一条实时通道喂它），
          // 所以这里不需要再造一个界面。
        },
        onToken: (token) => {
          const session = getSession();
          const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
          if (session === null || typeof bundleId !== 'string' || bundleId === '') return;
          void reportDeviceRegistration(
            {
              baseUrl: session.baseUrl,
              accessToken: session.token,
              currentUserId: session.userId,
              bundleId,
              isDevBuild: __DEV__,
            },
            { token },
          );
        },
        onRegistrationFailed: () => {
          // 模拟器 / 无凭据下这是预期路径，不打扰用户。
        },
      },
    );
    return stop;
  }, [openSession, router]);

  /**
   * 推进"要不要提交决定"。
   *
   * 用定时器而不是"审批一出现就提交"：签到的时刻由**服务端快照**决定，而它可能比
   * 用户点按钮晚若干秒到（冷启动尤其）。判据必须按时钟评估，否则超时永远不触发。
   */
  useEffect(() => {
    if (intent === null) return;
    const timer = setInterval(() => {
      const approval = liveRef.current.approval;
      const submission = submissionFor({
        open: intent.open,
        pending: approval === null ? null : { approvalId: approval.approvalId, runId: '' },
        elapsedMs: Date.now() - intent.at,
        currentUserId: liveRef.current.userId,
      });
      if (submission.kind === 'wait') return;
      if (submission.kind === 'submit' && approval !== null) {
        respondApproval(submission.optionId, intent.open.sessionId);
      }
      setIntent(null);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [intent, respondApproval]);

  /** 极端情况下的自清：审批永远不到时，别把一个 intent 留在内存里跑一夜。 */
  useEffect(() => {
    if (intent === null) return;
    const timer = setTimeout(() => setIntent(null), APPROVAL_WAIT_MS * 3);
    return () => clearTimeout(timer);
  }, [intent]);

  return null;
}
