/** Chat orchestration; transcript rendering belongs to MemohKit. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';

import {
  NativeChatBarView,
  NativeChatChromeView,
  NativeMessageList,
  nativeChatSheets,
  type NativeChatBarModel,
  type NativeChatChromeModel,
  type NativeChatChromeNotice,
} from '@memoh-ios/kit';
import type { ConnectionState } from '../api/realtime.ts';
import {
  DEFAULT_CHOICE,
  loadCatalog,
  verifiedChoice,
  type ComposerChoice,
  type ModelSection,
} from '../features/chat/models.ts';
import type { SkillSummary } from '../api/types.ts';
import { presentMachinePanel } from '../features/bots/machinePanelSheet.ts';
import { SCREENSHOT_DIRECTORY } from '../features/machine/panel.ts';
import { presentModelPicker } from '../features/chat/modelPicker.ts';
import { loadSkills } from '../features/chat/skills.ts';
import { canRetry, reasonKeyOf, type ErrorPresentation } from '../features/errors/present.ts';
import {
  draftAfterSkill,
  requestedSkillsFor,
  slashItems,
  slashQuery,
} from '../features/chat/slash.ts';
import { useSession } from '../features/session/store.tsx';
import { sessionDisplayTitle } from '../features/session/displayTitle.ts';
import {
  fallbackLabelKey,
  hasContent,
  turnsForDisplay,
  type ChatState,
} from '../features/chat/reducer.ts';
import type { PendingQuestion, RenderTurn } from '../models/chat.ts';
import {
  createSnapshotScheduler,
  TRANSCRIPT_SNAPSHOT_INTERVAL_MS,
} from '../features/chat/streamScheduler.ts';
import { useT } from '../lib/i18n/useT.ts';
import { hasTranslation } from '../lib/i18n/index.ts';
import { announceForAccessibility, useAnnounceOnAppear } from '../lib/accessibility.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { pendingSendView } from '../features/chat/pending.ts';
import { queuePreview } from '../features/chat/queue.ts';
import { presentSessionInfo } from '../features/session/sessionInfoSheet.ts';
import {
  buildAnswers,
  draftText,
  EMPTY_DRAFT,
  setDraftText,
  toggleCustom,
  toggleOption,
  usesFooterInput,
  type QuestionDraft,
} from '../features/chat/userInput.ts';
import {
  headerSubtitle,
  modelPillLabel,
  runFailureNotice,
  userTextOfTurn,
  type Translate,
} from '../features/chat/copy.ts';
import { composerView } from '../features/chat/composer.ts';
import { chatSessionId, createdSessionRoute, shouldOpenSession } from '../features/chat/route.ts';
import { canManageBot } from '../features/bots/permissions.ts';

/**
 连接状态 → 文案 key。

 这张表原本住在 `ui/ConnectionBadge.tsx`（那份没导出，而这一屏的 notices 已经归原生条带，
 徽标本身在这里不再渲染），判据一字不差搬过来。`open` 一档走不到：连着且没有待发时
 整条不进 notices——正常状态不需要占位置（系统不会告诉你"电量正常"）。
 */
const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: 'chat.connecting',
  connecting: 'chat.connecting',
  reconnecting: 'chat.reconnecting',
  closed: 'chat.disconnected',
  unauthorized: 'chat.expired',
  open: 'chat.disconnected',
};

/**
 * 对话页的**编排**：把 store 里的状态接到两块原生条带（顶栏 / 底栏）与两个原生 sheet 上。
 *
 * ## 这一屏的边界
 *
 * 转录的渲染归 MemohKit（原生列表），这一层只做四件事：
 *
 * 1. **路由同步**：`/chat/new` ↔ `/chat/<id>`（判据在 `features/chat/route.ts`）；
 * 2. **取数**：模型目录、技能清单（失败也要说得出"是拉不到还是真没有"）；
 * 3. **把状态翻成界面要的东西**：run 失败那一块、副标题、按钮语义、pending 投影
 *    （分别住在 `features/chat/{copy,composer,pending}.ts`），再按原生契约序列化成两份
 *    视图模型（`NativeChatChromeModel` / `NativeChatBarModel`）；
 * 4. **接线**：把 store 的动作接到条带的事件上，以及审批 / 提问两个 sheet 的
 *    present / dismiss / 回执。
 *
 * 形态（条带、sheet、命中区、无障碍标签的落点）全在原生侧
 * （`modules/memoh-kit/ios/Chat/`）；**判据留在这里**——出哪一条 notice、按钮此刻是什么、
 * 哪一块该不该出现。原生不认识 bot、i18n、路由与服务端协议，所以它只画 + 回事件。
 */
export function ChatScreen() {
  const params = useLocalSearchParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const isNew = sessionId === 'new';

  const palette = usePalette();
  const { mode } = useTheme();
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
    respondApproval,
    respondUserInput,
    realtimeEnabled,
    currentBot,
    // 会话信息面板要的两件事：读当前状态、重拉一次（面板是普通函数，用不了 hook）。
    sessionStatusFor,
    refreshSessionStatus,
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
   判据本身仍然是纯函数（`features/chat/route.ts`）。
  */
  const chat: ChatState = chatFor(chatSessionId({ isNew, routeSessionId: sessionId }));

  /**
   原生列表的转录投影：**节流的**（最多每 33ms 一份快照，leading + trailing）。

   高频 delta 期间 `turnsForDisplay(chat)` + `JSON.stringify` 对长转录是 O(整份转录)，
   每个 delta 做一次会把桥前的 JS 线程占满——原生 `NativeMessageList` 已经在 30fps
   合并 prop，JS 侧不跟上同样的节奏，桥前的开销就没有被抑制。

   节流的只有"原生列表用的转录投影 + 序列化"（含 `pendingText` / `onErrorAction`
   对同一份投影的查找）：审批、错误、pending、按钮语义、连接态仍直读 `chat`。
   发布节奏是纯逻辑（`features/chat/streamScheduler.ts`），hook 只接线。
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
   `features/chat/copy.ts` 的 `runFailureNotice`。
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
   （`connection`）。翻译规则在 `features/chat/pending.ts`。
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
   * 服务端说"我在等你批准" → 叫原生 sheet 出来。
   *
   * 审批不是用户点出来的，所以这里把状态翻成一次**出席**：同一份审批只 present 一次
   * （`approvalAnsweredRef` 就是原来那把"会话:审批"钥匙里的审批那一半），换一份审批会
   * 再 present 一次。present 是幂等的（原生侧已在就只换模型），所以模型变了重发一份
   * 也没关系。
   */
  const approvalAnsweredRef = useRef<string | null>(null);
  const userInputAnsweredRef = useRef<string | null>(null);

  /**
   换会话：本地那两条"答过了"的事实跟着作废。

   它们原来是页面内部的 state，而页面是按 `会话 id : 待办 id` 为钥匙挂载/卸载的——
   钥匙里那一段会话 id 的语义，现在由这里补上。
   */
  useEffect(() => {
    approvalAnsweredRef.current = null;
    userInputAnsweredRef.current = null;
  }, [sessionId]);

  const approvalJson = useMemo(() => {
    const approval = chat.approval;
    if (approval === null) return '';
    const model: ApprovalSheetModel = {
      title: t('approval.title'),
      subtitle: t('approval.subtitle'),
      toolName: approval.toolName,
      toolInput: approval.toolInput === undefined ? '' : formatInput(approval.toolInput),
      options: approval.options.map((option) => ({
        id: option.id,
        // 三层来源照原 ChoiceButton：agent 给的名字 → 我们的兜底 key（`__fallback_*` 的
        // label 存的是 i18n key）→ 按语气兜底。第 2 层必须走 i18n：那个动作是我们造的。
        label:
          option.label !== undefined && option.label !== ''
            ? option.label.startsWith('approval.')
              ? t(option.label)
              : option.label
            : t(fallbackLabelKey(option)),
        tone: option.tone,
      })),
      rejectReasonLabel: t('approval.rejectReason.label'),
      rejectReasonPlaceholder: t('approval.rejectReason.placeholder'),
      rejectConfirmLabel: t('approval.rejectReason.confirm'),
      cancelLabel: t('common.cancel'),
    };
    return JSON.stringify(model);
  }, [chat.approval, t]);

  useEffect(() => {
    // 每次现读 facade（模块级单例，且老 dev client 里可能是 null）——不提到组件体里，
    // 是因为"来自函数调用的中间变量用在两处"会让 React Compiler 跳过整屏的记忆化。
    const sheets = nativeChatSheets();
    if (sheets === null) return;
    const approval = chat.approval;
    if (approval !== null && approvalAnsweredRef.current !== approval.approvalId) {
      void sheets.chatPresentApproval(approvalJson);
      return;
    }
    /**
     关掉它的判据照原 `ApprovalPresentedView`：答过，或状态不再说"在等你"。

     `waiting_decision` 是权威——只看 `approval === null` 会被订阅握手的几帧骗到
     （实测 `approval=3c079d30 → null → 3c079d30`），sheet 会在升起来的那一刻自己缩回去，
     而 run 其实还在等你。没在呈现时 dismiss 是空操作，所以这里可以无条件叫。
     */
    const stillWaiting = chat.runStatus === 'waiting_decision' || approval !== null;
    if (!stillWaiting) void sheets.chatDismissApproval();
  }, [chat.approval, chat.runStatus, approvalJson]);

  useEffect(() => {
    const sheets = nativeChatSheets();
    if (sheets === null) return;
    const subscription = sheets.addListener('onChatApprovalChoose', (payload) => {
      const optionId = payload.optionId;
      const approval = chat.approval;
      if (typeof optionId !== 'string' || approval === null) return;
      // 先记"答过了"再叫它收掉：用户点完就该看到它关掉，不该等下一个快照。
      approvalAnsweredRef.current = approval.approvalId;
      void sheets.chatDismissApproval();
      const reason = payload.reason ?? '';
      // 空理由不许变成一个空字段（见 `features/chat/approval.ts`）。
      respondApproval(optionId, sessionId, reason === '' ? undefined : reason);
    });
    return () => subscription.remove();
  }, [chat.approval, respondApproval, sessionId]);

  /**
   agent 提问（`ask_user`）的草稿。

   与原来一样按题 id 索引；不同的是**重置的判据**：原来靠 `key={userInputId}` 重新挂载
   组件来清空，现在这一层没有可挂载的东西，于是把"这份草稿属于哪一份提问"存进 state
   自己——换提问（新的 userInputId）读到的就是空表。用 effect 清空也能达到同样的效果，
   但那会多一次级联渲染（lint 的 `set-state-in-effect`）。
   */
  const [draftsState, setDraftsState] = useState<{
    userInputId: string | null;
    drafts: Record<string, QuestionDraft>;
  }>({ userInputId: null, drafts: {} });
  const activeUserInputId = chat.userInput?.userInputId ?? null;
  // 包一层 `useMemo`：这个条件取值进了下面几个 hook 的依赖，现算会让它们每次渲染都重跑
  // （`react-hooks/exhaustive-deps`），而 React Compiler 会因此整屏放弃记忆化。
  const uiDrafts = useMemo(
    () => (draftsState.userInputId === activeUserInputId ? draftsState.drafts : {}),
    [activeUserInputId, draftsState],
  );

  /**
   改一道题的草稿。换提问之后第一次写会从空表开始（见上面的注释）。

   传进来的是"用户做了什么"（`DraftEdit`）而不是一个 `(draft) => draft` 的闭包：后者
   （在被调用的那一刻才求值）会让 React Compiler 放弃编译这一屏——实测
   `react-hooks/preserve-manual-memoization` 直接报错，而这里的下一份草稿本来就只由
   "当前草稿 + 这一次动作"决定。
   */
  const updateDraft = useCallback(
    (question: PendingQuestion, edit: DraftEdit) => {
      setDraftsState((current) => {
        const base = current.userInputId === activeUserInputId ? current.drafts : {};
        const draft = base[question.questionId] ?? EMPTY_DRAFT;
        return {
          userInputId: activeUserInputId,
          drafts: { ...base, [question.questionId]: applyDraftEdit(question, draft, edit) },
        };
      });
    },
    [activeUserInputId],
  );

  const userInputJson = useMemo(() => {
    const userInput = chat.userInput;
    if (userInput === null) return '';
    const questions: UserInputSheetQuestion[] = userInput.questions.map((question) => ({
      id: question.questionId,
      text: question.text,
      required: question.required,
      kind: question.kind,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description ?? '',
      })),
      allowCustom: question.allowCustom,
      placeholder: question.placeholder ?? '',
    }));
    // 只下发**答过的**题：原生缺省按空草稿画（`UserInputSheetModel.draft(_:)`）。
    const drafts: Record<string, UserInputSheetDraft> = {};
    for (const question of userInput.questions) {
      const draft = uiDrafts[question.questionId];
      if (draft === undefined) continue;
      drafts[question.questionId] = {
        optionIds: draft.optionIds,
        customSelected: draft.customSelected,
        // 原生只有一个 `text`：文本题的答案与"其他"里的自定义文本本来就是二选一
        // （见 `UserInputSheetModel.Draft` 的注释），这里用同一个函数折叠。
        text: draftText(question, draft),
      };
    }
    const only = userInput.questions.length === 1 ? userInput.questions[0] : undefined;
    const footerQuestion = only !== undefined && usesFooterInput(only) ? only : null;
    const model: UserInputSheetModel = {
      title:
        userInput.shortId !== undefined
          ? t('askUser.titleWithId', { id: userInput.shortId })
          : t('askUser.title'),
      subtitle: t('askUser.subtitle'),
      questions,
      drafts,
      footerInput: footerQuestion !== null,
      footerPlaceholder:
        footerQuestion === null ? '' : (footerQuestion.placeholder ?? t('askUser.placeholder')),
      // "能不能提交"只在 RN 算（`buildAnswers`）：判错了的代价是服务端拒收 + run 静默卡住。
      canSubmit: buildAnswers(userInput.questions, uiDrafts) !== null,
      submitLabel: t('askUser.submit'),
      cancelLabel: t('askUser.cancel'),
      otherLabel: t('askUser.other'),
      requiredLabel: t('askUser.required'),
    };
    return JSON.stringify(model);
  }, [chat.userInput, t, uiDrafts]);

  useEffect(() => {
    const sheets = nativeChatSheets();
    if (sheets === null) return;
    const userInput = chat.userInput;
    if (userInput !== null && userInputAnsweredRef.current !== userInput.userInputId) {
      void sheets.chatPresentUserInput(userInputJson);
      return;
    }
    // 关掉它的判据与审批同一条：答过，或状态不再说"在等你"（`waiting_decision` 是权威）。
    const stillWaiting = chat.runStatus === 'waiting_decision' || userInput !== null;
    if (!stillWaiting) void sheets.chatDismissUserInput();
  }, [chat.runStatus, chat.userInput, userInputJson]);

  useEffect(() => {
    const sheets = nativeChatSheets();
    if (sheets === null) return;
    const subscription = sheets.addListener('onChatUserInputEvent', (payload) => {
      const userInput = chat.userInput;
      if (userInput === null) return;
      const questionId = payload.questionId ?? '';
      const question = userInput.questions.find((entry) => entry.questionId === questionId);
      switch (payload.type) {
        case 'toggleOption': {
          const optionId = payload.optionId;
          if (question === undefined || optionId === undefined) return;
          updateDraft(question, { kind: 'toggleOption', optionId });
          return;
        }
        case 'toggleCustom': {
          if (question === undefined) return;
          updateDraft(question, { kind: 'toggleCustom' });
          return;
        }
        case 'setText': {
          if (question === undefined) return;
          updateDraft(question, { kind: 'setText', text: payload.text ?? '' });
          return;
        }
        case 'footerText': {
          // 底部输入框只属于"只有一道题"的那种表单（`footerInput` 是这么下发的）。
          const only = userInput.questions.length === 1 ? userInput.questions[0] : undefined;
          if (only === undefined) return;
          updateDraft(only, { kind: 'setText', text: payload.text ?? '' });
          return;
        }
        case 'submit': {
          const answers = buildAnswers(userInput.questions, uiDrafts);
          // 答不完整时原生那边提交键本就是禁用的；这里再判一次，不发半个答案出去。
          if (answers === null) return;
          userInputAnsweredRef.current = userInput.userInputId;
          void sheets.chatDismissUserInput();
          respondUserInput({ answers }, sessionId);
          return;
        }
        case 'cancel': {
          userInputAnsweredRef.current = userInput.userInputId;
          void sheets.chatDismissUserInput();
          respondUserInput({ canceled: true }, sessionId);
          return;
        }
        default:
          return;
      }
    });
    return () => subscription.remove();
  }, [chat.userInput, respondUserInput, sessionId, uiDrafts, updateDraft]);

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
   条带高度：初值只是量级，第一帧后由原生 `onHeight` 校正。

   条带不是 `flex: 1`（高度随 notices、队列、输入框行数、Dynamic Type 变），而 Yoga
   不会按原生内容给高——不给高就是 0 或者被压扁。
   */
  const [chromeH, setChromeH] = useState(120);
  const [barH, setBarH] = useState(140);

  /**
   顶栏那一条的视图模型（原生只画，判据全在这里）。

   notices 的顺序就是原来 `ui/ChatNotices.tsx` 里的顺序：连接是最外层的环境，run 失败是
   这一轮的结局，历史失败是翻页的结果，复制成功是一次瞬时确认。
   */
  const chromeJson = useMemo(() => {
    const title = isNew ? t('home.newSession') : sessionTitle;
    const notices: NativeChatChromeNotice[] = [];

    // 权限层面的缺失，不是故障：只说一句。bot 还没拉到时保持静默——不能把"权限未知"
    // 说成"此账号不能发起实时对话"。
    if (currentBot !== null && !realtimeEnabled) {
      const text = t('chat.readOnly');
      notices.push({
        id: 'chat-read-only',
        tone: 'info',
        text,
        detail: '',
        action: '',
        actionLabel: '',
        a11y: text,
      });
    }

    /**
     连接：正常（`open` 且没有待发）时不说话——正常状态不需要占位置。

     一个例外：`pendingSends > 0`。有帧还没送出去就必须说（那说明刚才是断的），哪怕
     此刻"看起来连着"。整条是可点的（弱网下"现在再试一次"是用户最想做的事），所以
     `action` 恒为 `reconnect`——与徽标一样，点它就是 `retryConnection`，不重发任何东西。
     */
    if (realtimeEnabled && (state.connection !== 'open' || state.pendingSends > 0)) {
      const text = t(CONNECTION_LABELS[state.connection]);
      const detail = state.pendingSends > 0 ? t('chat.pending', { count: state.pendingSends }) : '';
      // 读屏要听到两行：这个 Pressable 是一个整体，里面的字对读屏是看不见的。
      const a11y = detail === '' ? text : `${text} · ${detail}`;
      notices.push({
        id: 'chat-connection',
        tone: 'info',
        text,
        detail,
        action: 'reconnect',
        actionLabel: t('chat.connection.retryHint'),
        a11y,
      });
    }

    // run 失败：一行标题 + 一行原因，**就地**贴在消息流上方。它不是"必须打断"的事
    // （agent 已经停了，没有数据会丢），所以不进 alert（规则 R4/R10）。
    if (runFailure !== null) {
      notices.push({
        id: 'chat-run-failed',
        tone: 'error',
        text: t('chat.run.failed'),
        detail: runFailure.reason ?? '',
        action: '',
        actionLabel: '',
        a11y: runFailure.label,
      });
    }

    // 更早的历史没拉到：说一句，并给一个**能执行**的动作。游标在失败时是留着的
    // （见 `olderHistoryFailed`），所以那个动作是真的有用。
    if (chat.olderError !== null) {
      const text = t('chat.history.failed');
      notices.push({
        id: 'chat-older-failed',
        tone: 'error',
        text,
        detail: `${t(chat.olderError)} · ${t('common.retry')}`,
        action: 'retryOlder',
        actionLabel: t('common.retry'),
        a11y: `${text} · ${t(chat.olderError)}`,
      });
    }

    // 复制成功：一行轻提示。原生那边贴着消息的 `Copied` 胶囊负责"哪一条被复制了"，
    // 这一行负责"这件事在 App 自己的文案体系里被确认过"。
    if (copiedAt !== null) {
      notices.push({
        id: 'chat-copied-notice',
        tone: 'info',
        text: t('chat.message.copied'),
        detail: '',
        action: '',
        actionLabel: '',
        a11y: '',
      });
    }

    const model: NativeChatChromeModel = {
      title,
      subtitle,
      staleLabel: chat.stale ? t('chat.gap') : '',
      // 这颗按钮同时承担"我在哪个会话"与"点开会话信息"两件事：只念 Session info 会把
      // 屏幕上最重要的会话名从 VoiceOver 树里吃掉。
      titleA11y: `${title}, ${t('sessionInfo.open')}`,
      titleHint: t('sessionInfo.title'),
      backLabel: t('common.back'),
      showMachine: currentBot !== null && canManageBot(currentBot),
      machineLabel: t('machine.open'),
      showInfo: !isNew,
      infoLabel: t('sessionInfo.open'),
      notices,
    };
    return JSON.stringify(model);
  }, [
    chat.olderError,
    chat.stale,
    copiedAt,
    currentBot,
    isNew,
    realtimeEnabled,
    runFailure,
    sessionTitle,
    state.connection,
    state.pendingSends,
    subtitle,
    t,
  ]);

  /**
   底栏那一叠条带的视图模型（队列 / 待发 / 斜杠菜单 / 模型胶囊 / 输入行）。

   `queue` / `pending` / `slash` 三块**整块可缺省**：缺省 = 那一块不画。判据照原来的
   `QueueStrip` / `PendingSendStrip` / `SlashMenu` 的提前返回，一处不改。

   `inputVisible` 多带一个 `realtimeEnabled`：没有实时通道的账号原本**整块 composer 都
   不画**（那台部署上"能打字但发不出去"比没有输入框更坏）。输入行收起时胶囊行还在，
   与 agent 提问期间的处理一致。
   */
  const barJson = useMemo(() => {
    const slash = slashQuery(draft);
    const slashVisible = realtimeEnabled && slash !== null;
    const slashList = slashVisible ? slashItems(slash, skills, t) : [];
    const pillLabel = modelPillLabel(catalog, choice, t);

    let queueBlock: NativeChatBarModel['queue'] = null;
    if (realtimeEnabled && (queue.items.length > 0 || queue.error !== null)) {
      // 只摊开前几条：这一块钉在输入框上方，它越长，正在读的正文被顶掉得越多。
      const preview = queuePreview(queue.items);
      queueBlock = {
        items: preview.visible.map((item) => ({
          id: item.itemId,
          // kind 是给用户的语义：steer 现在就会看到，follow-up 要等这轮跑完。
          kindLabel: item.kind === 'steer' ? t('queue.steer') : t('queue.followUp'),
          text: item.text,
          // 只有 follow-up 能提成 steer：steer 已经在被取用了，没有"更早"可提。
          canSteer: item.kind === 'follow-up' && queue.steerSupported,
          steerLabel: t('queue.steerNow'),
          removeLabel: t('queue.remove'),
        })),
        hiddenLabel: preview.hidden > 0 ? t('queue.hidden', { count: preview.hidden }) : '',
        error: queue.error !== null ? t('queue.failed') : '',
      };
    }

    let pendingBlock: NativeChatBarModel['pending'] = null;
    if (realtimeEnabled && pending !== null) {
      pendingBlock = {
        text: t(pending.textKey),
        reason: pending.reason ?? '',
        action: pending.action?.id ?? '',
        actionLabel: pending.action === null ? '' : t(pending.action.labelKey),
        // 两个动作的效果不同，只念标签会让读屏用户以为它们是一回事。
        actionHint: pending.action === null ? '' : t(pending.action.hintKey),
        // 失败的红字与原 RN 条带同一判据（`phase === 'failed'`）。
        tone: pending.phase === 'failed' ? 'error' : 'info',
      };
    }

    let slashBlock: NativeChatBarModel['slash'] = null;
    if (slashVisible && (slashList.length > 0 || skillsFailure !== null)) {
      slashBlock = {
        items: slashList.map((item) => ({
          id: `${item.kind}:${item.name}`,
          name: item.name,
          label: item.label,
          // 内置动作给的是 i18n key（它要翻译），技能给的是服务端原文
          // （技能名与说明是用户自己写进容器的，翻译它只会让用户找不到自己那个技能）。
          description: item.descriptionIsKey ? t(item.description) : item.description,
        })),
        failureTitle: skillsFailure === null ? '' : t('chat.slash.skillsFailed'),
        failureBody: skillsFailure === null ? '' : t(reasonKeyOf(skillsFailure)),
        // 凭据失效/没权限时这一块只有一句解释，没有可点的东西（规则 R19/R21）。
        retryLabel: skillsFailure !== null && canRetry(skillsFailure) ? t('common.retry') : '',
      };
    }

    const model: NativeChatBarModel = {
      queue: queueBlock,
      pending: pendingBlock,
      slash: slashBlock,
      pillLabel,
      // 标签里带上**当前值**：只念"选择模型"的话，VoiceOver 用户听不出现在用的是什么。
      pillA11y: `${t('chat.model.a11y')}, ${pillLabel}`,
      inputVisible: realtimeEnabled && chat.userInput === null,
      draft,
      placeholder: t('chat.placeholder'),
      sendError: sendError === null ? '' : t(sendError),
      canSend: composer.canSend,
      buttonGlyph: composer.glyph,
      buttonA11y: t(composer.labelKey),
    };
    return JSON.stringify(model);
  }, [
    catalog,
    chat.userInput,
    choice,
    // 逐字段列而不是整个 `composer` 对象：那个对象每次渲染都是新的，整个列进去会让
    // 这份 JSON 每渲染一次就重算一次，原生也就每次都要重解一遍模型（还会重新量高）。
    composer.canSend,
    composer.glyph,
    composer.labelKey,
    draft,
    pending,
    queue,
    realtimeEnabled,
    sendError,
    skills,
    skillsFailure,
    t,
  ]);

  /**
   两处**原来由被删掉的组件自己播报**的话（规则 R28：自己出现的东西要念一次）。

   - 「登录已过期」是唯一一条走到头了的结论（只有重新登录能解决），原来在
     `ui/ConnectionBadge.tsx` 里播报；"重连中 ↔ 已连上"每几秒翻一次，那些不念。
   - 技能清单拉不到，原来由 `ui/ErrorNotice.tsx` 播报（菜单里那一块），整句与它拼的
     一致。只有菜单真的在屏幕上时才念——不然用户会听到一块看不见的错误。
   */
  useAnnounceOnAppear(
    realtimeEnabled && state.connection === 'unauthorized'
      ? t(CONNECTION_LABELS.unauthorized)
      : null,
  );
  useAnnounceOnAppear(
    realtimeEnabled && slashQuery(draft) !== null ? skillsFailureLabel(skillsFailure, t) : null,
  );

  /**
   * 打开会话信息面板。
   *
   * 拉数据搬到面板自己身上了（它一进来就 `refresh()`）——面板是"点开就想看到数"的东西，
   * 取数状态跟着它走，比让调用方替它记 `loading/failed` 更贴。**"不编数"那条判据也在面板里**
   * （有没有上下文窗口由 `sessionInfoView` 判），这里只把三件事递进去：读状态、重拉、压缩。
   */
  const openInfo = useCallback(() => {
    if (isNew) return;
    void presentSessionInfo({
      sessionId,
      readStatus: () => sessionStatusFor(sessionId),
      refresh: () => refreshSessionStatus(sessionId),
      // 只有拿得到 client 与 botId 时才给"立即压缩"这个动作（深链进来、会话还没落地）。
      compact: client === null || currentBot === null ? null : { client, botId: currentBot.id },
    });
  }, [client, currentBot, isNew, refreshSessionStatus, sessionId, sessionStatusFor]);

  /**
   复制成功的**第二重确认**。

   原生侧复制这条链是自洽的：长按菜单 → 落粘贴板 → 贴着内容的 `Copied` 胶囊 →
   读屏播报（见 `docs/CHAT-RENDERING.md` §5）。它同时把事实报上来
   （`onMessageCopied`，带**渲染后的纯文本**），宿主这一条做的是同一件事的另一种读法：

   - 文案走 App 自己的那条 key（`chat.message.copied`）——两处确认用的是同一句话，
     而不是原生一句、宿主再发明一句；
   - 读屏用 `announceForAccessibility`（iOS 上 `accessibilityLiveRegion` 是空转的，
     见 `lib/accessibility.ts` 的头注释）；
   - 屏幕上留一条可点的落点（`chat-copied-notice`，在顶栏那条 notices 里），
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
    void (async () => {
      const outcome = await presentMachinePanel({ client, botId });
      if (outcome.status !== 'completed') return;
      // 面板上的"看截图"是一个**动作**：sheet 是原生 present 的，压在 RN 栈上面——
      // 不先等它收掉就 push，用户按了什么都不会发生（见 `machinePanelSheet.ts` 文件头）。
      if (outcome.value.action === 'openScreenshots') router.push(`/files/${SCREENSHOT_DIRECTORY}`);
    })();
  }, [client, currentBot?.id, router]);

  const openModelPicker = useCallback(() => {
    void (async () => {
      const outcome = await presentModelPicker({ client, choice });
      if (outcome.status !== 'completed') return;
      setChoice(outcome.value);
    })();
  }, [choice, client]);

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

  /**
   返回：能回就回，回不去就 `replace` 到首页。

   与 `ui/BackButton.tsx` 同一套兜底（原来表头给它的落点就是 `/`）——这一屏也能被深链
   直达、也能在状态恢复后成为栈底，那时 `back()` 会抛
   `The action 'GO_BACK' was not handled by any navigator`。
   */
  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  /**
   条带高度的回授（原生 `onHeight`）。

   差不到 0.5pt 就不更新——原生那边已经去过重，这里再挡一层是防两个来源各自量出差
   一点点的高来回抖动，那会把整屏重排。
   */
  const onChromeHeight = useCallback((event: { nativeEvent: { height?: number } }) => {
    const next = event.nativeEvent.height;
    if (typeof next !== 'number' || !Number.isFinite(next)) return;
    setChromeH((current) => (Math.abs(current - next) < 0.5 ? current : next));
  }, []);

  const onBarHeight = useCallback((event: { nativeEvent: { height?: number } }) => {
    const next = event.nativeEvent.height;
    if (typeof next !== 'number' || !Number.isFinite(next)) return;
    setBarH((current) => (Math.abs(current - next) < 0.5 ? current : next));
  }, []);

  /**
   通知横条上的动作。

   两条可点的横条各对应一个既有入口：更早的历史没拉到 → 再翻一页（游标留着，这一下真的
   有用）；连接不正常 → 把管子接回来（`retryConnection` 不重发任何东西）。
   */
  const onNoticeAction = useCallback(
    (id: string) => {
      if (id === 'chat-older-failed') void loadOlderHistory(sessionId);
      if (id === 'chat-connection') retryConnection();
    },
    [loadOlderHistory, retryConnection, sessionId],
  );

  /**
   队列行的两个动作：载荷只有 id（原生不认识队列项），所以按 id 找回 store 里那一份。

   找不到就当它已经被取用掉了，什么都不做——**不能**凭一个 id 编一条出来。
   */
  const onQueueRemove = useCallback(
    (id: string) => {
      const item = queue.items.find((entry) => entry.itemId === id);
      if (item === undefined) return;
      removeQueueItem(item);
    },
    [queue.items, removeQueueItem],
  );

  const onQueueSteer = useCallback(
    (id: string) => {
      const item = queue.items.find((entry) => entry.itemId === id);
      if (item === undefined) return;
      promoteQueueItem(item);
    },
    [queue.items, promoteQueueItem],
  );

  /**
   待发那一条的动作。两个动作的语义差别见 `features/chat/pending.ts`：**重试**是先撤掉本地
   那条失败的消息再原样重发（否则同一句话会出现两个气泡），**重连**只是把管子接回来，
   不重发任何东西（那一条帧可能已经在服务端手里了）。
   */
  const onPendingAction = useCallback(
    (action: string) => {
      if (action === 'retry') {
        discardFailedSend(sessionId);
        sendText(pendingText, false);
        return;
      }
      if (action === 'reconnect') retryConnection();
    },
    [discardFailedSend, pendingText, retryConnection, sendText, sessionId],
  );

  /**
   选了一条斜杠命令。

   与原来 `ui/SlashMenu.tsx` 的 `onPick` 同一套：技能把 `/name ` 填进草稿（光标落在参数处，
   用户接着写）；内置动作立刻执行，草稿清掉。

   清单在这里**重算一次**（而不是共享外面那份）：原生只回名字，得按名字找回 `SlashItem`
   才知道它是技能还是内置动作；而"来自函数调用的中间变量用在两处"会让 React Compiler
   跳过整屏的记忆化（见上面 `chatSessionId` 那段）。一次点击的这点开销无所谓。
   */
  const onSlashPick = useCallback(
    (name: string) => {
      const slash = slashQuery(draft);
      const item =
        slash === null
          ? undefined
          : slashItems(slash, skills, t).find((entry) => entry.name === name);
      if (item === undefined) return;
      if (item.kind === 'skill') {
        setDraft(draftAfterSkill(item.name));
        return;
      }
      setDraft('');
      if (item.name === 'model') openModelPicker();
      if (item.name === 'new') router.replace('/chat/new');
    },
    [draft, openModelPicker, router, skills, t],
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/*
        顶栏（返回 / 标题 / 机器 / 信息）+ notices 横条：一条原生条带。
        高度由原生量好回授（`onHeight`）——它不是 flex: 1，Yoga 不会按原生内容给高。
      */}
      <NativeChatChromeView
        mode={mode}
        modelJson={chromeJson}
        style={{ height: chromeH }}
        onBack={onBack}
        onOpenInfo={openInfo}
        onOpenMachine={openMachine}
        onNoticeAction={(event) => onNoticeAction(event.nativeEvent.id ?? '')}
        onHeight={onChromeHeight}
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
         `features/chat/historyPage.ts`，这里只负责接。

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

      {/*
        底栏：队列条 → 待发条 → 斜杠菜单 → 模型胶囊 → 输入行，一整条原生条带。
        哪一块出现、写什么、能不能点，全由 `barJson` 判好（判据与原来那五个组件一字不差）；
        高度同样由原生回授。

        待发那一条为什么必须有：输入框在发送那一刻就清空了，而这句话要等服务端把这一轮
        广播回来才会出现在转录里。中间这段窗口（弱网、断线、服务端慢）屏幕上**什么都没有**
        ——用户唯一能得出的结论是"App 把我的话吃了"。

        斜杠菜单是**建议**而不是"必须选"：用户照样可以直接把 `/skill 正文` 打完发送。
      */}
      <NativeChatBarView
        mode={mode}
        modelJson={barJson}
        style={{ height: barH }}
        onField={(event) => onChangeDraft(event.nativeEvent.draft ?? '')}
        onSend={onSend}
        onStop={abort}
        onPill={openModelPicker}
        onQueueRemove={(event) => onQueueRemove(event.nativeEvent.id ?? '')}
        onQueueSteer={(event) => onQueueSteer(event.nativeEvent.id ?? '')}
        onPendingAction={(event) => onPendingAction(event.nativeEvent.action ?? '')}
        onSlashPick={(event) => onSlashPick(event.nativeEvent.name ?? '')}
        onSlashRetry={() => setSkillsAttempt((n) => n + 1)}
        onHeight={onBarHeight}
      />

      {/* 审批与提问都不在这里渲染：它们是原生 UIKit sheet（`ChatSheetPresenter`），
          由上面的 present/dismiss 接线按 store 状态叫出来。不可滑掉——run 停在
          `waiting_decision` 上，不答（或取消）它就永远不继续。 */}
    </KeyboardAvoidingView>
  );
}

/**
 复制成功提示停留多久。

1600ms 与原生那个 `Copied` 胶囊同一量级（`NativeMessageList.swift` 的
`copiedBadgeHide`）——两处确认同时出现、同时消失，才不会一个还在、另一个已经没了。
 */
const COPY_NOTICE_MS = 1600;

/**
 审批 / 提问两份 sheet 的模型（原生契约见
 `modules/memoh-kit/ios/Chat/ChatSheetsContract.swift`）。

 kit 的 TS 面只导出了 facade（`nativeChatSheets`）与事件载荷，没有导出这两份模型类型
（原生那两份是 `Decodable` 结构体），所以按契约逐字段写一份——它只在本文件里用来钉住
下发的 JSON 形状，字段名以原生那份为准。
 */
interface ApprovalSheetOption {
  id: string;
  label: string;
  tone: 'allow' | 'reject' | 'neutral';
}

interface ApprovalSheetModel {
  title: string;
  subtitle: string;
  /** 空串 = 不画工具块（拿不到工具名的审批只给选项）。 */
  toolName: string;
  /** `formatInput` 格式化好的纯文本；空串 = 不画。 */
  toolInput: string;
  options: ApprovalSheetOption[];
  rejectReasonLabel: string;
  rejectReasonPlaceholder: string;
  rejectConfirmLabel: string;
  cancelLabel: string;
}

interface UserInputSheetOption {
  id: string;
  label: string;
  description: string;
}

interface UserInputSheetQuestion {
  id: string;
  text: string;
  required: boolean;
  /** `single_select | multi_select | text`；只决定画选项行还是输入框。 */
  kind: string;
  options: UserInputSheetOption[];
  allowCustom: boolean;
  placeholder: string;
}

/** 一道题的草稿。原生只按它画选中态，**不判断**它合不合法。 */
interface UserInputSheetDraft {
  optionIds: string[];
  customSelected: boolean;
  /** 文本题的答案与"其他"里的自定义文本折叠成同一个字段（见原生那份的注释）。 */
  text: string;
}

interface UserInputSheetModel {
  title: string;
  subtitle: string;
  questions: UserInputSheetQuestion[];
  drafts: Record<string, UserInputSheetDraft>;
  /** 单问题且该用底部输入框（文本题、或允许自定义的单选）。 */
  footerInput: boolean;
  footerPlaceholder: string;
  /** 由 RN 算好（`buildAnswers`）；原生只按它画提交键的可用态。 */
  canSubmit: boolean;
  submitLabel: string;
  cancelLabel: string;
  otherLabel: string;
  requiredLabel: string;
}

/**
 * 工具入参的展示。
 *
 * 与原生消息卡片的入参摘要保持同一套规则（见 `modules/memoh-kit/ios/Chat/Transcript.swift`
 * 的 `ToolInput.preview`）：**扁平对象渲染成 `key: value` 每行一条，不吐 JSON 语法**。
 * 同一个屏幕上两处显示同一份入参却格式不一致，用户会以为看的是两件不同的事。
 *
 * 嵌套或数组退回 JSON——那种情况不多，也不该由半吊子的人肉格式化去猜。
 */
function formatInput(input: unknown): string {
  const LIMIT = 2000;
  const clip = (text: string) => (text.length > LIMIT ? `${text.slice(0, LIMIT)}…` : text);
  try {
    if (typeof input === 'string') return clip(input);

    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const entries = Object.entries(input as Record<string, unknown>);
      const allScalar = entries.every(
        ([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
      );
      if (allScalar && entries.length > 0) {
        return clip(
          [...entries]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}: ${value === null ? '' : String(value)}`)
            .join('\n'),
        );
      }
    }

    return clip(JSON.stringify(input, null, 2));
  } catch {
    return String(input);
  }
}

/**
 技能清单拉不到时读屏要念的那一句。

 拼法与 `ui/ErrorNotice.tsx` 一致（它把三样串成一句：发生了什么 → 为什么 → 能做什么），
 因为那一块原来就是它画的；不可重试时没有最后一段（规则 R19/R21）。
 */
function skillsFailureLabel(failure: ErrorPresentation | null, t: Translate): string | null {
  if (failure === null) return null;
  const parts = [t('chat.slash.skillsFailed'), t(reasonKeyOf(failure))];
  if (canRetry(failure)) parts.push(t('common.retry'));
  return parts.join(' ');
}

/** 用户在一道题上做的一件事（原生只报"发生了什么"，落到草稿上的判据在 `userInput.ts`）。 */
type DraftEdit =
  | { kind: 'toggleOption'; optionId: string }
  | { kind: 'toggleCustom' }
  | { kind: 'setText'; text: string };

/** 把一次动作落到草稿上。判据全在 `features/chat/userInput.ts`，这里只分发。 */
function applyDraftEdit(
  question: PendingQuestion,
  draft: QuestionDraft,
  edit: DraftEdit,
): QuestionDraft {
  if (edit.kind === 'toggleOption') return toggleOption(question, draft, edit.optionId);
  if (edit.kind === 'toggleCustom') return toggleCustom(question, draft);
  return setDraftText(question, draft, edit.text);
}

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
 * `features/chat/streamScheduler.ts`，这里只做三件接线：
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
