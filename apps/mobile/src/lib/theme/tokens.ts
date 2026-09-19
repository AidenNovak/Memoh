/**
 * 主题底座 —— **对齐 Memoh 桌面端**的品牌 token。
 *
 * ## 这份文件的来源
 *
 * 所有颜色都取自桌面端的唯一色值源：`@felinic/ui` 的 `src/style.css`
 * （`packages/ui` 是个 git submodule）。桌面端用 **OKLCH** 定义颜色——那是给浏览器的
 * （相对颜色语法、感知均匀调色），而 React Native 不认识 oklch，只吃 `#RRGGBB`。
 *
 * 转换在 `tools/oklch.py` 里做，那里同时保留了"哪个 token 对应什么用途"的对照表。
 * **改颜色请改那个脚本再同步过来**，不要在这里手改——手改一次，两边就再也对不上了。
 *
 * ## 与"直接用 iOS 语义色"的区别
 *
 * 前一版按 iOS 惯例用了 `#FFFFFF` / `#000000` / `systemBackground` 那套。这一版改用
 * Memoh 自己的颜色，因为**品牌一致性**比"iOS 默认观感"更重要：用户在桌面端认得的
 * 是暖白的 `#FAF8F7`、暖黑的 `#191816`、以及那个紫色 `#764BE5`。用系统灰会让两个端
 * 看起来像两个产品。
 *
 * ## 排版仍保留 iOS 的阶梯
 *
 * 角色名对齐桌面端的语义角色，但字号用 iOS 的（正文 17pt 而不是 15px）——手机的
 * 可视距离更近，这是平台差异不是不一致。行高一律显式给：iOS 系统行高比
 * `fontSize * 1.2` 宽，不给会让多段文字挤在一起。
 *
 * ## 三处刻意的偏离，都有理由
 *
 * 1. **深色下压在品牌色上的文字用深墨而不是白。**
 *    桌面端 `--brand-foreground` 是近白色（`#FAFAFB`），压在深色品牌色
 *    `#A490FF` 上只有 **2.51:1**。但桌面端**自己的**深色高强调按钮
 *    `--btn-primary: oklch(0.976 0 0)` 恰恰是"浅填充 + 深墨"（16.56:1）。
 *    把同一套逻辑用到品牌填充上：`#191816` 压 `#A490FF` = **6.77:1**。
 *    既守着他们的深色哲学，又可读。
 * 2. **`success` 用系统绿。** Memoh 的颜色体系里没有"在线/成功"这一档
 *    （`--chart-2` 是绿色但那是图表色）。这个语义只有 iOS 需要。
 * 3. **`overlay` 保留 iOS 的遮罩浓度。** 桌面端没有 sheet 遮罩这个概念。
 *
 * `tests/theme.test.mjs` 会把这些约束钉住——包括上面三处的例外也要达标。
 */

/** 主题模式：跟随系统 / 强制浅色 / 强制深色 / 深色下用纯黑。 */
export type AppearanceMode = 'system' | 'light' | 'dark' | 'oled';

/** RN 的 ColorSchemeName 含 'unspecified'，这里收敛成三态。 */
export type SystemScheme = 'light' | 'dark' | null | undefined;

export interface Palette {
  /** 页面底。桌面端 `--background`：暖白，不是纯白。 */
  background: string;
  /** 分组容器/侧栏底。桌面端 `--background-chrome`，比页面低一档。 */
  groupedBackground: string;
  /** 卡片底。桌面端 `--card`：纯白，浮在暖白页面上。 */
  card: string;
  /** 阅读面（对话页消息流）。与 `background` 同色——连续阅读时白底更安静。 */
  reading: string;
  /** 正文。桌面端 `--foreground`：暖黑。 */
  label: string;
  /** 次要文字。桌面端 `--muted-foreground`。 */
  secondaryLabel: string;
  /** 三级文字。桌面端没有这一档，由 `muted-foreground` 再降一档得到。 */
  tertiaryLabel: string;
  /** 占位文字。与 `tertiaryLabel` 同值。 */
  placeholder: string;
  /** 描边与分隔线。桌面端 `--border`。 */
  separator: string;
  /** 品牌色。桌面端 `--brand`。**唯一强调色**。 */
  accent: string;
  /** 压在品牌色上的文字。见文件头第 1 条偏离。 */
  onAccent: string;
  /** 品牌色的淡底（选中态、淡标签）。桌面端 `--brand-soft`。 */
  accentSoft: string;
  /** 品牌色的描边。桌面端 `--brand-border`。 */
  accentBorder: string;
  /** 品牌色按下态。桌面端 `--brand-hover`。 */
  accentPressed: string;
  /** 危险动作/错误。桌面端 `--destructive`。 */
  destructive: string;
  /** 成功/在线。**iOS 专用**，见文件头第 2 条偏离。只用于状态点。 */
  success: string;
  /** 警告。 */
  warning: string;
  /** 输入框/下沉面。桌面端 `--muted`。 */
  field: string;
  /** 下沉 chip。与 `field` 同值，语义上区分"不承载输入"。 */
  inset: string;
  /** 用户消息气泡底。桌面端由品牌色派生（`oklch(from var(--brand) …)`）。 */
  userBubble: string;
  /** 用户气泡上的文字。 */
  userBubbleForeground: string;
  /** 覆盖层（sheet 后面的遮罩）。iOS 专用，见文件头第 3 条偏离。 */
  overlay: string;
}

/**
 * 浅色。取值 = `tools/oklch.py` 输出的 hex。
 *
 * 注意 `background` 是 **#FAF8F7**（暖白）而不是 #FFFFFF——这是 Memoh 视觉身份的一部分，
 * 也是"和桌面端对齐"最容易被忽略的一处。卡片才是纯白，于是卡片自然浮起来，不需要阴影。
 */
const light: Palette = {
  background: '#FAF8F7',
  groupedBackground: '#F8F6F5',
  card: '#FFFFFF',
  reading: '#FAF8F7',
  label: '#191816',
  secondaryLabel: '#6A6965',
  tertiaryLabel: '#A3A19D',
  placeholder: '#A3A19D',
  separator: '#E5E2E0',
  accent: '#764BE5',
  onAccent: '#FAFAFB',
  accentSoft: '#F1EFFF',
  accentBorder: '#C9C2FC',
  accentPressed: '#6731D6',
  destructive: '#E7000B',
  success: '#34C759',
  warning: '#B25E00',
  field: '#F4F4F4',
  inset: '#F4F4F4',
  userBubble: '#EEE5FE',
  userBubbleForeground: '#22192E',
  overlay: '#00000066',
};

/**
 * 深色。桌面端 `.dark` 块。
 *
 * `background` 是 `oklch(0.12212 0 0)`（近黑）而不是纯黑——桌面端深色不是纯黑，
 * 卡片 `#181818` 浮在它上面。
 */
const dark: Palette = {
  background: '#060606',
  groupedBackground: '#060606',
  card: '#181818',
  reading: '#060606',
  label: '#DEDEDE',
  secondaryLabel: '#9E9E9E',
  tertiaryLabel: '#6B6B6B',
  placeholder: '#6B6B6B',
  separator: '#FFFFFF14',
  accent: '#A490FF',
  // 见文件头第 1 条偏离：深墨压浅品牌色 = 6.77:1，与桌面端深色 CTA 同一套逻辑。
  onAccent: '#191816',
  accentSoft: '#2E274E73',
  accentBorder: '#A490FF59',
  accentPressed: '#B7A5FF',
  destructive: '#FF6467',
  success: '#30D158',
  warning: '#FF9F0A',
  field: '#242424',
  inset: '#242424',
  userBubble: '#532D8D',
  userBubbleForeground: '#FFFFFF',
  overlay: '#00000099',
};

/**
 * 真黑模式：用户显式选择时背景用纯黑。
 *
 * 这是我们自己加的一档（桌面端没有——浏览器不需要为 OLED 省电）。桌面端深色本来
 * 就够暗（`#060606`），所以这一档只把卡片再压暗一点，让"纯黑"这个选项名副其实。
 */
const oled: Palette = {
  ...dark,
  background: '#000000',
  groupedBackground: '#000000',
  reading: '#000000',
  card: '#131313',
};

export function paletteFor(mode: AppearanceMode, systemScheme: SystemScheme): Palette {
  if (mode === 'oled') return oled;
  return resolvedScheme(mode, systemScheme) === 'dark' ? dark : light;
}

/** 解析后的实际明暗，用于状态栏和原生控件。 */
export function resolvedScheme(mode: AppearanceMode, systemScheme: SystemScheme): 'light' | 'dark' {
  if (mode === 'system') return systemScheme === 'dark' ? 'dark' : 'light';
  if (mode === 'light') return 'light';
  return 'dark';
}

/**
 * 间距刻度。**只有这六档**。
 *
 * 看到需要 6、10、14、18 这类中间值时，通常说明该用另一档，而不是该加一档。
 * 加档会让间距体系失去约束，最后每个页面各有一套间距——那正是"不像一个 App"的来源。
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  /** 分区间距。 */
  xl: 20,
  /** 空态与大间距。 */
  xxl: 24,
} as const;

/** 分组列表的外边距（iOS `insetGrouped` 的系统值）。 */
export const GROUP_INSET = 16;

/**
 * 圆角。全部配 `borderCurve: 'continuous'`（见 `radiusStyle`）。
 *
 * 基准对齐桌面端的 `--radius`（0.625rem = 10px），并按 iOS 的观感放大——同样半径下，
 * iOS 的连续圆角比 Web 的普通圆角更饱满。
 */
export const radius = {
  sm: 6,
  /** 附件、代码块等内嵌元素。 */
  md: 12,
  /** 面板、分组行（成组时首尾各圆一半）。 */
  lg: 18,
  /** 用户气泡。 */
  bubble: 19,
  /** 大卡片、分组容器。 */
  card: 26,
  /** 胶囊。 */
  pill: 999,
} as const;

/**
 * 连续圆角。RN 的 `borderRadius` 默认是普通圆角（CornerCurve = circular），
 * iOS 原生控件用的是连续圆角。这两个在同样半径下**观感不同**——连续圆角更饱满，
 * 是"原生感"的一部分。所有圆角都应该走这个 helper。
 */
export function radiusStyle(value: number) {
  return { borderRadius: value, borderCurve: 'continuous' as const };
}

/**
 * 排版角色。
 *
 * 六个核心角色：
 *   title    22/28 700  分区标题、页面标题
 *   body     17/25 400  正文、列表主标题、输入框
 *   secondary 15/21 400 副标题、说明
 *   meta     13/18 400  时间、状态、脚注
 *   eyebrow  11/14 600  全大写小标签
 *   mono     13/20 mono 路径、命令、ID、代码（**只有这四类**）
 *
 * 另有三个在 iOS 体系里必要的补充：`largeTitle`（品牌标题）、`headline`
 * （行主标题需要强调时）、`caption`（12pt，介于 meta 与 eyebrow）。
 */
export const typography = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' as const, letterSpacing: 0.37 },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, letterSpacing: 0.36 },
  /** `title` 角色：分区标题、页面标题。 */
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: 0.35 },
  title3: { fontSize: 20, lineHeight: 26, fontWeight: '600' as const, letterSpacing: 0.38 },
  /** 行主标题需要强调时。 */
  headline: { fontSize: 17, lineHeight: 25, fontWeight: '600' as const, letterSpacing: -0.41 },
  /** `body` 角色：正文。 */
  body: { fontSize: 17, lineHeight: 25, fontWeight: '400' as const, letterSpacing: -0.41 },
  callout: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const, letterSpacing: -0.32 },
  /** `secondary` 角色：副标题、说明。 */
  subhead: { fontSize: 15, lineHeight: 21, fontWeight: '400' as const, letterSpacing: -0.24 },
  /** `meta` 角色：时间、状态、脚注。 */
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const, letterSpacing: -0.08 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const, letterSpacing: 0 },
  /** `eyebrow` 角色：全大写小标签。配 `textTransform: 'uppercase'` 用。 */
  caption2: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 0.88 },
  /** `mono` 角色：路径、命令、ID、代码。只有这四类该用它。 */
  mono: { fontSize: 13, lineHeight: 20, fontWeight: '400' as const, fontFamily: 'Menlo' },
} as const;

/** 触控目标下限。低于这个值就是错的。 */
export const MIN_TOUCH_TARGET = 44;

/**
 按压反馈的**两档**透明度。

 视觉评审（`docs/research/review-visual-design.md` §2 第 3 行）实测全 App 有 **6 种**
 按压透明度：0.5×6、0.55×2、0.6×8、0.8×1、0.85×6、0.9×1——**对话页一屏里就占了 3 种**
 （头部动作 0.5 / 标题可点 0.6 / 发送 0.8）。同屏两种观感不是"细节"，是用户会直接报上来的
 那种不一致。收敛成两档，判据是**行内 vs 成块**：

 - `control`（0.6）：**行内小控件**——图标、文字链、徽章、面包屑、顶栏动作、队列/待发条上的
   动作、切换器与可点标题。它们本来就小，压到 0.6 也只是"淡了一下"；
 - `button`（0.85）：**独立成块的按钮**——发送键、批准/取消那一行、登录提交、表单确认、
   选项卡。它们占的面积大、颜色实，压到 0.6 会显得整块在闪。

 为什么不是"有底 / 无底"：批准页那一行里"取消"没有底、"确认"有底，但它们是**同一排按钮**，
 压感必须一样——按"行内 vs 成块"分才对得上这个例子。

 列表行与大块走的是**另一套**合法做法：`backgroundColor: pressed ? palette.field` 换底
 （全 App 30 多处），不在本 token 的范围里。

 这条规则由 `scripts/check-press-opacity.mjs` 在 `pnpm check` 里强制：新写的 `Pressable`
 随手写一个 0.7 会直接红。**改这两个值要连着改那个脚本**——那正是"两档"这件事不能被
 悄悄改成三档的保证。
 */
export const PRESS_OPACITY = {
  control: 0.6,
  button: 0.85,
} as const;

/**
 悬浮 tab 栏让开的高度。

 iOS 26 的 tab 栏**浮在内容之上**，tab 根屏幕的滚动内容自己不留这一段就会被压住
 （最大辅助字号下实测到计数脚注、Debug 分组被遮）。这个数字原来在三个屏里各抄了一份，
 第四个屏（设置）抄漏了，于是设置页底部的 Debug 分组半截压在 tab 栏下——收成一份，
 抄漏这件事就不会再发生。
 */
export const TAB_BAR_CLEARANCE = 72;

/**
 辅助字号的"门槛"（`fontScale`）。

 iOS 的动态字号里，非辅助档最高是 `xxxLarge` ≈ 1.35，**辅助档最低是 AX M ≈ 1.65**，
 中间是空的——所以 1.5 是一条没有歧义的分界线（不是"差不多大"，而是"这一档和下一档
 之间隔着一个断档"）。

 为什么要分档：这两档下**大标题与右侧附件的关系**不一样。默认档下它们并排、标题单行
 截断是对的（省下一行的高度，而同屏底部 tab 上还有同一个词）；辅助档下大标题约 87pt，
 `Sessions` 一个单词就宽过屏宽——再让它和附件抢同一行，结果就是标题只剩 `Se…`，
 或者被从单词中间硬拆成 `Sessio` / `ns`（2026-09-17 实测，五个主页全中）。

 **收成一份**：「会话」tab 的外壳与设置页各要一次，抄两份就会有一天只改了一处。
 */
export const ACCESSIBILITY_FONT_SCALE = 1.5;

/** 分组列表的行内边距。 */
export const ROW_PADDING = {
  top: 10,
  bottom: 10,
  leading: GROUP_INSET,
  trailing: GROUP_INSET,
} as const;
export const ROW_MIN_HEIGHT = 44;
/** 有图标时，分隔线应该从文字起点开始缩进。 */
export const ROW_SEPARATOR_INSET = 48;
