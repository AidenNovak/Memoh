/**
 * agent 提问表单（`ask_user`）。
 *
 * ## 为什么它是"必须有"，不是"锦上添花"
 *
 * agent 调用 `ask_user` 时 run 停在 `waiting_decision` 上。**不回应就永远不继续**
 * （AGENTS.md 把它列为协议契约）。所以漏掉这个界面不是少一个功能，是让 run 静默
 * 卡死——用户看到转圈，不知道在等自己。
 *
 * ## 形态
 *
 * 与 `ApprovalPage` 同一套：底部 sheet、不可跳过、必须做出选择或显式取消。
 * 理由相同——它们是同一类东西（run 在等用户），形态不一致会让用户以为是两件事。
 *
 * 但内容不同：审批是"准不准"，提问是"你选什么"。所以这里渲的是 agent 给的
 * 问题与选项，而不是权限语气。
 *
 * ## 答案构建在别处
 *
 * "能不能提交""答案长什么样"全部在 `features/chat/userInput.ts`。
 * 这个组件只管画和收集草稿：把校验写在组件里，出错的代价是服务端拒收 + run 卡住，
 * 而那种错误在界面上看不出来。
 */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PendingQuestion, PendingUserInput } from '../models/chat.ts';
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
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { definePage, usePageRuntime } from '../lib/presentation/index.ts';
import { PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export interface UserInputParams {
  sessionId: string;
}

/** 纯展示：一份提问 + 提交/取消两个回调。 */
export function UserInputView({
  userInput,
  onSubmit,
  onCancel,
}: {
  userInput: PendingUserInput;
  onSubmit: (answers: unknown) => void;
  onCancel: () => void;
}) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();

  // 草稿由父级用 `key={userInputId}` 重新挂载来重置——比在渲染期 setState 干净，
  // 也不会把上一份没答完的答案带进下一份提问（题目可能完全不同）。
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});

  const questions = userInput.questions;
  const single = questions.length === 1;
  const answers = buildAnswers(questions, drafts);
  const canSubmit = answers !== null;

  const update = (question: PendingQuestion, next: QuestionDraft) =>
    setDrafts((current) => ({ ...current, [question.questionId]: next }));

  const questionBlock = (question: PendingQuestion, index: number) => (
    <View
      key={question.questionId}
      style={{
        marginTop: index === 0 ? 0 : spacing.lg,
        paddingTop: index === 0 ? 0 : spacing.md,
        borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: palette.separator,
      }}
    >
      <Text style={[typography.callout, { color: palette.label }]}>{question.text}</Text>
      {question.required ? (
        <Text style={[typography.caption2, { color: palette.secondaryLabel, marginTop: 2 }]}>
          {t('askUser.required')}
        </Text>
      ) : null}

      {question.kind !== 'text' && question.options.length > 0 ? (
        <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
          {question.options.map((option) => {
            const draft = drafts[question.questionId] ?? EMPTY_DRAFT;
            const selected = draft.optionIds.includes(option.id);
            return (
              <OptionRow
                key={option.id}
                label={option.label}
                description={option.description}
                selected={selected}
                multiple={question.kind === 'multi_select'}
                onPress={() => update(question, toggleOption(question, draft, option.id))}
              />
            );
          })}
          {/* 多问题表单里，"其他"是一个要显式选中的入口；单问题表单用底部输入框，
              不重复给这一行（上游同样的处理）。 */}
          {question.allowCustom && !single ? (
            <OptionRow
              label={t('askUser.other')}
              selected={(drafts[question.questionId] ?? EMPTY_DRAFT).customSelected}
              multiple={question.kind === 'multi_select'}
              onPress={() =>
                update(question, toggleCustom(question, drafts[question.questionId] ?? EMPTY_DRAFT))
              }
            />
          ) : null}
        </View>
      ) : null}

      {/*
        多问题表单里，每个问题自带输入框（一个底部输入框答不了多个文本问题）：
        - 文本问题：始终给输入框；
        - 选择问题：只有用户真的选了"其他"才给（选之前给输入框会让人以为可以
          既选项又写字，而单选下服务端只收一个）。
        单问题表单交给底部输入框，这里不出输入框。
      */}
      {(() => {
        if (single) return null;
        const draft = drafts[question.questionId] ?? EMPTY_DRAFT;
        if (question.kind === 'text') {
          return <InlineInput question={question} draft={draft} onText={update} />;
        }
        if (question.allowCustom && draft.customSelected) {
          return <InlineInput question={question} draft={draft} onText={update} />;
        }
        return null;
      })()}
    </View>
  );

  const only = single ? questions[0] : undefined;
  const footerQuestion = only !== undefined && usesFooterInput(only) ? only : null;
  const footerDraft =
    footerQuestion !== null ? (drafts[footerQuestion.questionId] ?? EMPTY_DRAFT) : null;

  return (
    /**
     * ⚠️ 整个面板只有一个子视图（这一个 ScrollView）：formSheet 对子视图数量有约束，
     * 多出来的那个会让无障碍命中框错位（见 ui/SessionInfoPage.tsx 的同类注释）。
     */
    <ScrollView
      testID="user-input-sheet"
      contentContainerStyle={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: insets.bottom + spacing.lg,
        gap: spacing.sm,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[typography.title3, { color: palette.label, paddingHorizontal: spacing.lg }]}>
        {userInput.shortId !== undefined
          ? t('askUser.titleWithId', { id: userInput.shortId })
          : t('askUser.title')}
      </Text>
      <Text
        style={[
          typography.subhead,
          {
            color: palette.secondaryLabel,
            paddingHorizontal: spacing.lg,
            marginTop: spacing.xs,
          },
        ]}
      >
        {t('askUser.subtitle')}
      </Text>

      <View style={{ gap: spacing.sm }}>{questions.map(questionBlock)}</View>

      <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
        {/* 单问题表单的底部输入框：文本问题在这里作答；允许自定义的单选在这里
                写"其他"——不需要先点一下 Other（上游同样的处理）。 */}
        {footerQuestion !== null && footerDraft !== null ? (
          <TextInput
            value={draftText(footerQuestion, footerDraft)}
            onChangeText={(value) =>
              update(footerQuestion, setDraftText(footerQuestion, footerDraft, value))
            }
            accessibilityLabel={footerQuestion.text}
            placeholder={footerQuestion.placeholder ?? t('askUser.placeholder')}
            placeholderTextColor={palette.placeholder}
            multiline
            style={[
              typography.body,
              {
                color: palette.label,
                backgroundColor: palette.field,
                borderRadius: radius.md,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                maxHeight: 120,
                minHeight: 44,
              },
            ]}
          />
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit}
          onPress={() => onSubmit(answers)}
          style={({ pressed }) => ({
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: canSubmit ? palette.accent : palette.field,
            borderRadius: radius.md,
            opacity: pressed ? PRESS_OPACITY.button : 1,
          })}
        >
          <Text
            style={[
              typography.headline,
              { color: canSubmit ? palette.onAccent : palette.tertiaryLabel },
            ]}
          >
            {t('askUser.submit')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onCancel}
          style={({ pressed }) => ({
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.field,
            borderRadius: radius.md,
            opacity: pressed ? PRESS_OPACITY.button : 1,
          })}
        >
          <Text style={[typography.headline, { color: palette.destructive }]}>
            {t('askUser.cancel')}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * 出席页面。
 *
 * 数据从 store 按 `params.sessionId` 取（服务端的提问是权威的），草稿状态由外层
 * `key={userInputId}` 重新挂载来重置——比在渲染期 setState 干净，也不会把上一份没答完的
 * 答案带进下一份提问（题目可能完全不同）。
 */
function UserInputPresentedView() {
  const runtime = usePageRuntime<UserInputParams>();
  const { sessionId } = runtime.params;
  const { chatFor, respondUserInput } = useSession();
  const [answered, setAnswered] = useState(false);

  const chat = chatFor(sessionId);
  const pending = chat.userInput;
  const stillWaiting = chat.runStatus === 'waiting_decision' || pending !== null;

  /**
   * 什么时候关掉自己。
   *
   * 与审批同一条规则：等用户答过、或者状态不再说"在等你"（`waiting_decision`），
   * 而不是只看某个字段变 null——服务端在订阅握手的几帧里会先给"没有待办"的快照，
   * 紧接着又给回来，只看 null 会让面板刚升起来就缩回去。
   */
  useEffect(() => {
    if (answered || !stillWaiting) runtime.finish();
  }, [answered, runtime, stillWaiting]);

  if (pending === null) return null;

  return (
    <UserInputView
      key={pending.userInputId}
      userInput={pending}
      onSubmit={(answers) => {
        setAnswered(true);
        respondUserInput({ answers }, sessionId);
      }}
      onCancel={() => {
        setAnswered(true);
        respondUserInput({ canceled: true }, sessionId);
      }}
    />
  );
}

/**
 * 提问页。
 *
 * `dismissible: false`：run 停在 `waiting_decision` 上，侧滑关掉它等于让 run 挂在那里，
 * 而用户以为自己回应过了（与审批同一条理由）。
 */
export const UserInputPage = definePage<UserInputParams>({
  id: 'userInput',
  title: 'The agent asked you something',
  Component: UserInputPresentedView,
  parseRouteParams: (params) => ({ sessionId: String(params.sessionId ?? '') }),
  presentation: {
    dismissible: false,
    detents: [0.5, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});

/** 一行选项。形状照系统表单：整行可点、选中态用品牌色而不是自绘对勾。 */
function OptionRow({
  label,
  description,
  selected,
  multiple,
  onPress,
}: {
  label: string;
  description?: string;
  selected: boolean;
  multiple: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  return (
    <Pressable
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.md,
        backgroundColor: selected ? palette.field : palette.groupedBackground,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? palette.accent : palette.separator,
        opacity: pressed ? PRESS_OPACITY.button : 1,
      })}
    >
      <Text style={[typography.subhead, { color: palette.label }]}>{label}</Text>
      {description !== undefined && description !== '' ? (
        <Text style={[typography.caption2, { color: palette.secondaryLabel, marginTop: 2 }]}>
          {description}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** 多问题表单里每个问题自带的输入框。 */
function InlineInput({
  question,
  draft,
  onText,
}: {
  question: PendingQuestion;
  draft: QuestionDraft;
  onText: (question: PendingQuestion, next: QuestionDraft) => void;
}) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  const t = useT();
  return (
    <TextInput
      value={draftText(question, draft)}
      onChangeText={(value) => onText(question, setDraftText(question, draft, value))}
      placeholder={question.placeholder ?? t('askUser.placeholder')}
      placeholderTextColor={palette.placeholder}
      style={[
        typography.body,
        {
          marginTop: spacing.xs,
          color: palette.label,
          backgroundColor: palette.field,
          borderRadius: radius.md,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          minHeight: 44,
        },
      ]}
    />
  );
}
