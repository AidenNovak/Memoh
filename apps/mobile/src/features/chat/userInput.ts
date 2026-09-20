/**
 * `ask_user` 表单的**答案构建与校验**（纯逻辑，无 React）。
 *
 * ## 为什么要单独一个模块
 *
 * agent 提问时 run 停在 `waiting_decision`，不回应就**永远不继续**（AGENTS.md 把
 * 这条列为协议契约）。所以这个表单不是"锦上添花的 UI"，是 run 能不能往下走的
 * 开关。判断"能不能提交""答案长什么样"集中在这里——它错了的表现是服务端拒收、
 * run 静默卡住，在 UI 上很难看出来。
 *
 * ## 规则来源（不是我发明的）
 *
 * 以服务端校验为准（`internal/agent/decision/input/service.go` 的 `toAnswerEntry`）：
 *
 * - `skipped: true` 只在问题**不是显式必答**时合法，否则报
 *   「question is required and cannot be skipped」；
 * - `text` 问题：**不许**带 `option_ids`/`custom_text`，且 `text` 不能空；
 * - 选择类问题：不许带 `text`；`custom_text` 需要 `allow_custom`；
 *   `custom_exclusive` 时二者只能有一个；`single_select` 最多一个选项、
 *   且不能"一个选项 + 自定义文本"并存；
 * - 什么都不给（既没选项也没自定义文本）→ 「requires a selection」。
 *
 * 上游 Web 客户端的对应实现在 `chat-user-input-form.vue` 的 `answerFor()`，
 * 这里的规则与它逐条对齐（含"单选用底部输入框时无需显式选 Other"这样的细节）。
 */

import type { PendingQuestion } from '../../models/chat.ts';

/** 线上答案形状（`WSUserInputAnswer`，wire 用 snake_case）。 */
export interface UserInputAnswer {
  question_id: string;
  option_ids?: string[];
  custom_text?: string;
  text?: string;
  skipped?: boolean;
}

/** 单个问题的草稿状态。UI 持有它，逻辑只读它。 */
export interface QuestionDraft {
  optionIds: string[];
  customSelected: boolean;
  customText: string;
  text: string;
}

export const EMPTY_DRAFT: QuestionDraft = {
  optionIds: [],
  customSelected: false,
  customText: '',
  text: '',
};

export function draftText(question: PendingQuestion, draft: QuestionDraft): string {
  return question.kind === 'text' ? draft.text : draft.customText;
}

/**
 * 选中/取消一个选项。
 *
 * 单选：选中它并清掉自定义文本（服务端只接受二者之一）。
 * 多选：切换；若自定义与选项互斥，则选中选项时清掉自定义。
 */
export function toggleOption(
  question: PendingQuestion,
  draft: QuestionDraft,
  optionId: string,
): QuestionDraft {
  if (question.kind === 'multi_select') {
    const selected = draft.optionIds.includes(optionId);
    const optionIds = selected
      ? draft.optionIds.filter((id) => id !== optionId)
      : [...draft.optionIds, optionId];
    const cleared = !selected && question.customExclusive;
    return {
      ...draft,
      optionIds,
      customSelected: cleared ? false : draft.customSelected,
      customText: cleared ? '' : draft.customText,
    };
  }
  // 单选（以及未知 kind 的兜底）：选项与自定义互斥。
  return { optionIds: [optionId], customSelected: false, customText: '', text: draft.text };
}

/** 选中/取消"其他（自定义）"入口。 */
export function toggleCustom(question: PendingQuestion, draft: QuestionDraft): QuestionDraft {
  if (question.kind === 'multi_select') {
    const customSelected = !draft.customSelected;
    const clearOptions = customSelected && question.customExclusive;
    return {
      ...draft,
      customSelected,
      optionIds: clearOptions ? [] : draft.optionIds,
      customText: customSelected ? draft.customText : '',
    };
  }
  return { ...draft, customSelected: true, optionIds: [], text: draft.text };
}

/** 写文本（text 问题写 `text`，选择问题的自定义入口写 `customText`）。 */
export function setDraftText(
  question: PendingQuestion,
  draft: QuestionDraft,
  value: string,
): QuestionDraft {
  if (question.kind === 'text') return { ...draft, text: value };
  const next: QuestionDraft = { ...draft, customText: value };
  // 单选下"写了自定义文本"就等于选了自定义，选项要让位——服务端二者只收一个。
  if (question.kind === 'single_select' && value.trim() !== '') next.optionIds = [];
  if (value.trim() !== '' && question.customExclusive) next.optionIds = [];
  return next;
}

/**
 * 单个问题的答案。
 *
 * 返回 `null` 表示**这个问题还没答完**——调用方据此把提交按钮置灰。返回
 * `{ skipped: true }` 是"显式跳过"，只对非必答问题发生；服务端接受它。
 *
 * `single` 参数表示整份表单只有一个问题：那种情况下单选/文本问题用**底部那一个**
 * 输入框作答，不需要用户先点一下"其他"（上游同样的处理）。
 */
export function answerFor(
  question: PendingQuestion,
  draft: QuestionDraft | undefined,
  single: boolean,
): UserInputAnswer | null {
  const required = question.required;

  if (question.kind === 'text') {
    const text = draft?.text.trim() ?? '';
    if (text !== '') return { question_id: question.questionId, text };
    return required ? null : { question_id: question.questionId, skipped: true };
  }

  const optionIds = draft?.optionIds ?? [];
  let customText = '';
  if (single) {
    // 底部输入框里的文字就是自定义答案，无需显式选"其他"。
    customText = question.allowCustom ? (draft?.customText.trim() ?? '') : '';
  } else {
    const customSelected = draft?.customSelected ?? false;
    customText = customSelected ? (draft?.customText.trim() ?? '') : '';
    // 选了"其他"却没写内容——还没答完。
    if (customSelected && customText === '') return null;
  }

  if (optionIds.length === 0 && customText === '') {
    return required ? null : { question_id: question.questionId, skipped: true };
  }
  // 单选：选项与自定义文本二选一，且不能同时有。
  if (question.kind === 'single_select' && optionIds.length + (customText === '' ? 0 : 1) !== 1) {
    return null;
  }
  if (question.customExclusive && optionIds.length > 0 && customText !== '') return null;

  const answer: UserInputAnswer = { question_id: question.questionId };
  if (optionIds.length > 0) answer.option_ids = [...optionIds];
  if (customText !== '') answer.custom_text = customText;
  return answer;
}

/**
 * 整份表单的答案。任何一个问题没答完就返回 `null`（提交按钮据此禁用）。
 *
 * 空表单（没有问题）也返回 `null`：没有问题就没有"答案"，不该发出一个空提交。
 */
export function buildAnswers(
  questions: PendingQuestion[],
  drafts: Record<string, QuestionDraft>,
): UserInputAnswer[] | null {
  if (questions.length === 0) return null;
  const single = questions.length === 1;
  const out: UserInputAnswer[] = [];
  for (const question of questions) {
    const answer = answerFor(question, drafts[question.questionId], single);
    if (answer === null) return null;
    out.push(answer);
  }
  return out;
}

/** 这个问题在"只有它一个"时是否用底部输入框作答。 */
export function usesFooterInput(question: PendingQuestion): boolean {
  return question.kind === 'text' || question.allowCustom;
}

/** 取消一整次提问（服务端接受 `canceled` + `reason`）。 */
export const CANCEL_REASON = 'user_canceled';
