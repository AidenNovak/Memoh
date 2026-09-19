/**
 * 设置页与头像的两个纯判断。
 *
 * 这两条都是"看起来显然、其实有分岔"的地方，所以值得单独测：
 *
 * 1. **头像画什么**：没有 `avatar_url`、以及**有但加载失败**，都必须落到那枚吉祥物上。
 *    后者是这轮修的真 bug——真机上留下过一个空白灰方块（用户看到的是"还没画完"）。
 *    2026-09-16 又补了一轮：**`''` 不是服务端唯一的"没有头像"形状**（见下面那三个用例）。
 *    2026-09-17 再加一族：`memoh:avatar/<slug>` **内置头像标识**（不打字也能换头像），
 *    以及"前缀是我们的、项认不出"时必须落回吉祥物、**不去请求一个假地址**。
 * 2. **账号显示名**：显示名是**空串**（服务端很常见）时退回登录名；没有会话时不显示这一行。
 *    写成 `displayName || username` 会把"空显示名"和"没会话"混成同一件事。
 *
 * 还有一条**跨文件**的断言在最后：内置头像表里的每个 `nameKey` 都得在两份文案表里有值。
 * 少了它，"加一枚头像忘了加文案"要等到真机上看见空标签才发现。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { avatarFor, avatarRetryOnConnection, avatarValueKey } from '../src/features/bots/avatar.ts';
import {
  BUILTIN_AVATARS,
  BUILTIN_AVATAR_PREFIX,
  builtinAvatarBySlug,
  builtinAvatarSlugOf,
  builtinAvatarToken,
  isBuiltinAvatar,
} from '../src/features/bots/avatarPresets.ts';
import { draftFrom, patchFrom } from '../src/features/bots/settings.ts';
import { accountNameOf } from '../src/features/session/account.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'locales');

test('没有 avatar_url 的 bot 用默认吉祥物', () => {
  assert.deepEqual(avatarFor({ avatar_url: '' }), { kind: 'mark' });
  assert.deepEqual(avatarFor({ avatar_url: '   ' }), { kind: 'mark' });
});

test('没有 bot（未登录/还没拉到）也用默认吉祥物', () => {
  assert.deepEqual(avatarFor(null), { kind: 'mark' });
});

test('有 avatar_url 就画那张图', () => {
  assert.deepEqual(avatarFor({ avatar_url: 'https://cdn.example.com/a.png' }), {
    kind: 'remote',
    uri: 'https://cdn.example.com/a.png',
  });
});

/**
 下面三条是**服务端返回形状**的用例。

 为什么以前是绿的、真机上是红的：固定服务端一律给 `''`，而真服务端给的是**别的形状**
 —— dev 栈 2026-09-16 实测 `GET /bots` 的响应里**没有 `avatar_url` 这个 key**
 （Go 侧 `AvatarURL string \`json:"avatar_url,omitempty"\``，没有头像就整个省略）。
 于是 `bot.avatar_url.trim()` 抛 `Cannot read property 'trim' of undefined`，
 会话列表整屏红屏——而 fixture 那套全绿。

 所以判据是"**是不是非空字符串**"，不是"等不等于空串"。
 */
test('服务端整个省略 avatar_url 这个 key（dev 栈实测的形状）→ 默认吉祥物', () => {
  assert.deepEqual(avatarFor({}), { kind: 'mark' });
  assert.deepEqual(avatarFor({ name: 'assistant', display_name: 'iOS Dev' }), { kind: 'mark' });
});

test('avatar_url 是 null（另一种同形状的坏值）→ 默认吉祥物，不抛', () => {
  assert.deepEqual(avatarFor({ avatar_url: null }), { kind: 'mark' });
});

test('avatar_url 不是字符串（形状坏掉）→ 默认吉祥物，不抛', () => {
  assert.deepEqual(avatarFor({ avatar_url: 42 }), { kind: 'mark' });
  assert.deepEqual(avatarFor({ avatar_url: {} }), { kind: 'mark' });
  assert.deepEqual(avatarFor({ avatar_url: ['https://cdn.example.com/a.png'] }), { kind: 'mark' });
});

/**
 头像加载失败之后的**重试**判据。

 为什么需要它：改前 `onError` 一置就是永久——电梯里打开过的 bot，头像再也不会回来
 （只有换 bot/换 url 才重置）。做法照 Element X 的 `loadImageRetryingOnReconnection`：
 **连接回到 `open` 时给一次重试**，且**同一次 open 只给一次**（图真的坏了时不能变成
 无限重试循环）。

 状态与转移都是纯函数，所以这一条不需要渲染就能钉住；`BotAvatar` 只负责把
 `connection` 喂进来。
 */
test('连接回到 open：失败态被清掉一次，同一次 open 只清一次', () => {
  const failed = { failed: true, retriedOnOpen: false };
  const cleared = avatarRetryOnConnection(failed, true);
  assert.deepEqual(cleared, { failed: false, retriedOnOpen: true }, 'open 到了就该给一次重试');

  // 重试又失败（图真的坏了）：同一次 open 内不许再清——否则就是无限重试。
  const failedAgain = { failed: true, retriedOnOpen: true };
  assert.deepEqual(avatarRetryOnConnection(failedAgain, true), failedAgain);
});

test('连接断开→再回来：新的一次 open 可以再重试一次', () => {
  const reconnecting = avatarRetryOnConnection({ failed: true, retriedOnOpen: true }, false);
  assert.deepEqual(
    reconnecting,
    { failed: true, retriedOnOpen: false },
    '离开 open 就重置"这一次给过了"',
  );
  assert.deepEqual(avatarRetryOnConnection(reconnecting, true), {
    failed: false,
    retriedOnOpen: true,
  });
});

test('没失败过 / 连接不是 open：什么都不做', () => {
  const healthy = { failed: false, retriedOnOpen: false };
  assert.deepEqual(avatarRetryOnConnection(healthy, true), healthy);
  assert.deepEqual(avatarRetryOnConnection(healthy, false), healthy);
  assert.deepEqual(avatarRetryOnConnection({ failed: false, retriedOnOpen: true }, true), {
    failed: false,
    retriedOnOpen: true,
  });
  // 连接从没 open 过（idle / connecting / unauthorized）：不给重试——那不是"网络回来了"。
  const failed = { failed: true, retriedOnOpen: false };
  assert.deepEqual(avatarRetryOnConnection(failed, false), failed);
});

test('账号显示名：优先显示名', () => {
  assert.equal(accountNameOf({ displayName: 'Aiden', username: 'aiden' }), 'Aiden');
});

test('账号显示名：显示名为空串时退回登录名（不是空）', () => {
  assert.equal(accountNameOf({ displayName: '', username: 'aiden' }), 'aiden');
});

test('没有会话时不给名字（那一行整个不显示）', () => {
  assert.equal(accountNameOf(null), '');
});

/* ------------------------------------------------------------------ 内置头像 */

/**
 内置头像的**值形状**。

 这是这一版的存储契约：`avatar_url` 里除了"一个网址"还可能是 `memoh:avatar/<slug>`
 （理由与代价在 `src/features/bots/avatarPresets.ts` 的文件头）。所以这里盯三件事：
 表里的值认得出来、认不出的值**落回吉祥物**、以及别人的值一个都不许被误判。
 */
test('内置头像标识认得出，并且回的就是那一枚（不联网）', () => {
  for (const preset of BUILTIN_AVATARS) {
    assert.deepEqual(avatarFor({ avatar_url: builtinAvatarToken(preset) }), {
      kind: 'builtin',
      slug: preset.slug,
    });
  }
});

test('前缀是我们的、但这一项不在表里 → 吉祥物（不去请求一个 memoh: 开头的假地址）', () => {
  assert.deepEqual(avatarFor({ avatar_url: `${BUILTIN_AVATAR_PREFIX}gone` }), { kind: 'mark' });
  // 只有一个前缀（没写 slug）同理。
  assert.deepEqual(avatarFor({ avatar_url: BUILTIN_AVATAR_PREFIX }), { kind: 'mark' });
});

test('真正是别人的值一个都不许被误判成内置', () => {
  // 前缀必须**在开头**：夹在中间的不算（那是某个真实网址的一部分）。
  assert.deepEqual(
    avatarFor({ avatar_url: `https://cdn.example.com/${BUILTIN_AVATAR_PREFIX}paw` }),
    {
      kind: 'remote',
      uri: `https://cdn.example.com/${BUILTIN_AVATAR_PREFIX}paw`,
    },
  );
  // 大小写也不能放宽：服务端的值原样进来，我们只认自己写出去的那个形状。
  assert.deepEqual(avatarFor({ avatar_url: 'MEMOH:AVATAR/paw' }), {
    kind: 'remote',
    uri: 'MEMOH:AVATAR/paw',
  });
  // 别家 scheme、裸的 slug、以及表的 slug 本身，都还是普通网址。
  assert.deepEqual(avatarFor({ avatar_url: 'data:image/png;base64,AAAA' }), {
    kind: 'remote',
    uri: 'data:image/png;base64,AAAA',
  });
  assert.deepEqual(avatarFor({ avatar_url: 'paw' }), { kind: 'remote', uri: 'paw' });
});

test('isBuiltinAvatar：只有"前缀 + 表里有"才算，非字符串一律不算', () => {
  assert.equal(isBuiltinAvatar(builtinAvatarToken(BUILTIN_AVATARS[0])), true);
  assert.equal(isBuiltinAvatar(`${BUILTIN_AVATAR_PREFIX}gone`), false);
  assert.equal(isBuiltinAvatar(''), false);
  assert.equal(isBuiltinAvatar('https://cdn.example.com/a.png'), false);
  assert.equal(isBuiltinAvatar(undefined), false);
  assert.equal(isBuiltinAvatar(null), false);
  assert.equal(isBuiltinAvatar(42), false);
});

test('builtinAvatarSlugOf：只拆前缀，认不认得 slug 是另一件事', () => {
  assert.equal(builtinAvatarSlugOf(`${BUILTIN_AVATAR_PREFIX}cube`), 'cube');
  assert.equal(builtinAvatarSlugOf(`${BUILTIN_AVATAR_PREFIX}gone`), 'gone');
  assert.equal(builtinAvatarSlugOf(BUILTIN_AVATAR_PREFIX), null);
  assert.equal(builtinAvatarSlugOf('https://x/y.png'), null);
});

test('设置页那一行右边写哪种说法（封闭三种，都不摆值本身）', () => {
  assert.equal(avatarValueKey({ kind: 'mark' }), 'avatar.default');
  assert.equal(avatarValueKey({ kind: 'builtin', slug: 'paw' }), 'avatar.preset.paw');
  assert.equal(
    avatarValueKey({ kind: 'remote', uri: 'https://cdn.example.com/a.png' }),
    'avatar.custom',
  );
});

/**
 **默认值没有变**：不挑任何内置头像时，草稿、差分、画出来的东西与改前完全一样。

 `patchFrom` 的判据是"草稿 != 服务端现值"，所以这里同时钉住"空串不产生补丁"与
 "挑一枚内置头像会产生一条 `avatar_url` 补丁"——后者是**服务端形状照旧**的证据：
 走的是同一个 `bot.avatar_url` 字段，没有新字段、没有新端点。
 */
test('不选头像 = 现状：空串 / 缺字段都不产生补丁', () => {
  const bot = { id: 'b1', name: 'assistant', display_name: 'A', avatar_url: '', is_active: true };
  assert.equal(patchFrom(bot, null, draftFrom(bot, null)), null);

  const noAvatarKey = { ...bot, avatar_url: undefined };
  const draft = draftFrom(noAvatarKey, null);
  assert.equal(draft.avatarUrl, '');
  assert.equal(patchFrom(noAvatarKey, null, draft), null);
});

test('挑一枚内置头像 → 差分里就是那条标识（同一个 avatar_url 字段）', () => {
  const bot = { id: 'b1', name: 'assistant', display_name: 'A', avatar_url: '', is_active: true };
  const preset = builtinAvatarBySlug('paw');
  assert.notEqual(preset, undefined);

  const draft = draftFrom(bot, null);
  const token = builtinAvatarToken(preset);
  const patch = patchFrom(bot, null, { ...draft, avatarUrl: token });
  assert.deepEqual(patch, { bot: { avatar_url: token }, settings: {} });
  // 存进去的值服务端原样回得来（归一化不动它）→ 再算一次差分为空，不会"每次都多发一条"。
  const reloaded = { ...bot, avatar_url: token };
  assert.equal(patchFrom(reloaded, null, draftFrom(reloaded, null)), null);
});

test('内置头像标识里的值必须都被服务端原样收下（没有空白、没有换行）', () => {
  for (const preset of BUILTIN_AVATARS) {
    const token = builtinAvatarToken(preset);
    assert.equal(token, token.trim());
    assert.equal(token.includes('\n'), false);
  }
});

/**
 跨文件的那一条：表里的 `nameKey` 必须在**两份**文案表里都有值。

 为什么值得放在这里：加一枚头像要改三个地方（表、en、zh-Hans），漏一个的后果是
 "选择器里那一格没有名字"——一个只有真机上才看得见、而且看起来像"这格坏了吧"的空标签。
 `check-locales.mjs` 管不了它（它只管两份表彼此对齐，不管代码里引用的 key 存不存在）。
 */
test('每个内置头像的文案键在两份文案表里都有值', () => {
  const catalogs = ['en.json', 'zh-Hans.json'].map((name) =>
    JSON.parse(readFileSync(join(LOCALES, name), 'utf8')),
  );
  const missing = [];
  for (const preset of BUILTIN_AVATARS) {
    for (const catalog of catalogs) {
      const value = catalog[preset.nameKey];
      if (typeof value !== 'string' || value.trim() === '') {
        missing.push(`${preset.nameKey}（${preset.slug}）`);
      }
    }
  }
  assert.deepEqual(missing, [], `这些内置头像没有文案：\n  ${missing.join('\n  ')}`);

  // 设置页那一行的三种说法也一样：漏了就是那一行右边空着。
  for (const key of ['avatar.default', 'avatar.custom']) {
    for (const catalog of catalogs) {
      assert.equal(typeof catalog[key], 'string', `${key} 缺文案`);
    }
  }
});

test('内置头像的 slug 不重复（重复的那一枚永远选不到）', () => {
  const slugs = BUILTIN_AVATARS.map((preset) => preset.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  // 每个 slug 与它写进 token 的形状一致（改了 slug 就是数据迁移，所以这里钉住形状）。
  for (const slug of slugs) {
    assert.match(slug, /^[a-z][a-z0-9-]*$/);
  }
});

/* --------------------------------------------------- 两页的接线（结构性断言） */

/**
 换头像这件事有**两个入口**：设置页与新建页。上面那些纯判断只管"值怎么解释"，
 管不了"哪一页真的把它接上了"——而这一轮的毛病恰恰是**同一件事只做了一半**：
 设置页接上了选择器，新建页还留着一个手输的 `Avatar URL`。

 为什么这两页值得各钉一条：拆掉接线之后，界面上**看不出坏**——新建页那个输入框照样能用
 （想换头像的人自己去搞一个图片地址就行），只有"不打字能不能换"这件事悄悄退回去了。
 真机上要碰到它需要走完整条新建流程（一条 flow + 一台设备），所以这里把接线本身钉住；
 真机那半条由 `verification/navigation/bots-create-flow.yaml` 走（选一枚 → 服务端收到的
 `avatar_url` 就是那条标识）。

 和 `tests/bot-settings-unsaved.test.mjs` 一样：**读源码、去掉注释**——文件头里正在解释
 "为什么不再是一个手输框"，那不算用法。
 */
function screenCode(relative) {
  return readFileSync(join(HERE, '..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CREATE_CODE = screenCode('src/screens/BotCreateScreen.tsx');

test('新建页的头像那一行也是选择器（复用设置页那一套，不是第二套）', () => {
  assert.match(
    CREATE_CODE,
    /import \{ AvatarPickerSheet \} from '\.\.\/ui\/AvatarPickerPage\.tsx';/,
    '新建页没有接上共用的头像选择器',
  );
  assert.match(
    CREATE_CODE,
    /await present\(AvatarPickerSheet, \{ avatarUrl: form\.avatarUrl \}\)/,
    '新建页没有把当前草稿交给选择器',
  );
  assert.ok(
    !CREATE_CODE.includes('bot-field-avatar-input'),
    '新建页还留着手输的 Avatar URL 输入框：又变成"先自己拥有一个图片地址"才能换头像',
  );
});

test('新建页头像那一行：标题说人话、右边只说"选的是哪种"、点了才开选择器', () => {
  assert.match(
    CREATE_CODE,
    /testID="bot-field-avatar"[\s\S]{0,900}?title=\{t\('avatar\.row'\)\}/,
    '新建页那一行还叫 "Avatar URL"（说的是实现，不是用途）',
  );
  assert.match(
    CREATE_CODE,
    /value=\{t\(avatarValueKey\(avatarFor\(\{ avatar_url: form\.avatarUrl \}\)\)\)\}/,
    '右边没有说"选的是哪一种"——摆值本身会把标签挤没（真机截图上 "Avata/r URL" 就是这么来的）',
  );
  assert.match(CREATE_CODE, /testID="bot-field-avatar"[\s\S]{0,900}?onPress=\{pickAvatar\}/);
});
