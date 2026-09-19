/**
 * 两处"门面"文案（评审 F3 与 F6）：返回键不许印上一屏的内部名字、登录页要说清
 * "服务器地址和账号从哪来"。
 *
 * ## 为什么这两条值得一条测试
 *
 * 两条都是**一眼可见**的东西，而两条的失败形态都**不会报错**：
 *
 * 1. `‹ (tabs)` —— `(tabs)` 是 Expo Router 的**路由组名**，不是任何用户见过的词。
 *    它出现在屏幕上是因为 `files/[...path].tsx` 与 `preview.tsx` 开了原生 header 却没设
 *    返回键的显示方式，于是 iOS 把上一屏的标题（那个路由组名）印在箭头后面。
 *    两个评审都点名了它（`docs/research/review-ux-flows.md` §2 F3、§7.4）。这类
 *    "内部名字漏到屏幕上"的东西最伤信任，而它**只在真机上看得见**——所以这里把
 *    "这三条原生 header 的路由必须显式收掉返回键文字"钉成结构断言。
 * 2. 登录页 —— 全屏 16 条 `login.*` 文案里**没有一条**说地址和账号从哪来；三页引导也只讲
 *    了"数据在你自己服务器上"。第一次用的人卡在登录页时，屏幕上没有任何地方能回答
 *    "我该填什么"。补的那句话要**说出处**（谁给、去哪儿看），不许说教。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');

function read(relative) {
  return readFileSync(join(MOBILE, relative), 'utf8');
}

function catalog(name) {
  return JSON.parse(readFileSync(join(MOBILE, 'locales', name), 'utf8'));
}

/** 开了原生 header 的那三条路由（评审点名的是前两条；根那一页同属一套）。 */
const NATIVE_HEADER_ROUTES = [
  'src/app/files/[...path].tsx',
  'src/app/files/index.tsx',
  'src/app/preview.tsx',
];

// ------------------------------------------- ① 返回键不许印上一屏的名字

test('三条原生 header 的路由都收掉了返回键文字（否则又会出现 ‹ (tabs)）', () => {
  for (const route of NATIVE_HEADER_ROUTES) {
    const source = read(route);
    assert.match(
      source,
      /headerBackButtonDisplayMode: 'minimal'/,
      `${route} 没设 headerBackButtonDisplayMode：iOS 会把上一屏的标题印在返回箭头后面`,
    );
    // `headerBackTitle` 只要出现就是**显式**给返回键写了个标题；本 App 其它 push 页画的
    // 都是光秃秃一个 `‹`，这里跟着统一，所以这条一出现就该有人解释它。
    assert.ok(
      !/headerBackTitle:/.test(source),
      `${route} 给返回键写了标题：这一屏的返回键应当只有箭头`,
    );
  }
});

test('用户能看到的文案里不许出现路由组名（(tabs) 这种内部名字）', () => {
  const leaks = [];
  for (const name of ['en.json', 'zh-Hans.json']) {
    for (const [key, value] of Object.entries(catalog(name))) {
      if (typeof value === 'string' && /\(tabs\)/.test(value))
        leaks.push(`${name}: ${key} = ${value}`);
    }
  }
  assert.deepEqual(leaks, [], `文案里漏了路由内部名：\n  ${leaks.join('\n  ')}`);
});

// ------------------------------------- ② 登录页要说清地址与账号从哪来

test('登录页把那句说明画在服务器那一行下面（用户正看着这两个框的时刻）', () => {
  const source = read('src/screens/LoginScreen.tsx');
  const hint = source.indexOf("t('login.server.hint')");
  const serverRow = source.indexOf('testID="login-server-toggle"');
  assert.ok(serverRow > 0, '找不到服务器那一行——这一条断言的前提没了');
  assert.ok(hint > 0, '登录页没有那句说明：第一次用的人还是不知道地址从哪来');
  assert.ok(hint > serverRow, '说明要放在服务器那一行的**下面**（先看到那一行，再读出处）');
});

test('那句话说了"谁给你、去哪儿看"，不是一句"请咨询管理员"式的说教', () => {
  // 判据是**形状**不是措辞：中英各自必须点到"出处"这件事。这样改词不会让测试变红，
  // 但"删掉出处只留一句空话"会。
  const sources = {
    'en.json': /desktop|deploy|admin|host|provider/i,
    'zh-Hans.json': /桌面|部署|管理员|服务商/,
  };
  for (const [name, pattern] of Object.entries(sources)) {
    const hint = catalog(name)['login.server.hint'];
    assert.ok(typeof hint === 'string' && hint.trim() !== '', `${name} 缺 login.server.hint`);
    assert.match(hint, pattern, `${name} 的那句话没说清"这两样东西从哪来"：${hint}`);
  }
});

test('那句话同时点到"地址"和"账号"两样东西（缺一样，用户还是不知道另一个填什么）', () => {
  const en = catalog('en.json')['login.server.hint'];
  const zh = catalog('zh-Hans.json')['login.server.hint'];
  assert.match(en, /address/i);
  assert.match(en, /account/i);
  assert.match(zh, /地址/);
  assert.match(zh, /账号/);
});
