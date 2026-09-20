/** Chat orchestration; transcript rendering belongs to MemohKit. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { NativeMessageList } from '@memoh-ios/kit';
import {
  DEFAULT_CHOICE,
  loadCatalog,
  verifiedChoice,
  type ComposerChoice,
  type ModelSection,
} from '../features/chat/models.ts';
import type { SkillSummary } from '../api/types.ts';
import { MachinePanelSheet } from '../ui/MachinePanelPage.tsx';
import { ModelPickerSheet } from '../ui/ModelPickerPage.tsx';
import { loadSkills } from '../features/chat/skills.ts';
import type { ErrorPresentation } from '../features/errors/present.ts';
import { SlashMenu } from '../ui/SlashMenu.tsx';
import {
  draftAfterSkill,
  requestedSkillsFor,
  slashItems,
  slashQuery,
  type SlashItem,
} from '../features/chat/slash.ts';
import { useSession } from '../features/session/store.tsx';
import { sessionDisplayTitle } from '../features/session/displayTitle.ts';
import { hasContent, turnsForDisplay, type ChatState } from '../features/chat/reducer.ts';
import type { RenderTurn } from '../models/chat.ts';
import {
  createSnapshotScheduler,
  TRANSCRIPT_SNAPSHOT_INTERVAL_MS,
} from '../features/chat/streamScheduler.ts';
import { useT } from '../lib/i18n/useT.ts';
import { hasTranslation } from '../lib/i18n/index.ts';
import { announceForAccessibility, useAnnounceOnAppear } from '../lib/accessibility.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { present } from '../lib/presentation/index.ts';
import { usePresentedPage } from '../lib/presentation/usePresentedPage.ts';
import { ApprovalPage } from '../ui/ApprovalPage.tsx';
import { pendingSendView } from '../features/chat/pending.ts';
import { PendingSendStrip } from '../ui/PendingSendStrip.tsx';
import { QueueStrip } from '../ui/QueueStrip.tsx';
import { SessionInfoPage } from '../ui/SessionInfoPage.tsx';
import { UserInputPage } from '../ui/UserInputPage.tsx';
import { ChatComposer } from '../ui/ChatComposer.tsx';
import { ChatHeader } from '../ui/ChatHeader.tsx';
import { ChatNotices } from '../ui/ChatNotices.tsx';
import {
  headerSubtitle,
  modelPillLabel,
  runFailureNotice,
  userTextOfTurn,
} from '../features/chat/copy.ts';
import { composerView } from '../features/chat/composer.ts';
import {
  chatSessionId,
  createdSessionRoute,
  shouldOpenInfoOnMount,
  shouldOpenSession,
} from '../features/chat/route.ts';
import {
  approvalPresentationKey,
  userInputPresentationKey,
} from '../features/chat/presentation.ts';
import { canManageBot } from '../features/bots/permissions.ts';

/**
 * 对话页的**编排**：把 store 里的状态接到几个小组件上。
 *
 * ## 这一屏的边界
 *
 * 转录的渲染归 MemohKit（原生列表），这一层只做四件事：
 *
 * 1. **路由同步**：`/chat/new` ↔ `/chat/<id>`（判据在 `features/chat/route.ts`）；
 * 2. **取数**：模型目录、技能清单（失败也要说得出"是拉不到还是真没有"）；
 * 3. **把状态翻成界面要的东西**：run 失败那一块、副标题、按钮语义、pending 投影
 *    （分别住在 `features/chat/{copy,composer,pending}.ts`，都是纯函数、有单测）；
 * 4. **接线**：把 store 的动作交给组件（表头 / 状态条 / 消息流 / 队列 / 待发 / 输入区）。
 *
 * 界面本身拆在 `ui/ChatHeader`、`ui/ChatNotices`、`ui/ChatComposer`（外加既有的
 * `QueueStrip` / `PendingSendStrip` / `SlashMenu`）。**判据（文案、时序、无障碍标签、
 * testID）都不在这里**——搬出去的时候是逐字搬的，改一处文案不该需要读这一屏。
 */
export function ChatScreen() {
  const params = useLocalSearchParams<{ sessionId: string; info?: string }>();
  const sessionId = params.sessionId;
  const isNew = sessionId === 'new';

  const palette = usePalette();
  const t = useT();
  const router = useRouter();

  const {
    state,
    openSession,
    closeSession,
    submit,
    queueFor,
    loadOlderHistory,
    removeQueueItem,
    promoteQueueItem,
    abort,
    chatFor,
    retryConnection,
    discardFailedSend,
    realtimeEnabled,
    currentBot,
  } = useSession();

  const client = state.client;

  // `new` 是一条真实的路由，但还没有会话 id；其余情况让 store 打开路由上那个会话。
  useEffect(() => {
    if (
      !shouldOpenSession({
        isNew,
        routeSessionId: sessionId,
        openSessionId: state.currentSessionId,
      })
    ) {
      return;
    }
    openSession(sessionId);
  }, [isNew, openSession, sessionId, state.currentSessionId]);

  /**
   * 新会话建好了：把路由切到真实的会话地址。
   *
   * 服务端在我们发第一句时会建会话并回 `session_created`（store 里已经把它设成
   * `currentSessionId`），但**路由还停在 `/chat/new`**——这个页面渲染的是
   * `chatFor('')`，永远空。于是用户看到的顺序是：点了发送 → 草稿消失 → 界面依旧
   * 一片空白。消息其实已经上路了，只是屏幕上没有任何证据。
   *
   * `replace` 而不是 `push`：用户没有"返回新会话"这个意图，草稿页不该留在栈里；
   * 这也和新会话创建后不该能用返回键退回去一致。
   */
  useEffect(() => {
    const target = createdSessionRoute({ isNew, openSessionId: state.currentSessionId });
    if (target === null) return;
    router.replace(target);
  }, [isNew, router, state.currentSessionId]);

  useEffect(
    () => () => {
      // 带**路由实际指向的稳定 id** 去关：只有它仍是当前会话时 store 才会清。
      // `/chat/new` 的空/合成 id 不得误删刚建好的真会话——直接跳过。
      if (isNew) return;
      closeSession(sessionId);
    },
    [closeSession, isNew, sessionId],
  );

  /**
   这一屏读哪个会话的数据：`new` 时是空串（服务端在第一次发送时建会话）。

   ⚠️ 这几处**故意各写一次** `chatSessionId(...)`，不提取成中间变量：React Compiler
   会把"来自函数调用的中间变量、又用在两处"判成"这个依赖之后可能被改"，于是整屏的
   自动记忆化被跳过（`react-hooks/preserve-manual-memoization`，实测 7 条警告）。
   判据本身仍然是纯函数、有单测（`features/chat/route.ts`）。
  */
  const chat: ChatState = chatFor(chatSessionId({ isNew, routeSessionId: sessionId }));

  /**
   原生列表的转录投影：**节流的**（最多每 33ms 一份快照，leading + trailing）。

   高频 delta 期间 `turnsForDisplay(chat)` + `JSON.stringify` 对长转录是 O(整份转录)，
   每个 delta 做一次会把桥前的 JS 线程占满——原生 `NativeMessageList` 已经在 30fps
   合并 prop，JS 侧不跟上同样的节奏，桥前的开销就没有被抑制。

   节流的只有"原生列表用的转录投影 + 序列化"（含 `pendingText` / `onErrorAction`
   对同一份投影的查找）：审批、错误、pending、按钮语义、连接态仍直读 `chat`。
   发布节奏是纯逻辑（`features/chat/streamScheduler.ts`，有单测），hook 只接线。
   */
  const { turns, turnsJson } = useThrottledTranscript(
    chat,
    chat.running,
    chatSessionId({ isNew, routeSessionId: sessionId }),
  );

  /**
   run 失败那一块的文案（视觉两行 + 读屏一句，同一个来源）。

   `runError` 有两种来源：reducer 给的是我们自己的 i18n key（`error.runAbandoned`），
   协议里带的则可能是服务端**已经写好的句子**。分辨与拼接都在
   `features/chat/copy.ts` 的 `runFailureNotice`（纯函数，有单测）。
   */
  const runFailure = runFailureNotice(
    { runStatus: chat.runStatus, runError: chat.runError },
    t,
    hasTranslation,
  );
  // run 失败是**自己出现的**（用户没按任何东西），所以读屏要念一次（规则 R28）。
  useAnnounceOnAppear(runFailure === null ? null : runFailure.label);

  /**
   刚发出去的那一句现在在哪儿（`null` = 没有待发的东西，界面不该出现这一块）。

   三件事都是**现成的事实**，这里只做翻译：本地那条有没有被权威覆盖
   （`pendingInvocationId`）、outbox 里还有没有帧（`pendingSends`）、通道是不是开着
   （`connection`）。翻译规则在 `features/chat/pending.ts`（纯函数，有单测）。
   */
  const pending = pendingSendView({
    unconfirmed: chat.pendingInvocationId !== null,
    queuedLocally: state.pendingSends > 0,
    connected: state.connection === 'open',
    failure: chat.sendFailure,
  });
  /** "重试"要重发的那句话：取本地那条乐观消息的正文（没有就空串，不会发出去）。 */
  const pendingText =
    chat.pendingInvocationId === null
      ? ''
      : userTextOfTurn(turns, `local-${chat.pendingInvocationId}`);

  /**
   * 服务端说"我在等你批准" → 打开审批 sheet。
   *
   * 审批不是用户点出来的，所以这里用 `usePresentedPage` 把状态翻译成一次出席：
   * 钥匙是"会话 id + 审批 id"（`features/chat/presentation.ts`，纯函数、有单测），
   * 同一个审批只开一次，换一个审批会再开一次。
   *
   * 关掉它不在这里做——审批页自己在 store 里那份审批消失时 `finish()`。
   * "打开"与"关闭"各只有一个入口，才不会出现两条路径互相打架。
   */
  usePresentedPage(
    ApprovalPage,
    chat.approval === null
      ? null
      : approvalPresentationKey({ sessionId, approvalId: chat.approval.approvalId }),
    { sessionId },
  );

  /**
   * agent 提问（`ask_user`）→ 打开提问表单。
   *
   * 与审批同一套：钥匙是提问 id，同一个提问只开一次。草稿的重置由页面内部
   * `key={userInputId}` 负责（见 ui/UserInputSheet.tsx）。
   */
  usePresentedPage(
    UserInputPage,
    chat.userInput === null
      ? null
      : userInputPresentationKey({ sessionId, userInputId: chat.userInput.userInputId }),
    { sessionId },
  );
  // 标题取会话自己的名字——写死成"会话"会让所有会话长得一样，用户没法确认
  // 自己在跟哪一轮对话。
  const sessionTitle = sessionDisplayTitle(
    { title: state.sessions.find((entry) => entry.id === sessionId)?.title ?? '' },
    t,
  );

  const [draft, setDraft] = useState('');
  /**
   * composer 上的模型/强度选择。
   *
   * 存在**这一屏**而不是全局：它是"我这一轮想用哪个"，而候选目录（`/models`）是
   * 按 client 缓存的（换服务器自动作废，见 `features/chat/models.ts`）。
   */
  const [choice, setChoice] = useState<ComposerChoice>(DEFAULT_CHOICE);
  const [catalog, setCatalog] = useState<ModelSection[] | null>(null);
  /** 斜杠菜单的候选技能（`GET /bots/{id}/skills/catalog`，按 bot 缓存一次）。 */
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  /**
   技能清单**拉不到**时的呈现（`null` = 拿到了，可能为空）。

   与 `skills` 分开存是这一处最容易做错的地方：拉失败时 `skills` 也是空数组，两者
   不分的话界面上就是"这台 bot 没有技能"——一句假话（规则 R41）。
   */
  const [skillsFailure, setSkillsFailure] = useState<ErrorPresentation | null>(null);
  /** 重试计数：换一个值就重跑技能清单那条 effect。 */
  const [skillsAttempt, setSkillsAttempt] = useState(0);
  /** 发送失败的提示（null = 没有）。见 sendText 里为什么必须说话。 */
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   复制成功提示的出现时刻（`null` = 没有提示）。

   存**时刻**而不是布尔：连按两次复制时，第二次也要把倒计时重新起算（布尔值不变，
   `useEffect` 不会重跑，提示会提前消失）。
   */
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const queue = queueFor(chatSessionId({ isNew, routeSessionId: sessionId }));

  /**
   按钮此刻是什么（发送 / 排队 / 停止）。

   运行中按钮的语义：**有文字**排进队列、**没文字**停止；而"这个服务端到底支不支持
   队列"是探测出来的能力（实测部署版本不支持，那时运行中的按钮必须回到"停止"语义，
   与同一部署的桌面端一致），所以判据是 `composerActionWithSupport`。
   四件事（能不能点、动作、字形、读屏标签）在 `features/chat/composer.ts` 一次算齐
   ——分四处算就会出现"字形是停止、标签是发送"这种错位。
   */
  const composer = composerView({ draft, running: chat.running, support: queue.support });

  /**
   * 副标题：谁在说话 · 现在在干什么。
   *
   * 把"正在生成"放在这里，而不是在内容区挂一个悬浮胶囊——导航栏的副标题是系统里
   * 传达这类状态的既有位置。拼接在 `features/chat/copy.ts` 的 `headerSubtitle`。
   */
  const subtitle = useMemo(
    () => headerSubtitle({ bot: currentBot, running: chat.running, stale: chat.stale }, t),
    [chat.running, chat.stale, currentBot, t],
  );

  /**
   * 打开会话信息面板。
   *
   * 拉数据搬到面板自己身上了（`SessionInfoPage` 一进来就 refresh）——面板是"点开就想
   * 看到数"的东西，取数状态跟着它走，比让调用方替它记 `loading/failed` 更贴。
   */
  const openInfo = useCallback(() => {
    if (isNew) return;
    void present(SessionInfoPage, { sessionId });
  }, [isNew, sessionId]);

  /**
   复制成功的**第二重确认**。

   原生侧复制这条链是自洽的：长按菜单 → 落粘贴板 → 贴着内容的 `Copied` 胶囊 →
   读屏播报（见 `docs/CHAT-RENDERING.md` §5）。它同时把事实报上来
   （`onMessageCopied`，带**渲染后的纯文本**），宿主这一条做的是同一件事的另一种读法：

   - 文案走 App 自己的那条 key（`chat.message.copied`）——两处确认用的是同一句话，
     而不是原生一句、宿主再发明一句；
   - 读屏用 `announceForAccessibility`（iOS 上 `accessibilityLiveRegion` 是空转的，
     见 `lib/accessibility.ts` 的头注释）；
   - 屏幕上留一条可点的落点（`chat-copied-notice`，在 `ui/ChatNotices.tsx`），
     验收能断到"按了复制之后这句话出现了"。

   在这之前 `chat.message.copied` 是**孤儿 key**：kit 的 TS 面、模块注册、Swift 事件
   三段都在，只有生产宿主没人接——而孤儿 key 不会报错，只会让"复制了却毫无反馈"没法被发现。
   */
  const onMessageCopied = useCallback(() => {
    setCopiedAt(Date.now());
    announceForAccessibility(t('chat.message.copied'));
  }, [t]);

  /** 提示自己收掉（同原生那个胶囊的量级：短到不挡视线，长到看得见）。 */
  useEffect(() => {
    if (copiedAt === null) return;
    const timer = setTimeout(() => setCopiedAt(null), COPY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copiedAt]);

  // `?info=1`：验收种子要求进来就打开面板（模拟器没有点击能力）。
  // 走的是上面同一个处理函数，所以验的是产品的真实路径。
  useEffect(() => {
    if (!shouldOpenInfoOnMount({ info: params.info, isNew })) return;
    openInfo();
  }, [params.info, isNew, openInfo]);

  /**
   拉一次模型目录，只为两件事：胶囊上显示**名字**（`k3` 不是给人看的），以及在发送前
   校正失效的选择。失败不影响对话——胶囊退回"默认"。
   */
  useEffect(() => {
    if (client === null || !realtimeEnabled) return;
    let cancelled = false;
    void loadCatalog(client)
      .then((sections) => {
        if (cancelled) return;
        setCatalog(sections);
        // 目录一回来就把选择过一次的校一遍：上回的模型可能已经被禁用了。
        setChoice((previous) => verifiedChoice(previous, sections));
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, realtimeEnabled]);

  useEffect(() => {
    if (client === null || currentBot === null || !realtimeEnabled) return;
    let cancelled = false;
    void loadSkills(client, currentBot.id).then((catalog) => {
      if (cancelled) return;
      setSkills(catalog.skills);
      setSkillsFailure(catalog.failure);
    });
    return () => {
      cancelled = true;
    };
  }, [client, currentBot, realtimeEnabled, skillsAttempt]);

  const openMachine = useCallback(() => {
    const botId = currentBot?.id;
    if (botId === undefined) return;
    void present(MachinePanelSheet, { botId });
  }, [currentBot?.id]);

  const openModelPicker = useCallback(() => {
    void (async () => {
      const outcome = await present(ModelPickerSheet, choice);
      if (outcome.status !== 'completed') return;
      setChoice(outcome.value);
    })();
  }, [choice]);

  /**
   用户一动键盘就是在重试，把上一次的失败提示收掉（发送失败之后最常见的动作就是改一下再发）。
   */
  const onChangeDraft = useCallback(
    (next: string) => {
      setDraft(next);
      if (sendError !== null) setSendError(null);
    },
    [sendError],
  );

  /**
   发一条用户输入。
   
   `clearDraft` 区分两种来源：composer 里的发送（发出去就清空输入框）与错误块里的
   "再来一次"（草稿是用户正在写的东西，**不许**动它）。
   */
  const sendText = useCallback(
    (text: string, clearDraft: boolean) => {
      if (text === '') return;
      // 草稿**先留着**：只有真的发出去（或排上了）才清。失败还留着，用户不用重写。
      void submit(text, {
        modelId: choice.modelId ?? undefined,
        reasoningEffort: choice.reasoningEffort ?? undefined,
        // 正文原样带 `/name`：服务端自己从文本解析技能（见 features/chat/slash.ts）。
        requestedSkills: requestedSkillsFor(text, skills),
      }).then((result) => {
        if (result === 'sent' || result === 'queued') {
          if (clearDraft) setDraft('');
          return;
        }
        /**
         * 发不出去时**必须说话**。
         *
         * 之前这里只处理成功分支，失败就是"文字还在框里、点什么都没反应、屏幕上没有
         * 任何解释"——用户唯一能得出的结论是 App 坏了。`/chat/new` 那条路正是这样
         * 静默了很久（`submit` 当时对空 session id 直接返回 `unavailable`）。
         *
         * 把原因说出来；草稿留着不删（调用方决定）。
         */
        // 存 **key** 而不是译文：`sendError` 是状态，不是一句话。存译文的话下面渲染时
        // 还会再 `t()` 一次（`t(t(...))` 只是碰巧因为"查不到就原样返回"才没露馅）。
        const key = result === 'busy' ? 'chat.send.busy' : 'chat.send.failed';
        setSendError(key);
        announceForAccessibility(t(key));
      });
    },
    [choice.modelId, choice.reasoningEffort, skills, submit, t],
  );

  const onSend = useCallback(() => {
    const text = draft.trim();
    sendText(text, true);
  }, [draft, sendText]);

  /**
   错误块里的"再来一次"（原生 `ErrorMessageCell` 的那个按钮）。
   
   **判据在原生侧**（`ErrorBlockPresentation`：只有传输层那一档才给按钮，见
   `docs/research/ios-error-and-feedback.md` R45），这里只负责**执行**：把那一轮的用户输入重发一次。
   
   正文优先用原生带上来的那一份（它拿的是屏幕上正在显示的那条转录，不会和这里的 `turns`
   对不上）；只有在它没带的时候才按轮次回退到 `turns`。两样都空就什么都不发——宁可没有动作，
   也不发一条我们编出来的消息。
   
   （2026-09-16 实测：只按轮次找的时候，点下去界面毫无反应、固定服务端也没收到帧——两份投影
   的轮次 key 对不上，而这里那时是**静默**返回的。）
   */
  const onErrorAction = useCallback(
    (turnKey: string, nativeText: string) => {
      // 正文优先用原生带上来的那一份（它取的是**屏幕上这条错误上方最近的那条用户正文**，
      // 不会和这里的 `turns` 对不上——两条投影的轮次 key 不一样，实测过）。
      // 只有在它没带的时候才按轮次回退到 `turns`。两样都空就什么都不发——宁可没有动作，
      // 也不发一条我们编出来的消息。
      const provided = nativeText.trim();
      const text = provided === '' ? userTextOfTurn(turns, turnKey) : provided;
      sendText(text, false);
    },
    [turns, sendText],
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ChatHeader
        title={isNew ? t('home.newSession') : sessionTitle}
        subtitle={subtitle}
        stale={chat.stale}
        showMachine={currentBot !== null && canManageBot(currentBot)}
        showInfo={!isNew}
        onOpenInfo={openInfo}
        onOpenMachine={openMachine}
      />

      {/*
        连接状态、run 失败、历史没拉到、复制成功这几条横条：位置与秩序都归
        `ui/ChatNotices.tsx`（为什么在那、为什么那个形态，写在它的文件头）。
      */}
      <ChatNotices
        permissionsKnown={currentBot !== null}
        realtimeEnabled={realtimeEnabled}
        runFailure={runFailure}
        olderError={chat.olderError}
        copied={copiedAt !== null}
        onRetryOlder={() => void loadOlderHistory(sessionId)}
      />

      <NativeMessageList
        key={sessionId}
        turnsJson={turnsJson}
        style={{ flex: 1 }}
        emptyTitle={t('chat.empty.title')}
        emptyBody={t('chat.empty.body')}
        /**
         滚到顶 → 往前翻一页。

         原生列表一直在报这个事件（`NativeMessageList.swift` 的 `onReachTop`，只在用户
         进入顶部区域时触发一次，离开再进入才再次触发，不因布局更新循环请求），而 JS 侧
         此前**没人接**——于是超过 100 轮的长会话，第 101 轮往前在 App 里永远看不到。
         去重与"还有没有更早"的判据在 store（`loadOlderHistory`）与
         `features/chat/historyPage.ts`（纯逻辑，有单测），这里只负责接。

         `new`（还没建会话）没有历史可翻，不接。
         */
        onReachTop={isNew ? undefined : () => void loadOlderHistory(sessionId)}
        // 原生已经复制好了（粘贴板 + 胶囊 + 读屏），这里只是让宿主那句确认走同一套 i18n。
        // 不接也不会坏——但那条 key 就永远是孤儿（见 onMessageCopied 的注释）。
        onMessageCopied={onMessageCopied}
        // 接了才有按钮：原生只在**有人能执行**的时候显示错误块里的"再来一次"。
        // 它带上来的 `text` 是那一轮的用户原文（屏幕上那一份），`turn` 只用于回退。
        onErrorAction={
          realtimeEnabled
            ? (event) => onErrorAction(event.nativeEvent.turn ?? '', event.nativeEvent.text ?? '')
            : undefined
        }
      />

      {/* 待发队列：还没有发出去的话，排在 composer 正上方（不是消息流里）。 */}
      {realtimeEnabled ? (
        <QueueStrip queue={queue} onRemove={removeQueueItem} onPromote={promoteQueueItem} />
      ) : null}

      {/*
        刚发出去、服务端还没回显的那一句现在在哪儿（等网络 / 等确认 / 没发出去）。

        为什么必须有它：输入框在发送那一刻就清空了，而这句话要等服务端把这一轮广播
        回来才会出现在转录里。中间这段窗口（弱网、断线、服务端慢）屏幕上**什么都没有**
        ——用户唯一能得出的结论是"App 把我的话吃了"。转录里那条乐观消息现在会一直留到
        权威轮次覆盖它（见 `features/chat/reducer.ts` 的 `turnsForDisplay`），这一条则
        回答"它到底出去了没有"，并在真的失败时给一个**能执行**的动作。
      */}
      {!realtimeEnabled || pending === null ? null : (
        <PendingSendStrip
          view={pending}
          /**
           重试 = 把这句话**再发一次**。

           先撤掉本地那条失败的消息，否则同一句话会出现两个气泡；`submit` 会给它一个
           新的 `invocation_id`（上一次那个已经被服务端拒了，复用只会再被拒一次）。
           `clearDraft: false`——草稿是用户正在写的下一句，不许动。
           */
          onRetry={() => {
            discardFailedSend(sessionId);
            sendText(pendingText, false);
          }}
          /**
           重连 = 只把管子接回来，**不重发任何东西**。

           与"重试"的字面差别就是它们的区别：那一条帧可能已经在服务端手里了，
           界面不该替用户再发一遍（Lody："结果未确认时等同步，不要重发"）。
           */
          onReconnect={retryConnection}
        />
      )}

      {/*
        斜杠菜单：草稿以 `/` 开头时出现，在输入区正上方。
        它是**建议**而不是"必须选"——用户照样可以直接把 `/skill 正文` 打完发送。
      */}
      {!realtimeEnabled || slashQuery(draft) === null ? null : (
        <SlashMenu
          items={slashItems(slashQuery(draft), skills, t)}
          skillsFailure={skillsFailure}
          onRetrySkills={() => setSkillsAttempt((n) => n + 1)}
          onPick={(item: SlashItem) => {
            if (item.kind === 'skill') {
              setDraft(draftAfterSkill(item.name));
              return;
            }
            setDraft('');
            if (item.name === 'model') openModelPicker();
            if (item.name === 'new') router.replace('/chat/new');
          }}
        />
      )}

      {/*
        输入区（模型胶囊 + 输入框 + 发送/停止键）：形态、命中区、按钮语义的理由都写在
        `ui/ChatComposer.tsx` 的文件头。
      */}
      {realtimeEnabled ? (
        <ChatComposer
          draft={draft}
          view={composer}
          modelLabel={modelPillLabel(catalog, choice, t)}
          sendErrorKey={sendError}
          inputVisible={chat.userInput === null}
          onChangeDraft={onChangeDraft}
          onSend={onSend}
          onStop={abort}
          onOpenModelPicker={openModelPicker}
        />
      ) : null}

      {/* 审批不在这里渲染：它在 presented 路由上，由上面的 usePresentedPage 打开
          （原生 formSheet，见 ui/ApprovalPage.tsx）。 */}
      {/* 提问表与审批一样在 presented 路由上（原生 formSheet，见 ui/UserInputSheet.tsx），
          由下面的 usePresentedPage 打开。不可跳过——run 停在 waiting_decision 上，
          不答（或取消）它就永远不继续。 */}
    </KeyboardAvoidingView>
  );
}

/**
 复制成功提示停留多久。

1600ms 与原生那个 `Copied` 胶囊同一量级（`NativeMessageList.swift` 的
`copiedBadgeHide`）——两处确认同时出现、同时消失，才不会一个还在、另一个已经没了。
 */
const COPY_NOTICE_MS = 1600;

/** 原生列表那一帧要的东西：投影出来的轮次 + 它的 JSON（两者必须出自同一次计算）。 */
interface TranscriptSnapshot {
  turns: RenderTurn[];
  turnsJson: string;
}

function transcriptSnapshotOf(chat: ChatState): TranscriptSnapshot {
  const turns = turnsForDisplay(chat).filter(hasContent);
  return { turns, turnsJson: JSON.stringify(turns) };
}

/**
 * 原生列表转录的**节流投影**。
 *
 * 发布节奏（leading/trailing、33ms 上限、flush/reset 语义）在
 * `features/chat/streamScheduler.ts`（纯逻辑、有单测），这里只做三件接线：
 *
 *   1. 每次 `chat` 变化把最新值喂给调度器——运行中走 33ms 窗口，run 一停立即
 *      `flush()` 出最终值；
 *   2. 换会话先 `reset()`——旧会话没发出去的 trailing 值不许泄漏进新会话，
 *      新会话的当前整份立即发布（leading）；
 *   3. 卸载 `reset()`——定时器必须清掉，组件没了之后不再发布。
 *
 * 投影与序列化只在**发布时**做一次（`transcriptSnapshotOf`），不为每个 delta 都做。
 */
function useThrottledTranscript(
  chat: ChatState,
  running: boolean,
  sessionKey: string,
): TranscriptSnapshot {
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>(() => transcriptSnapshotOf(chat));
  const [scheduler] = useState(() =>
    createSnapshotScheduler<ChatState>({
      intervalMs: TRANSCRIPT_SNAPSHOT_INTERVAL_MS,
      publish: (latest) => setSnapshot(transcriptSnapshotOf(latest)),
    }),
  );

  // 换会话：丢掉旧会话没发出去的 trailing，新会话的当前整份立即发布。
  useEffect(() => {
    scheduler.reset();
    scheduler.push(chat);
    // 只认"换了会话"这条边沿；`chat` 的持续前馈在下面那条 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler, sessionKey]);

  // 持续前馈：运行中走节流窗口；run 一停立即把最终值发出去。
  useEffect(() => {
    scheduler.push(chat);
    if (!running) scheduler.flush();
  }, [scheduler, chat, running]);

  // 卸载：定时器清掉（不发布——组件已经没了）。
  useEffect(() => () => scheduler.reset(), [scheduler]);

  return snapshot;
}
