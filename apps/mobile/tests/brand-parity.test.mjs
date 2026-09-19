/**
 * 两端品牌色必须一致。
 *
 * ## 为什么值得一个测试
 *
 * 颜色有两份实现：RN 侧 `src/lib/theme/tokens.ts`，原生侧
 * `modules/memoh-kit/ios/Support/MemohPalette.swift`。两份都对同一个来源
 * （桌面端 `@felinic/ui`）负责，但**没有任何机制强制它们保持一致**——改了一边
 * 忘了另一边，结果就是"消息列表是暖白、它上面的工具栏是系统白"，拼缝看得见，
 * 而且很难查（两边单独看都对）。
 *
 * 这个测试把两份定义读出来逐项对比。它不检查"颜色好不好看"（那是设计的事），
 * 只检查"两边是不是同一个颜色"。
 *
 * ## 为什么是 mjs 而不是 TS
 *
 * 它要读 Swift 源文件（纯文本 + 正则），不需要类型系统。放这里跑得快，
 * 而且和 `theme.test.mjs` 一起构成"主题的回归网"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOKENS = join(ROOT, 'src/lib/theme/tokens.ts');
const PALETTE = join(ROOT, 'modules/memoh-kit/ios/Support/MemohPalette.swift');

/** 把 Swift 里的 `static let name = UIColor(hex: 0xRRGGBB)` 读成 { name: '#RRGGBB' }。 */
function swiftColors() {
  const text = readFileSync(PALETTE, 'utf8');
  const found = {};
  for (const [, name, hex] of text.matchAll(
    /static let (\w+) = UIColor\(hex: 0x([0-9A-Fa-f]{6})\)/g,
  )) {
    found[name] = `#${hex.toUpperCase()}`;
  }
  return found;
}

/** 把 TS 里某个色板块的 `name: '#RRGGBB'` 读成对象。 */
function tsColors(block) {
  const text = readFileSync(TOKENS, 'utf8');
  const match = new RegExp(`${block}: Palette = \\{([\\s\\S]*?)\\n\\};`).exec(text);
  assert.ok(match, `tokens.ts 里找不到 ${block} 色板`);
  const found = {};
  for (const [, name, hex] of match[1].matchAll(/(\w+): '(#[0-9A-Fa-f]{6,8})'/g)) {
    found[name] = hex.toUpperCase();
  }
  return found;
}

/**
 * 两份定义的对应关系。
 *
 * 显式列出来而不是按名字自动配对：名字本来就不同（RN 用语义名 `background`，
 * Swift 用 `lightBackground`/`darkBackground` 区分明暗），而且**配对本身就是文档**
 * ——它说明了每个 RN 角色在原生侧对应谁。
 */
const PAIRS = [
  ['lightBackground', 'background', 'light'],
  ['lightCard', 'card', 'light'],
  ['lightLabel', 'label', 'light'],
  ['lightSecondaryLabel', 'secondaryLabel', 'light'],
  ['lightSeparator', 'separator', 'light'],
  ['lightDestructive', 'destructive', 'light'],
  ['lightInset', 'field', 'light'],
  ['lightUserBubble', 'userBubble', 'light'],
  ['darkBackground', 'background', 'dark'],
  ['darkCard', 'card', 'dark'],
  ['darkLabel', 'label', 'dark'],
  ['darkSecondaryLabel', 'secondaryLabel', 'dark'],
  ['darkDestructive', 'destructive', 'dark'],
  ['darkInset', 'field', 'dark'],
  ['darkUserBubble', 'userBubble', 'dark'],
];

const SWIFT = swiftColors();
const LIGHT = tsColors('light');
const DARK = tsColors('dark');

test('原生侧每个颜色都能在 RN 侧找到同一个值', () => {
  const blocks = { light: LIGHT, dark: DARK };
  for (const [swiftName, tsName, block] of PAIRS) {
    assert.ok(SWIFT[swiftName], `MemohPalette.swift 里找不到 ${swiftName}`);
    assert.ok(
      blocks[block][tsName],
      `tokens.ts 的 ${block} 里找不到 ${tsName}（原生侧 ${swiftName} 没有对应）`,
    );
    assert.equal(
      SWIFT[swiftName],
      blocks[block][tsName],
      `颜色不一致：Swift ${swiftName}=${SWIFT[swiftName]} vs RN ${block}.${tsName}=${blocks[block][tsName]}` +
        '——两端会对不上（比如列表暖白、工具栏系统白）。改颜色请改 tools/oklch.py 再同步两边。',
    );
  }
});

test('品牌色在两侧都是 Memoh 的紫', () => {
  // 品牌色是最要紧的一个：它错了整屏都不对。
  // 它不在 PAIRS 里（原生侧没有直接暴露 accent），所以单独钉一条。
  const brand = { light: '#764BE5', dark: '#A490FF' };
  assert.equal(LIGHT.accent, brand.light);
  assert.equal(DARK.accent, brand.dark);
});

test('分隔线在深色下用带 alpha 的白，浅色下用实色', () => {
  // 深色描边必须是半透明白（桌面端 `oklch(1 0 0 / 8%)`）：实色灰在近黑底上会显得脏。
  // 这条容易在"顺手统一成实色"时被改坏。
  assert.match(DARK.separator, /^#FFFFFF[0-9A-F]{2}$/, '深色分隔线应为半透明白');
  assert.match(LIGHT.separator, /^#[0-9A-F]{6}$/, '浅色分隔线应为实色');
});
