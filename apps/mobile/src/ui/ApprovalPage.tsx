/**
 * 工具审批面板（原生 formSheet）。
 *
 * 这是移动端最重要的一个界面。五条硬要求：
 *
 * 1. **渲染 agent 给的 options，不写死两个按钮。** agent 自己定义权限选项
 *    （`allow_once` / `allow_always` / `reject_once` / `reject_always`），没有它们
 *    用户永远选不到 session / always 作用域。
 *
 * 2. **不可跳过。** run 停在 `waiting_decision` 上，不回应就永远不继续。所以它是
 *    `dismissible: false` 的 sheet——侧滑关掉它等于让 run 挂在那里，而用户以为自己
 *    "处理过了"。
 *
 * 3. **展示足够判断的信息**：哪个工具、要做什么。用户在外面用手机点"允许"，必须
 *    能看清自己批准的是什么。
 *
 * 4. **拒绝时先问一句理由**（桌面端 `tool-approval-actions.vue` 的 `rejecting` 那一步）：
 *    理由随 `tool_approval_response` 的 `reason` 发给服务端，模型据此知道该换个做法；
 *    不写理由它只看到"被拒绝了"，下一轮很可能原样再试一次。帧参数在
 *    `features/chat/approval.ts`（空理由不许变成一个空字段）。
 *
 * 5. **用原生 formSheet，不是自绘的透明 Modal**（`docs/research/memoh-design-baseline.md`
 *    §7.4）：自绘 Modal 拿不到 detent、抓手、圆角与滚动边缘；而审批的内容高度不固定
 *    （工具入参可能很长），必须靠 detent 兜住——`pageSheet` 是固定全高，detent 给不出效果。
 *
 * ## 分成两半：`ApprovalView` 与 `ApprovalPage`
 *
 * - `ApprovalView` 是**纯展示**：给它一份审批和一个回调，它画出来。
 * - `ApprovalPage` 是**出席页面**：数据来自 store（服务端权威），关掉自己交给契约。
 *
 * 数据不放 `params` 里：审批可能在 sheet 打开期间被解决或被替换，那一刻的唯一真相是
 * store。`params` 只带"这是哪个会话"。
 */
import React, { useEffect, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { fallbackLabelKey } from '../features/chat/reducer.ts';
import { isRejectChoice } from '../features/chat/approval.ts';
import { useSession } from '../features/session/store.tsx';
import type { ApprovalChoice, PendingApproval } from '../models/chat.ts';
import { useT } from '../lib/i18n/useT.ts';
import { definePage, usePageRuntime } from '../lib/presentation/index.ts';
import { PRESS_OPACITY, radius, radiusStyle } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export interface ApprovalParams {
  sessionId: string;
}

/** 纯展示：一份审批 + 一个选择回调。 */
export function ApprovalView({
  approval,
  onChoose,
}: {
  approval: PendingApproval;
  /** 第二个参数只有"拒绝并写了理由"时才非空（见 `features/chat/approval.ts`）。 */
  onChoose: (optionId: string, reason?: string) => void;
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const t = useT();
  /**
   正在填拒绝理由的那一项。`null` = 还在选项列表上。

   形态照桌面端（`tool-approval-actions.vue` 的 `rejecting`）：**点了拒绝先问一句理由**，
   而不是直接拒掉。理由会随帧发给服务端，模型据此知道该换个做法——不写理由的话
   它只看到"被拒绝了"，下一轮很可能原样再试一次。
   */
  const [rejecting, setRejecting] = useState<ApprovalChoice | null>(null);
  const [reason, setReason] = useState('');

  const choose = (choice: ApprovalChoice) => {
    if (!isRejectChoice(choice)) {
      onChoose(choice.id);
      return;
    }
    setReason('');
    setRejecting(choice);
  };

  return (
    /**
      ⚠️ **不要给这个 sheet 的内容加 `automaticallyAdjustKeyboardInsets`。**

      看着是正解（键盘会盖住下面那颗"拒绝"按钮），但实测它会让**整个 sheet 的点按失效**：
      `Deny` / `Allow once` 两颗按钮在无障碍树里位置都对，点下去什么都不发生
      （按坐标点也一样），2026-09-16 在"拒绝时填理由"那条 flow 上踩到。
      这是 `SessionInfoPage` 记过的那一类坑（formSheet 里多一层东西 → 命中框错位）的又一例。

      键盘那一侧改用布局解决：理由输入框单行 + 两颗按钮**并排**（见下面 `rejecting` 分支），
      这一步的总高因此落在半屏 sheet 减去键盘之后仍然可见的那 ~130pt 里。
    */
    <ScrollView
      testID="approval-sheet"
      contentContainerStyle={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.lg,
        paddingBottom: spacing.xxl,
        gap: spacing.sm,
      }}
    >
      <Text style={[typography.title3, { color: palette.label }]}>{t('approval.title')}</Text>
      <Text style={[typography.subhead, { color: palette.secondaryLabel }]}>
        {t('approval.subtitle')}
      </Text>

      {approval.toolName !== '' ? (
        <View
          style={{
            marginTop: spacing.sm,
            padding: spacing.md,
            backgroundColor: palette.groupedBackground,
            ...radiusStyle(radius.md),
          }}
        >
          {/* 工具名和入参同处一个块，不再给"Tool"单开一行小标题：
              它只是把下面那行内容又标了一遍，多一层却没有多一个信息。
              消息流里那张卡片能显示同样内容，这里是给"没看见卡片"的情况兜底。 */}
          <Text style={[typography.callout, { color: palette.label }]}>{approval.toolName}</Text>
          {approval.toolInput === undefined ? null : (
            <ScrollView style={{ maxHeight: 160, marginTop: spacing.sm }}>
              <Text style={[typography.mono, { color: palette.secondaryLabel }]}>
                {formatInput(approval.toolInput)}
              </Text>
            </ScrollView>
          )}
        </View>
      ) : null}

      {rejecting === null ? (
        <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
          {approval.options.map((option) => (
            <ChoiceButton key={option.id} choice={option} onPress={() => choose(option)} />
          ))}
        </View>
      ) : (
        /* 第二步：写理由。取消回到选项列表（桌面端同一套：cancel-reject）。
           形态与桌面端一致：一行输入框，下面**并排**两颗按钮（Cancel | Reject）。
           并排不只是照抄——竖排时这一段的最后那颗按钮会落到键盘底下（半屏 sheet +
           键盘 ≈ 只剩 130pt 可视），并排之后这一步的总高刚好在可视区里。 */
        <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
          <Text style={[typography.subhead, { color: palette.secondaryLabel }]}>
            {t('approval.rejectReason.label')}
          </Text>
          <TextInput
            testID="approval-reject-reason"
            value={reason}
            onChangeText={setReason}
            placeholder={t('approval.rejectReason.placeholder')}
            placeholderTextColor={palette.placeholder}
            // 单行 + Done：理由通常就一句话，而多行输入在手机上会把"拒绝"那颗按钮
            // 顶到键盘后面去；Done 也让用户有一条明确的收起键盘的路（不必去点别处）。
            returnKeyType="done"
            onSubmitEditing={Keyboard.dismiss}
            style={[
              typography.body,
              {
                minHeight: 44,
                paddingHorizontal: spacing.md,
                color: palette.label,
                backgroundColor: palette.groupedBackground,
                ...radiusStyle(radius.md),
              },
            ]}
          />
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Pressable
              testID="approval-reject-cancel"
              accessibilityRole="button"
              onPress={() => setRejecting(null)}
              style={({ pressed }) => [
                styles.choice,
                { flex: 1, opacity: pressed ? PRESS_OPACITY.button : 1 },
              ]}
            >
              <Text style={[typography.headline, { color: palette.accent }]}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Pressable
              testID="approval-reject-confirm"
              accessibilityRole="button"
              onPress={() => onChoose(rejecting.id, reason)}
              style={({ pressed }) => [
                styles.choice,
                {
                  flex: 1,
                  backgroundColor: palette.field,
                  ...radiusStyle(radius.md),
                  opacity: pressed ? PRESS_OPACITY.button : 1,
                },
              ]}
            >
              <Text style={[typography.headline, { color: palette.destructive }]}>
                {t('approval.rejectReason.confirm')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

/** 出席页面：数据来自 store，关闭交给契约。 */
function ApprovalPresentedView() {
  const runtime = usePageRuntime<ApprovalParams>();
  const { sessionId } = runtime.params;
  const { chatFor, respondApproval } = useSession();
  /** 用户点过选项了（本地事实，不依赖服务端先回帧）。 */
  const [answered, setAnswered] = useState(false);

  const chat = chatFor(sessionId);
  const approval = chat.approval;

  /**
   * 什么时候关掉自己。
   *
   * 两条**都要**满足才关：用户已经答过；或者状态已经不再说"在等你决定"。
   *
   * 为什么不只看 `approval === null`：服务端在订阅握手的几帧里会给到"没有审批"的
   * 快照，紧接着又给回带审批的那一帧（实测：`chat.approval=3c079d30 → null → 3c079d30`）。
   * 只看它的话，sheet 会在升起来的那一刻自己缩回去，而 run 其实还在等你。
   * `waiting_decision` 是"正在等你"的权威信号（见 AGENTS.md 的协议一节）。
   */
  const stillWaiting = chat.runStatus === 'waiting_decision' || approval !== null;

  useEffect(() => {
    if (answered || !stillWaiting) runtime.finish();
  }, [answered, runtime, stillWaiting]);

  if (approval === null) return null;

  return (
    <ApprovalView
      approval={approval}
      onChoose={(optionId, reason) => {
        // 先记"答过了"再发帧：用户点完就该看到它关掉，不该等下一个快照。
        setAnswered(true);
        respondApproval(optionId, sessionId, reason);
      }}
    />
  );
}

function ChoiceButton({ choice, onPress }: { choice: ApprovalChoice; onPress: () => void }) {
  const palette = usePalette();
  const { radius, typography } = useTheme();
  const t = useT();

  /**
   * 文案来源有三层，优先级从高到低：
   *   1. agent 给的名字（它最清楚这个动作的含义）
   *   2. 我们的兜底动作（`__fallback_*`）——它的 label 存的是 i18n key
   *   3. 按语气猜一个通用文案
   *
   * 第 2 层必须走 i18n：兜底动作是我们造出来的，agent 不可能给它命名。
   */
  const label =
    choice.label !== undefined && choice.label !== ''
      ? choice.label.startsWith('approval.')
        ? t(choice.label)
        : choice.label
      : t(fallbackLabelKey(choice));

  const tone =
    choice.tone === 'allow'
      ? { background: palette.accent, color: palette.onAccent }
      : choice.tone === 'reject'
        ? { background: palette.field, color: palette.destructive }
        : { background: palette.card, color: palette.label };

  return (
    <Pressable
      testID={`approval-option-${choice.id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          backgroundColor: tone.background,
          ...radiusStyle(radius.md),
          opacity: pressed ? PRESS_OPACITY.button : 1,
          borderWidth: choice.tone === 'neutral' ? StyleSheet.hairlineWidth : 0,
          borderColor: palette.separator,
        },
      ]}
    >
      <Text style={[typography.headline, { color: tone.color }]}>{label}</Text>
    </Pressable>
  );
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
 * 审批页。
 *
 * `detents: [0.5, 1]` + 初始 0.5：默认半屏（够看清工具名与按钮），入参长的时候用户
 * 往上一拖就是全屏。`dismissible: false`：它必须被回答（见文件头第 2 条）。
 * 抓手保留——它现在只用于在 detent 之间拖动，不再是"关掉"的暗示。
 */
export const ApprovalPage = definePage<ApprovalParams>({
  id: 'approval',
  title: 'Approval needed',
  Component: ApprovalPresentedView,
  parseRouteParams: (params) => ({ sessionId: String(params.sessionId ?? '') }),
  presentation: {
    dismissible: false,
    detents: [0.5, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});

const styles = StyleSheet.create({
  choice: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
