/**
 * 会话行副标题的测试。
 *
 * 起因是一个只在**真实服务端**上才会显形的显示 bug：类型声明把 channel_type
 * 写成必有的 string，而这台部署服务端一个会话都不返回它（实测 41/41 缺失）。
 * 原实现 `[channel_type, type].filter(part => part !== '')` 会保留 undefined，
 * 副标题渲染成 `" · chat"`——开头一个空段加一个多余分隔符。
 *
 * 所以这里钉的不是"格式好看"，而是**缺字段时不能留空段**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  sessionSourceFromApi,
  sessionSourceLabel,
  sessionSourceParts,
} from '../src/features/session/sourceLabel.ts';

test('两个字段都有时才用分隔符连起来', () => {
  assert.deepEqual(sessionSourceParts({ channelType: 'telegram', type: 'chat' }), [
    'telegram',
    'chat',
  ]);
});

test('缺 channel_type 时不能留空段（这正部署上的实际情况）', () => {
  // 真实服务端 41/41 会话都没有 channel_type。留下空段就会渲染成 " · chat"。
  assert.deepEqual(sessionSourceParts({ type: 'chat' }), ['chat']);
  assert.deepEqual(sessionSourceParts({ channelType: undefined, type: 'chat' }), ['chat']);
});

test('空字符串与纯空白等同于缺字段', () => {
  assert.deepEqual(sessionSourceParts({ channelType: '', type: 'chat' }), ['chat']);
  assert.deepEqual(sessionSourceParts({ channelType: '   ', type: 'chat' }), ['chat']);
});

test('两个都没有时没有任何部分（调用方据此不渲染整行）', () => {
  assert.deepEqual(sessionSourceParts({}), []);
  assert.deepEqual(sessionSourceParts({ channelType: '', type: '' }), []);
});

test('副标题为空白时返回空串，界面据此整行不渲染', () => {
  assert.equal(sessionSourceLabel({ source: '' }), '');
  assert.equal(sessionSourceLabel({ source: '   ' }), '');
  assert.equal(sessionSourceLabel({ source: 'chat' }), 'chat');
});

/**
 * 服务端形状（snake_case）与应用内形状共用**同一条**规则。
 *
 * 这是 A3 那两处落点收敛后的样子：`store.tsx` 的会话列表、`store.tsx` 的"补标题"、
 * `RunTargetPickerPage` 的副标题，三处都调这一个函数——不允许再各写一遍
 * `[channel_type, type].filter(...).join(' · ')`（其中一处正是" · chat"的来源）。
 */
test('服务端形状走同一条规则（缺字段时不留空段）', () => {
  assert.equal(sessionSourceFromApi({ channel_type: 'telegram', type: 'chat' }), 'telegram · chat');
  assert.equal(sessionSourceFromApi({ type: 'chat' }), 'chat');
  assert.equal(sessionSourceFromApi({ channel_type: undefined, type: 'chat' }), 'chat');
  assert.equal(sessionSourceFromApi({ channel_type: '', type: 'chat' }), 'chat');
  assert.equal(sessionSourceFromApi({}), '', '什么都没有 → 空串（调用方整行不渲染）');
});
