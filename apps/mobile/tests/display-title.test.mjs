/**
 * 会话行的显示标题：**服务端形状的兜底口**。
 *
 * 判据不是"空标题显示什么"这么窄，而是"服务端给了个我们没预料到的标题时，界面会怎样"。
 * 类型声明把 `title` 写成必有 `string`，但那句话在线上不成立：
 *
 * - 这台部署服务端实测**一个会话都不返回 `channel_type`**（41/41 缺失，
 *   见 `features/session/sourceLabel.ts`）——同一份 `Session` 里别的字段缺失是常态；
 * - 标题允许为空（新会话、从 IM 频道建的会话），而 JSON 里 `null` 与"缺字段"是两种
 *   都真实存在的形状（固定服务端的 `sessions-sparse` 一档两种都演）。
 *
 * 以前这里直接 `session.title.trim()`：`null` 与缺字段都会抛
 * `TypeError: Cannot read properties of null (reading 'trim')`，而它在**渲染路径**上
 * ——一个坏字段会让整屏会话列表消失。兜底文案是"少一行字"，崩溃是"整屏没了"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionDisplayTitle } from '../src/features/session/displayTitle.ts';

/** 假翻译：只回 key，断言里就不必抄一份文案。 */
const t = (key) => key;

test('正常标题原样返回（只去首尾空白）', () => {
  assert.equal(sessionDisplayTitle({ title: '  整理收件箱  ' }, t), '整理收件箱');
});

test('空标题落到本地化的兜底文案', () => {
  assert.equal(sessionDisplayTitle({ title: '' }, t), 'home.untitled');
  assert.equal(sessionDisplayTitle({ title: '   ' }, t), 'home.untitled');
});

test('`title` 是 null：兜底，不崩', () => {
  assert.equal(sessionDisplayTitle({ title: null }, t), 'home.untitled');
});

test('`title` 缺字段（服务端 omitempty 的形状）：兜底，不崩', () => {
  assert.equal(sessionDisplayTitle({}, t), 'home.untitled');
});

test('整个 session 是 null/undefined：兜底，不崩（列表里可能混进一条坏载荷）', () => {
  assert.equal(sessionDisplayTitle(null, t), 'home.untitled');
  assert.equal(sessionDisplayTitle(undefined, t), 'home.untitled');
});
