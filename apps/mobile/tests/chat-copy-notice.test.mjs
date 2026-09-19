/**
 * 复制成功的**第二重确认**：宿主必须把 `onMessageCopied` 接上。
 *
 * ## 为什么值得一条测试
 *
 * 原生侧"复制"这条链是完整的：长按菜单 → 落粘贴板 → `Copied` 胶囊 → 读屏播报
 * （见 `docs/CHAT-RENDERING.md` §5）。但它同时把事实报给了宿主（`onMessageCopied`，
 * 带上**渲染后的纯文本**），好让宿主用同一条 RN 文案（`chat.message.copied`）再确认一次。
 *
 * 那条文案因此长期是**孤儿 key**：kit 的 TS 面暴露了 prop、`MemohKitModule` 注册了事件、
 * Swift 侧发了事件，而生产宿主（`screens/ChatScreen.tsx`）**没人接**。孤儿 key 不会报错、
 * 不会崩，只会在"复制了但屏幕上没有任何反馈"时让人以为复制失败——所以它只能靠断言钉住。
 *
 * ## 断什么 / 不断什么
 *
 * 断的是**接线**：四段链条上每一段都还在（事件注册 → Swift 发出 → TS 面暴露 → 宿主接上），
 * 以及宿主用的是**同一条** i18n key（不是自己发明一句），并且**读屏也会听到**
 * （iOS 上 `accessibilityLiveRegion` 是空转的，唯一有效的机制是
 * `announceForAccessibility`，见 `lib/accessibility.ts` 的头注释）。
 *
 * 不断"提示条长什么样、停多久"——那是视觉，靠截图证。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const read = (relative) => readFileSync(join(MOBILE, relative), 'utf8');

const CHAT = read('src/screens/ChatScreen.tsx');
/**
 * 那几条状态横条（含复制提示）住在 `ui/ChatNotices.tsx`——2026-09-18 从 `ChatScreen`
 * 拆出去的（判据一个字没变，只是搬了家）。读源码的断言跟着指到新文件；不要改成
 * "两边都查"：那样搬家之后旧的断言会永远绿。
 */
const NOTICES = read('src/ui/ChatNotices.tsx');
const KIT_TSX = read('modules/memoh-kit/src/chat/NativeMessageList.tsx');
const KIT_MODULE = read('modules/memoh-kit/ios/MemohKitModule.swift');
const KIT_SWIFT = read('modules/memoh-kit/ios/Chat/NativeMessageList.swift');

/** 取出某个 JSX 元素从开标签到 `/>` 的那一段（自闭合的宿主列表就是这种形状）。 */
function jsxElement(source, name) {
  const start = source.indexOf(`<${name}`);
  assert.notEqual(start, -1, `找不到 <${name}>`);
  const end = source.indexOf('/>', start);
  assert.notEqual(end, -1, `<${name}> 不是自闭合元素？`);
  return source.slice(start, end);
}

test('复制成功这件事从原生一路报上来：事件注册 + Swift 发出 + TS 面暴露', () => {
  // Expo 模块必须**显式声明**要发的事件名，漏了宿主永远收不到（不是类型错误）。
  assert.match(
    KIT_MODULE,
    /Events\([^)]*"onMessageCopied"/,
    'MemohKitModule 没有注册 onMessageCopied 事件',
  );
  assert.match(
    KIT_SWIFT,
    /onMessageCopied\(\[/,
    'NativeMessageList.swift 落完粘贴板之后没有把复制事实报给宿主',
  );
  // TS 面：宿主是靠这个 prop 接的，没有它 ChatScreen 根本传不进去。
  assert.match(KIT_TSX, /onMessageCopied\?:/, 'kit 的 TS 面没有暴露 onMessageCopied');
  assert.match(KIT_TSX, /onMessageCopied=\{onMessageCopied\}/, 'TS 面没有把 prop 透给原生 view');
});

test('宿主接上了：ChatScreen 把 onMessageCopied 传给 NativeMessageList', () => {
  const list = jsxElement(CHAT, 'NativeMessageList');
  assert.match(
    list,
    /onMessageCopied=\{onMessageCopied\}/,
    'ChatScreen 没接 onMessageCopied —— chat.message.copied 又变成孤儿 key 了',
  );
});

test('确认文案只有一条：用既有的 chat.message.copied，且读屏也会念一次', () => {
  // 处理器本体（`const onMessageCopied = useCallback(...)`）：宿主自己发明一句文案、
  // 或者只画提示不播报，都会让"复制成功"对某一种读法不成立。
  const handler = CHAT.slice(CHAT.indexOf('const onMessageCopied'));
  assert.notEqual(handler.indexOf('const onMessageCopied'), -1, '找不到 onMessageCopied 处理器');
  const body = handler.slice(0, handler.indexOf('}, ['));
  assert.match(body, /'chat\.message\.copied'/, '宿主没有用既有的 chat.message.copied 文案');
  assert.match(
    body,
    /announceForAccessibility\(/,
    '复制确认只画了提示、没有播报（iOS 上 accessibilityLiveRegion 是空转的）',
  );

  // 提示条本身：视觉上也要出现那句文案（"轻提示"而不是只有读屏听得见）。
  assert.match(NOTICES, /testID="chat-copied-notice"/, '没有可被验收点到的提示条');
  assert.match(
    NOTICES.slice(NOTICES.indexOf('testID="chat-copied-notice"')),
    /t\('chat\.message\.copied'\)/,
    '提示条上印的不是那条既有文案',
  );

  // 两语都得有这条 key（中文缺了会在中文界面上印出 key 原文）。
  for (const locale of ['en.json', 'zh-Hans.json']) {
    const catalog = JSON.parse(read(`locales/${locale}`));
    assert.equal(
      typeof catalog['chat.message.copied'],
      'string',
      `${locale} 缺 chat.message.copied`,
    );
  }
});
