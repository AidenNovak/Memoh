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
 * 3. 登录首页现在是 **Cloud 入口 + 自部署入口** 两段（对齐 Cloud 登录页）。Cloud 的
 *    GitHub / Google / 邮箱三个入口是**诚实占位**：服务端合同（§4.7 的 PKCE 一次性
 *    code）没落地之前，它们只给本地化的"尚未开放"反馈，**不许发请求、不许跳
 *    WebView、不许装死**。旧合同（"这里没有 Google 按钮，因为服务端没有第三方登录"）
 *    到这一版为止，下面把它换成新合同的结构断言。
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

test('可点击的聊天标题仍把会话名留在 VoiceOver 标签里', () => {
  const source = read('src/ui/ChatHeader.tsx');
  assert.ok(
    source.includes("accessibilityLabel={`${title}, ${t('sessionInfo.open')}`}"),
    '标题 Pressable 只念“Session info”会吞掉当前会话名；应同时说明会话名与动作',
  );
});

test('只读账号不暴露实时输入、机器或未授权 hub 入口', () => {
  const hub = read('src/screens/SessionsHubScreen.tsx');
  const chat = read('src/screens/ChatScreen.tsx');
  const notices = read('src/ui/ChatNotices.tsx');
  const scheduleEdit = read('src/screens/ScheduleEditScreen.tsx');
  assert.match(hub, /hubViewsFor\(currentBot\)/);
  assert.match(hub, /visibleHubView\(currentBot, view\)/);
  assert.match(hub, /hubViews\.length > 1/);
  assert.match(hub, /visibleView === 'sessions' && realtimeEnabled/);
  assert.match(chat, /showMachine=\{currentBot !== null && canManageBot\(currentBot\)\}/);
  assert.match(chat, /permissionsKnown=\{currentBot !== null\}/);
  assert.match(chat, /\{realtimeEnabled \? \(\s*<ChatComposer/);
  assert.match(chat, /realtimeEnabled \? \(\s*<QueueStrip/);
  assert.match(chat, /!realtimeEnabled \|\| pending === null/);
  assert.match(notices, /testID="chat-read-only"/);
  assert.match(notices, /!permissionsKnown \|\| realtimeEnabled/);
  assert.match(notices, /chat\.readOnly/);
  assert.match(scheduleEdit, /const allowed = canManageBot\(currentBot\)/);
  assert.match(scheduleEdit, /allowed \? \(currentBot\?\.id \?\? null\) : null/);
  assert.match(scheduleEdit, /testID="schedule-permission"/);
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

// ------------------------------- ③ 登录首页的新合同：Cloud 占位 + 自部署入口

test('Cloud 三个入口与自部署切换/返回都有稳定 testID（自动化不靠坐标）', () => {
  const source = read('src/screens/LoginScreen.tsx');
  for (const id of [
    'login-cloud-github',
    'login-cloud-google',
    'login-cloud-email-input',
    'login-cloud-email-continue',
    'login-cloud-notice',
    'login-selfhosted-toggle',
    'login-selfhosted-back',
  ]) {
    assert.ok(source.includes(`testID="${id}"`), `登录页缺 testID：${id}`);
  }
});

test('自部署入口在 Cloud 入口**下面**（信息层级：官方入口在前，自部署在后）', () => {
  const source = read('src/screens/LoginScreen.tsx');
  const cloud = source.indexOf('testID="login-cloud-email-continue"');
  const selfHosted = source.indexOf('testID="login-selfhosted-toggle"');
  assert.ok(cloud > 0 && selfHosted > 0, '两个入口都该在');
  assert.ok(selfHosted > cloud, '自部署入口要放在 Cloud 官方入口的下面');
});

test('Cloud 占位是诚实的：按下给本地化的"尚未开放"，不发请求、不跳 WebView、不做假 OAuth', () => {
  const source = read('src/screens/LoginScreen.tsx');
  // 三个入口的反馈是同一句本地化文案，且界面上真的画出来（testID 在上面那条钉过）。
  assert.ok(
    source.includes("t('login.cloud.unavailable')"),
    'Cloud 占位按下后没有"尚未开放"的反馈——那就是装死按钮',
  );
  // 占位不许做的事：WebView 填密码、外跳浏览器 OAuth、读链接库——出现一个就是越界。
  // 只查**代码**：文件头注释里本来就会**提到**这些词（说明为什么不许做），
  // 把注释也算进来，合同就变成了"连提都不许提"，那谁也说不清这条禁令了。
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  for (const forbidden of ['WebView', 'ASWebAuthenticationSession', 'Linking', 'openURL']) {
    assert.ok(
      !code.includes(forbidden),
      `登录页的代码里出现了 ${forbidden}：Cloud 占位不许偷偷变成真 OAuth/WebView（合同见 memoh-ios-dev.md §4.7）`,
    );
  }
  // 反馈文案本身要说出"还没开放"这件事，中英都要。
  const en = catalog('en.json')['login.cloud.unavailable'];
  const zh = catalog('zh-Hans.json')['login.cloud.unavailable'];
  assert.match(en, /not available yet|isn't available yet/i);
  assert.match(zh, /尚未开放/);
});

test('Cloud 与自部署各自有准确标题，Google 保留官方彩色标记', () => {
  const source = read('src/screens/LoginScreen.tsx');
  assert.ok(source.includes("t('login.selfhosted.title')"));
  assert.ok(source.includes("t('login.selfhosted.subtitle')"));
  assert.match(source, /login-cloud-google[\s\S]*?preserveIconColor/);
  assert.ok(source.includes("require('../../assets/images/google-mark-color.png')"));

  assert.equal(catalog('en.json')['login.selfhosted.title'], 'Sign in');
  assert.equal(catalog('zh-Hans.json')['login.selfhosted.title'], '登录');
});

test('Cloud 邮箱格式错误与占位反馈都会主动播报', () => {
  const source = read('src/screens/LoginScreen.tsx');
  assert.ok(
    source.includes("useAnnounceOnAppear(showEmailError ? t('login.cloud.email.invalid') : null)"),
  );
  assert.ok(
    source.includes("useAnnounceOnAppear(cloudNotice ? t('login.cloud.unavailable') : null)"),
  );
});
