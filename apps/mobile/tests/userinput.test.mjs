/**
 * `ask_user` 表单的答案构建测试。
 *
 * 这些用例钉的是**服务端校验**（`internal/agent/decision/input/service.go` 的
 * `toAnswerEntry`）和上游 Web 客户端的政策。理由：这个表单错了不会报错，只会
 * 让服务端拒收、run 静默卡在 `waiting_decision`——不写测试根本看不出来。
 *
 * 每条断言后面都写了"违反它会怎样"，因为下一个人看到的只会是一个 ✓。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  answerFor,
  buildAnswers,
  draftText,
  EMPTY_DRAFT,
  setDraftText,
  toggleCustom,
  toggleOption,
  usesFooterInput,
} from '../src/features/chat/userInput.ts';

/** 造一个 PendingQuestion，默认按"缺省 = 必答、不允许自定义"。 */
function question(overrides = {}) {
  return {
    questionId: 'q1',
    text: '选一个',
    kind: 'single_select',
    options: [
      { id: 'o1', label: 'A' },
      { id: 'o2', label: 'B' },
    ],
    allowCustom: false,
    customExclusive: false,
    required: true,
    ...overrides,
  };
}

test('必答的单选题不选任何东西时不可提交', () => {
  const q = question();
  assert.equal(answerFor(q, EMPTY_DRAFT, true), null, '必答未答 → 提交按钮必须禁用');
  assert.equal(buildAnswers([q], { q1: EMPTY_DRAFT }), null);
});

test('非必答的单选题空着 = 显式 skipped（服务端接受）', () => {
  const q = question({ required: false });
  assert.deepEqual(answerFor(q, EMPTY_DRAFT, true), { question_id: 'q1', skipped: true });
});

test('必答问题不能发 skipped——服务端会报 required cannot be skipped', () => {
  const q = question({ kind: 'text', required: true });
  const answer = answerFor(q, { ...EMPTY_DRAFT, text: '   ' }, true);
  assert.equal(answer, null, '只有空白也算没答');
});

test('文本问题：答了发 text，且不带选项/自定义字段', () => {
  const q = question({ kind: 'text' });
  const answer = answerFor(q, { ...EMPTY_DRAFT, text: '  hello  ' }, true);
  assert.deepEqual(answer, { question_id: 'q1', text: 'hello' }, '文本要 trim');
  assert.equal('option_ids' in answer, false);
  assert.equal('custom_text' in answer, false);
});

test('文本问题不能带选项——服务端报 does not accept option selections', () => {
  // 即使草稿里残留了选项（切 kind 的边界），文本问题也必须只发 text。
  const q = question({ kind: 'text' });
  const dirty = { optionIds: ['o1'], customSelected: true, customText: 'x', text: 'yes' };
  assert.deepEqual(answerFor(q, dirty, false), { question_id: 'q1', text: 'yes' });
});

test('单选选中一项', () => {
  const q = question();
  assert.deepEqual(answerFor(q, { ...EMPTY_DRAFT, optionIds: ['o2'] }, false), {
    question_id: 'q1',
    option_ids: ['o2'],
  });
});

test('单选不允许"一个选项 + 自定义文本"并存——服务端会报错', () => {
  const q = question({ allowCustom: true });
  const both = { optionIds: ['o1'], customSelected: true, customText: 'x', text: '' };
  assert.equal(answerFor(q, both, false), null, 'two-way 并存必须判为不可提交');
});

test('单选的两个选项也非法（服务端只收一个）', () => {
  const q = question();
  const two = { ...EMPTY_DRAFT, optionIds: ['o1', 'o2'] };
  assert.equal(answerFor(q, two, false), null);
});

test('不允许自定义的问题不会发出 custom_text——服务端会硬拒', () => {
  const q = question({ allowCustom: false });
  // 单选 + single：底部输入框的文字在不允许自定义时不算答案。
  assert.equal(answerFor(q, { ...EMPTY_DRAFT, customText: 'x' }, true), null);
});

test('多选：选项与自定义文本可以并存', () => {
  const q = question({ kind: 'multi_select', allowCustom: true });
  const draft = { optionIds: ['o1', 'o2'], customSelected: true, customText: '还有别的', text: '' };
  assert.deepEqual(answerFor(q, draft, false), {
    question_id: 'q1',
    option_ids: ['o1', 'o2'],
    custom_text: '还有别的',
  });
});

test('customExclusive：选了自定义就不能带选项', () => {
  const q = question({ kind: 'multi_select', allowCustom: true, customExclusive: true });
  const draft = { optionIds: ['o1'], customSelected: true, customText: 'x', text: '' };
  assert.equal(answerFor(q, draft, false), null);
});

test('选了"其他"却没写字 = 还没答完', () => {
  const q = question({ kind: 'multi_select', allowCustom: true });
  const draft = { ...EMPTY_DRAFT, customSelected: true, customText: '   ' };
  assert.equal(answerFor(q, draft, false), null);
});

test('单问题表单：底部输入框的文字直接作为自定义答案，无需点"其他"', () => {
  const q = question({ allowCustom: true });
  const draft = { ...EMPTY_DRAFT, customText: '第三个选项' };
  assert.deepEqual(answerFor(q, draft, true), { question_id: 'q1', custom_text: '第三个选项' });
});

test('多问题表单：自定义必须先点"其他"再写字', () => {
  const q = question({ allowCustom: true });
  const unselected = { ...EMPTY_DRAFT, customText: '第三个选项' };
  assert.equal(answerFor(q, unselected, false), null, '多问题表单里裸文本不算答案');
  const selected = { ...unselected, customSelected: true };
  assert.deepEqual(answerFor(q, selected, false), {
    question_id: 'q1',
    custom_text: '第三个选项',
  });
});

test('toggleOption：单选互斥、多选可叠加', () => {
  const single = question();
  const one = toggleOption(single, EMPTY_DRAFT, 'o1');
  assert.deepEqual(one.optionIds, ['o1']);
  const switched = toggleOption(single, one, 'o2');
  assert.deepEqual(switched.optionIds, ['o2'], '单选换选要替换而不是叠加');

  const multi = question({ kind: 'multi_select' });
  const two = toggleOption(multi, toggleOption(multi, EMPTY_DRAFT, 'o1'), 'o2');
  assert.deepEqual(two.optionIds, ['o1', 'o2']);
  const back = toggleOption(multi, two, 'o1');
  assert.deepEqual(back.optionIds, ['o2'], '再点一次要取消');
});

test('toggleOption：选中选项时清掉单选的残留自定义文本', () => {
  const q = question({ allowCustom: true });
  const withCustom = toggleCustom(q, EMPTY_DRAFT);
  const typed = setDraftText(q, withCustom, 'x');
  const picked = toggleOption(q, typed, 'o1');
  assert.deepEqual(picked.optionIds, ['o1']);
  assert.equal(picked.customText, '', '单选下选了选项，自定义文本必须让位');
});

test('toggleCustom：customExclusive 下清掉已选选项', () => {
  const q = question({ kind: 'multi_select', allowCustom: true, customExclusive: true });
  const picked = toggleOption(q, EMPTY_DRAFT, 'o1');
  const custom = toggleCustom(q, picked);
  assert.deepEqual(custom.optionIds, [], '互斥时自定义要清掉选项');
  assert.equal(custom.customSelected, true);
});

test('setDraftText：单选里写字即视为选了自定义，选项让位', () => {
  const q = question({ allowCustom: true });
  const picked = toggleOption(q, EMPTY_DRAFT, 'o1');
  const typed = setDraftText(q, picked, 'x');
  assert.deepEqual(typed.optionIds, [], '单选的文字与选项只能有一个');
});

test('buildAnswers：所有问题都答完才给出答案', () => {
  const a = question({ questionId: 'a', kind: 'text' });
  const b = question({ questionId: 'b' });
  const drafts = {
    a: { ...EMPTY_DRAFT, text: '第一题' },
    b: { ...EMPTY_DRAFT, optionIds: ['o1'] },
  };
  assert.deepEqual(buildAnswers([a, b], drafts), [
    { question_id: 'a', text: '第一题' },
    { question_id: 'b', option_ids: ['o1'] },
  ]);
  // 漏掉任一题就没有答案——半份答案服务端整帧拒收。
  assert.equal(buildAnswers([a, b], { a: drafts.a }), null);
});

test('buildAnswers：没有问题就没有答案（不发空提交）', () => {
  assert.equal(buildAnswers([], {}), null);
});

test('draftText / usesFooterInput：底部输入框只服务单问题的文本或自定义', () => {
  assert.equal(draftText(question({ kind: 'text' }), { ...EMPTY_DRAFT, text: 'x' }), 'x');
  assert.equal(
    draftText(question({ allowCustom: true }), { ...EMPTY_DRAFT, customText: 'y' }),
    'y',
  );
  assert.equal(usesFooterInput(question({ kind: 'text' })), true);
  assert.equal(usesFooterInput(question({ allowCustom: true })), true);
  assert.equal(usesFooterInput(question()), false, '不允许自定义的单选题不该给底部输入框');
});
