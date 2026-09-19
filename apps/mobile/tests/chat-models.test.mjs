/**
 * composer 的模型/强度选择（`src/features/chat/models.ts`）。
 *
 * 每一条断言都对应一个"写错了也不明显"的规则：分组要有真名字、能力只读服务端算好的
 * `reasoning`、发出去的是 `model_id` 不是目录 uuid、以及**失效的选择必须退回默认并且
 * 不要发出去**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CHOICE,
  effortChoices,
  effortLabelKey,
  filterSections,
  findModel,
  sectionsFrom,
  verifiedChoice,
} from '../src/features/chat/models.ts';

const PROVIDERS = [
  { id: 'p-deepseek', name: 'DeepSeek' },
  { id: 'p-kimi', name: 'Kimi' },
];

const MODELS = [
  {
    id: 'uuid-1',
    model_id: 'k3',
    name: 'Kimi K3',
    provider_id: 'p-kimi',
    type: 'chat',
    enable: true,
    reasoning: {
      supported: true,
      can_disable: false,
      efforts: ['low', 'medium', 'high'],
      default_effort: 'medium',
    },
  },
  {
    id: 'uuid-2',
    model_id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider_id: 'p-deepseek',
    type: 'chat',
    enable: true,
    reasoning: {
      supported: true,
      can_disable: true,
      efforts: ['low', 'high'],
      default_effort: 'low',
    },
  },
  {
    id: 'uuid-3',
    model_id: 'embed-1',
    name: 'Embedding 1',
    provider_id: 'p-kimi',
    type: 'embedding',
    enable: true,
  },
  {
    id: 'uuid-4',
    model_id: 'off-model',
    name: 'Disabled',
    provider_id: 'p-kimi',
    type: 'chat',
    enable: false,
  },
];

test('只收聊天模型：embedding 与显式禁用的都进不来', () => {
  const sections = sectionsFrom(MODELS, PROVIDERS);
  const all = sections.flatMap((section) => section.models).map((model) => model.modelId);
  assert.deepEqual(all.sort(), ['deepseek-v4-flash', 'k3']);
});

test('按 provider 名字分组，组内按名字排序，组按名字排序', () => {
  const sections = sectionsFrom(MODELS, PROVIDERS);
  assert.deepEqual(
    sections.map((section) => section.title),
    ['DeepSeek', 'Kimi'],
  );
  assert.equal(sections[0].models[0].modelId, 'deepseek-v4-flash');
});

test('拿不到 provider 名字就平铺，绝不把 uuid 当分组标题', () => {
  const sections = sectionsFrom(MODELS, []);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, null);
  assert.equal(sections[0].models.length, 2);
});

test('思考能力只读服务端给的 reasoning：关不掉就不给 off', () => {
  const sections = sectionsFrom(MODELS, PROVIDERS);
  const kimi = findModel(sections, 'k3');
  const deepseek = findModel(sections, 'deepseek-v4-flash');
  assert.deepEqual(effortChoices(kimi), ['low', 'medium', 'high']);
  assert.deepEqual(effortChoices(deepseek), ['off', 'low', 'high']);
  assert.deepEqual(effortChoices(null), []);
});

test('未知档位退回原字符串，不假装认识', () => {
  assert.equal(effortLabelKey('off'), 'chat.effort.off');
  assert.equal(effortLabelKey('high'), 'chat.effort.high');
  assert.equal(effortLabelKey('ultra'), null);
});

test('搜索命中模型名、model_id 与 provider 名', () => {
  const sections = sectionsFrom(MODELS, PROVIDERS);
  assert.equal(filterSections(sections, 'k3')[0].models.length, 1);
  assert.equal(filterSections(sections, 'kimi')[0].models[0].modelId, 'k3');
  assert.equal(filterSections(sections, 'deep').length, 1);
  assert.equal(filterSections(sections, 'zzz').length, 0);
});

test('选中的模型还在：选择原样保留', () => {
  const sections = sectionsFrom(MODELS, PROVIDERS);
  const choice = { modelId: 'k3', reasoningEffort: 'high' };
  assert.deepEqual(verifiedChoice(choice, sections), choice);
});

test('选中的模型没了：退回默认，而且**不要**把那个 id 带出去', () => {
  const sections = sectionsFrom(MODELS, PROVIDERS);
  assert.deepEqual(
    verifiedChoice({ modelId: 'gone', reasoningEffort: 'high' }, sections),
    DEFAULT_CHOICE,
  );
});

test('档位在新模型上不存在：换回该模型的默认档，模型本身留着', () => {
  const sections = sectionsFrom(MODELS, PROVIDERS);
  // `high` 在 DeepSeek 上有，但这不是它的问题；用 Kimi 上不存在的档位试
  assert.deepEqual(verifiedChoice({ modelId: 'k3', reasoningEffort: 'ultra' }, sections), {
    modelId: 'k3',
    reasoningEffort: 'medium',
  });
});

test('不支持思考的模型上留下强度：清掉强度，模型留着', () => {
  const sections = sectionsFrom(
    [
      {
        id: 'uuid-9',
        model_id: 'plain',
        name: 'Plain',
        provider_id: 'p-kimi',
        type: 'chat',
        enable: true,
      },
    ],
    PROVIDERS,
  );
  assert.deepEqual(verifiedChoice({ modelId: 'plain', reasoningEffort: 'high' }, sections), {
    modelId: 'plain',
    reasoningEffort: null,
  });
});
