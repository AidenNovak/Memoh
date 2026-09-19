/**
 * 主题底座的测试。
 *
 * 这里守的是**看不见但会伤人**的东西：文字与背景的对比度、间距与圆角是否落在
 * 体系内、排版角色有没有行高。这些在截图里都不显眼，但它们决定了"读起来累不累"
 * 和"像不像一个 App"。
 *
 * 起因是一个真实的 bug：浅色模式的强调色原本是 `#7C5CFF`，对白底只有 4.35:1、
 * 对分组底 3.89:1——**两处都不满足 4.5:1**。而它被用在按钮文字、链接、选中态上，
 * 也就是最需要读清楚的地方。这类问题肉眼看不出，只有算才知道。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paletteFor, radius, spacing, typography } from '../src/lib/theme/tokens.ts';

/**
 * iOS 的语义色大多是**带 alpha 的**（`#3C3C4399` 是黑色 60%），必须先与背景
 * 合成再算对比度。
 *
 * 直接取 RGB 丢掉 alpha 会得出一个没有意义的数（`#3C3C43` 看起来像深灰，
 * 实际叠在白底上是中灰）——第一版测试就是这么错的，把 secondaryLabel 算成了
 * 10.94:1，而它实际只有 4.6:1 上下。
 */
function parse(color) {
  const hex = color.replace('#', '');
  const to = (i) => parseInt(hex.slice(i, i + 2), 16);
  return {
    r: to(0),
    g: to(2),
    b: to(4),
    a: hex.length === 8 ? to(6) / 255 : 1,
  };
}

/** 把前景按 alpha 叠在背景上，返回不透明色。 */
function composite(foreground, background) {
  const f = parse(foreground);
  const b = parse(background);
  const mix = (channel) => Math.round(f[channel] * f.a + b[channel] * (1 - f.a));
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 };
}

/** 相对亮度（WCAG 2.1）。 */
function luminance(rgb) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrast(foreground, background) {
  const solid = composite(foreground, background);
  const la = luminance(solid);
  const lb = luminance(parse(background));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const SCHEMES = [
  ['light', paletteFor('light', 'light')],
  ['dark', paletteFor('dark', 'dark')],
  ['oled', paletteFor('oled', 'dark')],
];

/**
 * 品牌色的**唯一真源**是 Memoh 桌面端（`@felinic/ui` 的 `style.css`）。
 *
 * 这些值由 `tools/oklch.py` 从 oklch 转出来。写成断言是为了防止"手滑改回去"：
 * 一旦有人在这里手改一个"看起来更顺眼"的紫，两端就不是同一个产品了。
 * 要改请改那个脚本，再同步过来。
 */
const MEMOH_BRAND = {
  light: '#764BE5',
  dark: '#A490FF',
};

const MEMOH_BACKGROUND = {
  // 暖白 + 暖黑。这是 Memoh 视觉身份的一部分，不是"随便挑的白"。
  light: '#FAF8F7',
  dark: '#060606',
};

test('品牌色与桌面端一致', () => {
  assert.equal(
    paletteFor('light', 'light').accent,
    MEMOH_BRAND.light,
    '浅色品牌色必须与桌面端 --brand 一致（改颜色请改 tools/oklch.py）',
  );
  assert.equal(
    paletteFor('dark', 'dark').accent,
    MEMOH_BRAND.dark,
    '深色品牌色必须与桌面端 --brand 一致',
  );
});

test('背景是 Memoh 的暖白/近黑，不是纯白/纯黑', () => {
  // 这条看着吹毛求疵，其实是"两端像不像一个产品"的关键：
  // 纯白配紫会冷，暖白配紫才是桌面端那个感觉。
  assert.equal(paletteFor('light', 'light').background, MEMOH_BACKGROUND.light);
  assert.equal(paletteFor('dark', 'dark').background, MEMOH_BACKGROUND.dark);
  assert.notEqual(
    paletteFor('light', 'light').card,
    paletteFor('light', 'light').background,
    '卡片与页面底必须不同色，否则卡片浮不起来又没有阴影可用',
  );
});

test('OLED 档：页面底是纯黑（这一档存在的**唯一**理由），且不是深色档的别名', () => {
  // A17 一直停在"部分"：浅色/深色各 30 张截图，**OLED 没验**。屏幕上的观感要模拟器
  // （`xcrun simctl ui <udid> appearance dark` + 截图），但这一档**为什么存在**是可以在
  // 这里钉住的：它是"省电"档，所以页面底必须是纯黑——不然它只是深色档换了个名字。
  const oled = paletteFor('oled', 'dark');
  const dark = paletteFor('dark', 'dark');

  assert.equal(oled.background, '#000000', 'OLED 档的页面底必须是纯黑——省电是它唯一的理由');
  assert.equal(oled.groupedBackground, '#000000');
  assert.equal(oled.reading, '#000000');
  assert.notEqual(oled.background, dark.background, '否则这一档只是深色档的别名');
  assert.notEqual(oled.card, dark.card, '卡片要再压暗一档，"纯黑"才名副其实');
  // 用户显式选了 OLED 就不跟系统走：系统切成浅色时它仍然是纯黑。
  assert.deepEqual(paletteFor('oled', 'light'), oled);
});

test('accent 在每种外观下都满足 4.5:1', () => {
  for (const [name, palette] of SCHEMES) {
    for (const background of [palette.background, palette.groupedBackground, palette.card]) {
      const ratio = contrast(palette.accent, background);
      assert.ok(
        ratio >= 4.5,
        `${name}: accent ${palette.accent} 对 ${background} 只有 ${ratio.toFixed(2)}:1，需要 ≥ 4.5:1`,
      );
    }
  }
});

/**
 * 阈值按**用途**分档，不是一律 4.5。
 *
 * 定这套阈值的依据是"Apple 自己怎么做"，而不是 WCAG 的原文：
 *
 * - `label`（正文）≥ 4.5 —— iOS `label` 在两种外观下都是 21:1，远超标准。
 * - `secondaryLabel`（次要文字）≥ 3 —— iOS 自己的 `secondaryLabel` 在浅色下
 *   就是 3.44:1。要求它 4.5 会让所有副标题比系统更深，界面立刻不像 iOS。
 *   平台基线在这里比 WCAG 更严会更糟。
 * - `onAccent`（按钮文字）≥ 3 —— 按钮文字是 17pt semibold，属于 WCAG 的
 *   "大字号"档（≥14pt 粗体），标准就是 3:1。参照物是 systemBlue 填色按钮：
 *   白字压 #0A84FF = 3.65:1。
 */
const MINIMUMS = { label: 4.5, secondaryLabel: 3, onAccent: 3 };

test('被强调色压住的文字达到大字号标准（≥3:1）', () => {
  for (const [name, palette] of SCHEMES) {
    const ratio = contrast(palette.onAccent, palette.accent);
    assert.ok(
      ratio >= MINIMUMS.onAccent,
      `${name}: onAccent ${palette.onAccent} 压在 accent ${palette.accent} 上只有 ${ratio.toFixed(2)}:1，` +
        `需要 ≥ ${MINIMUMS.onAccent}:1（按钮文字是大字号档，参照 systemBlue 的 3.65:1）`,
    );
  }
});

test('正文满足 4.5:1，次要文字达到平台基线 3:1', () => {
  for (const [name, palette] of SCHEMES) {
    for (const background of [palette.background, palette.groupedBackground, palette.card]) {
      for (const role of ['label', 'secondaryLabel']) {
        const ratio = contrast(palette[role], background);
        const minimum = MINIMUMS[role];
        assert.ok(
          ratio >= minimum,
          `${name}: ${role} 对 ${background} 只有 ${ratio.toFixed(2)}:1，需要 ≥ ${minimum}:1`,
        );
      }
    }
  }
});

test('tertiaryLabel 只做装饰，因此允许低对比——但必须真的低', () => {
  // 这条是**反向**断言：tertiaryLabel 不该被用来承载必要信息。
  // 如果哪天它变清楚了，说明有人把它当正文用了，那就该改用 secondaryLabel。
  const palette = paletteFor('light', 'light');
  const ratio = contrast(palette.tertiaryLabel, palette.background);
  assert.ok(
    ratio < 4.5,
    `tertiaryLabel 对比度 ${ratio.toFixed(2)}:1 已经够高，应该直接用 secondaryLabel`,
  );
});

test('每个排版角色都有行高', () => {
  for (const [role, style] of Object.entries(typography)) {
    assert.ok(
      typeof style.lineHeight === 'number' && style.lineHeight > 0,
      `${role} 缺少 lineHeight：iOS 系统行高比 fontSize*1.2 宽，不给会让多段文字挤在一起`,
    );
    assert.ok(
      style.lineHeight >= style.fontSize,
      `${role} 的 lineHeight (${style.lineHeight}) 小于 fontSize (${style.fontSize})`,
    );
  }
});

test('间距只有约定的档位', () => {
  // 六个档位是约束，不是巧合。加档会让每个页面长出自己的一套间距。
  assert.deepEqual(
    Object.values(spacing).sort((a, b) => a - b),
    [4, 8, 12, 16, 20, 24],
  );
});

test('圆角都是正整数且气泡有独立档位', () => {
  for (const [name, value] of Object.entries(radius)) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} 的圆角取值不合法：${value}`);
  }
  // 气泡用 19（Lody 的值），和面板 18 只差 1——这不是笔误，是两条独立的设计线。
  assert.equal(radius.bubble, 19);
  assert.equal(radius.card, 26);
});

test('浅色与深色的语义角色一一对应', () => {
  // 少一个角色就会出现"深色下这块没有颜色可用"的临时补丁。
  const lightKeys = Object.keys(paletteFor('light', 'light')).sort();
  const darkKeys = Object.keys(paletteFor('dark', 'dark')).sort();
  assert.deepEqual(lightKeys, darkKeys);
});
