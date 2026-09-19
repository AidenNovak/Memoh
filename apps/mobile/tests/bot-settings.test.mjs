/**
 * bot 设置页的纯逻辑（`src/features/bots/settings.ts`）。
 *
 * 关键在**差分**：服务端是"指针语义"（不传 = 保持、空串 = 清空），所以
 * 全量回传会覆盖掉另一个客户端刚改的字段。这些断言就是那条纪律的护栏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { draftFrom, nextEffort, patchFrom } from '../src/features/bots/settings.ts';
import {
  AUTO_LANGUAGE,
  CHAT_LANGUAGES,
  filterLanguages,
  findLanguage,
  languageLabel,
  languageSubtitle,
  normalizeLanguage,
} from '../src/features/bots/languages.ts';

const BOT = {
  id: 'b1',
  name: 'assistant',
  display_name: 'Assistant',
  avatar_url: '',
  is_active: true,
  timezone: 'Asia/Shanghai',
};

test('草稿从服务端值来；没有设置的模型是 null（跟随默认）', () => {
  const draft = draftFrom(BOT, { timezone: 'Asia/Shanghai' });
  assert.deepEqual(draft, {
    displayName: 'Assistant',
    avatarUrl: '',
    isActive: true,
    modelId: null,
    reasoningEffort: null,
    language: AUTO_LANGUAGE,
    // 时区的草稿值来自 **bot 记录**（不是 settings 端点，见下面的用例）。
    timezone: 'Asia/Shanghai',
    displayEnabled: true,
  });
});

test('时区：bot 上没设过（服务端连 key 都不返回）→ 草稿是"继承"，且不产生补丁', () => {
  // 实测：`PUT /bots/{id} {"timezone":""}` 之后再 GET，`timezone` 这个 key **不在响应里**
  // （Go 侧 omitempty）。所以草稿必须吃下 undefined。
  const timezoneLess = { ...BOT, timezone: undefined };
  const settings = { chat_model_id: 'k3' };
  const draft = draftFrom(timezoneLess, settings);
  assert.equal(draft.timezone, '');
  assert.equal(patchFrom(timezoneLess, settings, draft), null);
});

test('bot 上整个没有 avatar_url（dev 栈实测的形状）→ 草稿是空串，且不产生补丁', () => {
  // 与上面那条时区同一个道理：Go 侧 `AvatarURL string \`json:"avatar_url,omitempty"\``
  // 让"没有头像"表现为**这个 key 不在响应里**，不是空串。草稿的声明类型是 string，
  // 拿 undefined 去当 TextInput 的 value 会让那个输入框变成非受控的。
  const avatarLess = { ...BOT, avatar_url: undefined };
  const settings = { chat_model_id: 'k3' };
  const draft = draftFrom(avatarLess, settings);
  assert.equal(draft.avatarUrl, '');
  assert.equal(patchFrom(avatarLess, settings, draft), null);
});

test('时区改动走 bot 那条路（PUT /bots/{id}），不是 settings 端点', () => {
  // 理由：`POST /bots/{id}/settings` 收到空串会被 SQL 的 COALESCE 吃掉，"清空"这个动作
  // 在那里是静默失效的（实测）。
  const settings = { chat_model_id: 'k3' };
  const draft = { ...draftFrom(BOT, settings), timezone: 'Europe/Paris' };
  const patch = patchFrom(BOT, settings, draft);
  assert.deepEqual(patch.bot, { timezone: 'Europe/Paris' });
  assert.deepEqual(patch.settings, {});
});

test('把时区改回"继承"发的是空串（服务端据此把列写回 NULL）', () => {
  const settings = { chat_model_id: 'k3' };
  const draft = { ...draftFrom(BOT, settings), timezone: '' };
  assert.deepEqual(patchFrom(BOT, settings, draft).bot, { timezone: '' });
});

test('没动过时区 → 不出现这个字段（差分不许把别人的改动盖回去）', () => {
  const settings = { chat_model_id: 'k3' };
  const draft = { ...draftFrom(BOT, settings), displayName: '新名字' };
  assert.deepEqual(patchFrom(BOT, settings, draft).bot, { display_name: '新名字' });
});

test('认不出来的时区原样保留（服务端存了别名也别悄悄改成继承）', () => {
  const exotic = { ...BOT, timezone: 'Etc/GMT+8' };
  const settings = {};
  const draft = draftFrom(exotic, settings);
  assert.equal(draft.timezone, 'Etc/GMT+8');
  assert.equal(patchFrom(exotic, settings, draft), null);
});

test('什么都没改 → 没有任何补丁（保存按钮该是禁用态）', () => {
  const settings = { chat_model_id: 'k3', reasoning_effort: 'high', display_enabled: true };
  const draft = draftFrom(BOT, settings);
  assert.equal(patchFrom(BOT, settings, draft), null);
});

test('只发改过的字段，本体与设置分开', () => {
  const settings = { chat_model_id: 'k3', reasoning_effort: 'high', display_enabled: true };
  const draft = { ...draftFrom(BOT, settings), displayName: '新名字' };
  const patch = patchFrom(BOT, settings, draft);
  assert.deepEqual(patch.bot, { display_name: '新名字' });
  assert.deepEqual(patch.settings, {});
});

test('把默认模型清掉 = 发空串（指针语义：空串是"清空"，不是"不改"）', () => {
  const settings = { chat_model_id: 'k3' };
  const draft = { ...draftFrom(BOT, settings), modelId: null };
  assert.deepEqual(patchFrom(BOT, settings, draft).settings, { chat_model_id: '' });
});

test('服务端没给 display_enabled 时**不动它**（老服务端没有这个字段）', () => {
  const settings = { chat_model_id: 'k3' };
  const draft = draftFrom(BOT, settings);
  assert.equal(draft.displayEnabled, true);
  assert.deepEqual(patchFrom(BOT, settings, draft), null);
});

test('桌面开关改了要发出去', () => {
  const settings = { display_enabled: true };
  const draft = { ...draftFrom(BOT, settings), displayEnabled: false };
  assert.deepEqual(patchFrom(BOT, settings, draft).settings, { display_enabled: false });
});

test('强度按服务端给的档位循环（含"关闭"）', () => {
  const options = ['off', 'low', 'high'];
  assert.equal(nextEffort(null, options), 'off');
  assert.equal(nextEffort('off', options), 'low');
  assert.equal(nextEffort('high', options), 'off');
  assert.equal(nextEffort('unknown', options), 'off');
});

test('没有可选项时强度不变（不该悄悄改成某个值）', () => {
  assert.equal(nextEffort('high', []), 'high');
});

// ---------------------------------------------------------------- 对话语言
//
// 桌面端的 Global Settings 第一行就是它（`settings-global-card.vue`）。服务端读回来是
// 字符串（默认 `"auto"`，实测过），写回去时空串会被归一化成 `"auto"`。所以这里要钉住三件：
// 没设过 = `auto`、选了某个语言就发那个 code、**改回 auto 发空串**（不是发 `auto`）。

test('服务端没给语言 / 给了 auto → 草稿是 auto', () => {
  assert.equal(draftFrom(BOT, {}).language, 'auto');
  assert.equal(draftFrom(BOT, { language: 'auto' }).language, 'auto');
  assert.equal(draftFrom(BOT, { language: '  ' }).language, 'auto');
});

test('选了语言就只发 language 这一个字段', () => {
  const settings = { language: 'auto', chat_model_id: 'k3' };
  const draft = { ...draftFrom(BOT, settings), language: 'zh-cn' };
  assert.deepEqual(patchFrom(BOT, settings, draft).settings, { language: 'zh-cn' });
});

test('改回"跟随"发的是空串（与桌面端下拉同一存法，服务端归一化成 auto）', () => {
  const settings = { language: 'en' };
  const draft = { ...draftFrom(BOT, settings), language: AUTO_LANGUAGE };
  assert.deepEqual(patchFrom(BOT, settings, draft).settings, { language: '' });
});

test('没动过语言 → 不出现这个字段（差分不许把别人的改动盖回去）', () => {
  const settings = { language: 'ja' };
  const draft = draftFrom(BOT, settings);
  assert.equal(draft.language, 'ja');
  assert.equal(patchFrom(BOT, settings, draft), null);
});

test('认不出来的语言原样保留（服务端加了新语言，客户端不该偷偷改成 auto）', () => {
  const settings = { language: 'xx-new' };
  assert.equal(normalizeLanguage('xx-new'), 'xx-new');
  assert.equal(draftFrom(BOT, settings).language, 'xx-new');
  assert.equal(patchFrom(BOT, settings, draftFrom(BOT, settings)), null);
  assert.equal(languageLabel('xx-new'), 'xx-new', '不认识的 code 显示它本身，不假装是"自动"');
  assert.equal(languageSubtitle('xx-new'), '');
});

test('清单与桌面端一致：39 项、code 唯一、都是小写、都有母语名', () => {
  assert.equal(CHAT_LANGUAGES.length, 39);
  const codes = CHAT_LANGUAGES.map((language) => language.code);
  assert.equal(new Set(codes).size, codes.length, 'code 不能重复');
  for (const language of CHAT_LANGUAGES) {
    assert.equal(language.code, language.code.toLowerCase());
    assert.notEqual(language.nativeName.trim(), '');
    assert.notEqual(language.name.trim(), '');
  }
  // 两个中文选项是这一行最常被选到的（桌面端的 code 就是这两个写法）。
  assert.equal(findLanguage('zh-cn')?.nativeName, '简体中文');
  assert.equal(findLanguage('zh-tw')?.nativeName, '繁體中文');
  assert.equal(findLanguage('EN')?.nativeName, 'English', '大小写不敏感');
  assert.equal(findLanguage(AUTO_LANGUAGE), null, 'auto 不是清单里的一项');
});

test('搜索三列都能命中（code / 英文名 / 母语名）', () => {
  assert.deepEqual(
    filterLanguages('zh-cn').map((item) => item.code),
    ['zh-cn'],
  );
  assert.deepEqual(
    filterLanguages('chinese').map((item) => item.code),
    ['zh-cn', 'zh-tw'],
  );
  assert.deepEqual(
    filterLanguages('中文').map((item) => item.code),
    ['zh-cn', 'zh-tw'],
    '两个中文选项都含"中文"',
  );
  assert.deepEqual(
    filterLanguages('日本語').map((item) => item.code),
    ['ja'],
    '母语名也能搜',
  );
  assert.equal(filterLanguages('').length, CHAT_LANGUAGES.length, '空查询 = 全部');
  assert.deepEqual(filterLanguages('zzz'), []);
});
