/**
 * 斜杠命令的解析（`src/features/chat/slash.ts`）。
 *
 * 三条规则各自对应一个"错了也不明显"的后果：
 * 1. 菜单只在**还没打空格**时弹（否则盖住参数）；
 * 2. 只有**命中技能清单**的 `/name` 才附 `requested_skills`——不认识的斜杠要当普通文本发，
 *    否则用户打一句 `/etc/hosts 怎么回事` 会被当成命令打回错误码；
 * 3. 选技能只补一个空格，让用户接着写参数（技能是要带 prompt 的）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  draftAfterSkill,
  requestedSkillsFor,
  slashItems,
  slashQuery,
} from '../src/features/chat/slash.ts';

const SKILLS = [
  { name: 'skill-creator', description: 'Create a new skill' },
  { name: 'hooks-setup', display_name: 'hooks-setup', description: 'Set up hooks' },
];

test('草稿以 / 开头且还没空格 → 是命令输入', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/sk'), 'sk');
  assert.equal(slashQuery('  /model'), 'model');
});

test('打了空格或不是 / 开头 → 不是命令输入（菜单要收起来）', () => {
  assert.equal(slashQuery('/skill-creator 写一个'), null);
  assert.equal(slashQuery('hello /model'), null);
  assert.equal(slashQuery(''), null);
});

test('菜单 = 内置动作 + 技能', () => {
  const items = slashItems('', SKILLS);
  assert.deepEqual(
    items.map((item) => item.name),
    ['new', 'model', 'skill-creator', 'hooks-setup'],
  );
  assert.equal(items[0].kind, 'builtin');
  assert.equal(items[2].kind, 'skill');
});

test('菜单按名字与说明过滤', () => {
  assert.deepEqual(
    slashItems('sk', SKILLS).map((item) => item.name),
    ['skill-creator'],
  );
  assert.deepEqual(
    slashItems('hooks', SKILLS).map((item) => item.name),
    ['hooks-setup'],
  );
  assert.deepEqual(slashItems('zzz', SKILLS), []);
});

test('命中技能才附 requested_skills', () => {
  assert.deepEqual(requestedSkillsFor('/skill-creator 写一个 skill', SKILLS), ['skill-creator']);
  assert.deepEqual(requestedSkillsFor('/hooks-setup', SKILLS), ['hooks-setup']);
});

test('不认识的斜杠当普通文本：不要附任何技能', () => {
  assert.deepEqual(requestedSkillsFor('/etc/hosts 怎么回事', SKILLS), []);
  assert.deepEqual(requestedSkillsFor('/help', SKILLS), []);
  assert.deepEqual(requestedSkillsFor('普通消息', SKILLS), []);
  assert.deepEqual(requestedSkillsFor('/', SKILLS), []);
});

test('大小写不敏感（用户可能打成 /Skill-Creator）', () => {
  assert.deepEqual(requestedSkillsFor('/Skill-Creator go', SKILLS), ['skill-creator']);
});

test('选技能后草稿补一个空格（技能要带 prompt）', () => {
  assert.equal(draftAfterSkill('hooks-setup'), '/hooks-setup ');
});
