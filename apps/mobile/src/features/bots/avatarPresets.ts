/**
 * 内置头像：不打字也能换头像的那一套，以及**它怎么落库**。
 *
 * ## 为什么要有这个文件
 *
 * 改前 bot 设置页只有一行 `Avatar URL`（纯手输、占位符 `https://…`）：想换个头像，用户得
 * **先自己拥有一个图片地址**。那是把我们的实现细节（"头像是一个 URL"）当成用户的前提——
 * 一个成熟的应用不会这么选：Mail / Messages / Reminders 换头像时给的是**可挑的一组**，
 * 打字只是最后那个"我另有图"的出口。
 *
 * 所以这一版：**挑是主路径、打字是次路径**（`ui/AvatarPickerPage.tsx` 是主路径，
 * 自定义网址收进同一个 sheet 的次要分组里）。网址这条路**没有删**——自托管用户接自己的桶
 * 是真实需求，能力保留，只是不再当门口那一步。
 *
 * ## 落库形态：`avatar_url` 里存一条我们自己的标识
 *
 * 服务端就只有 `avatar_url` 这一个字段（`internal/bots/types.go` 的
 * `AvatarURL string \`json:"avatar_url,omitempty"\``，读完 `strings.TrimSpace` 直接进库，
 * **不做 URL 校验**、不新增端点），所以"挑一个内置头像"这件事必须表达成一个字符串。
 * 两种落法：
 *
 * | 落法 | 服务端/别的客户端看到 | 我们这边 |
 * | --- | --- | --- |
 * | **存托管在公网的图片 URL** | 真图片，各处都能画 | 得先有地方托管（本仓库没有静态站），而且要联网才画得出来 |
 * | **存一条标识 `memoh:avatar/<slug>`**（本版选的） | 一个认不出的字符串 | 完全离线、随 App 走、一个字节都不多 |
 *
 * ### 存标识的好处
 *
 * 1. **不加依赖、不动服务端**：没有新端点、没有新字段、没有新包；写进去的就是那个字段。
 * 2. **离线与自托管都对**：图标在 App 包里，飞机上/内网部署里都画得出来；托管 URL 那套
 *    在自托管场景下反而要求用户能连到我们的 CDN。
 * 3. **值极小**：`memoh:avatar/sparkles` 一共 20 个字符，进库、进日志、进差分发出去的
 *    都是一个短串；托管 URL 或 data URI 都会把这个字段撑大几十上百倍。
 * 4. **可控**：只有这张表里的 slug 才写得进去（`builtinAvatarToken` 的入参就是表里的项），
 *    不存在"用户手输一个我们画不出来的值"。
 *
 * ### 代价（明说）
 *
 * 1. **别的客户端不认识它**。桌面端（`apps/web/.../bot-switcher.vue`）是
 *    `<img :src="bot.avatar_url">` + 加载失败的 initials 兜底：认不出这个 scheme，
 *    它会**退成首字母**——不是崩，但那台设备上看到的不是同一个头像。
 * 2. **它不是一个地址**。谁在别处把这个值当 URL 用（拼接、`URL` 解析）都拿不到东西。
 *    所以前缀写成 `memoh:`——**一眼看得出不是 http(s)**，而不是伪装成一个路径。
 * 3. **以后要换成托管 URL 时得迁移**：这张表是 slug → 画法的唯一映射，换的时候在
 *    `decode` 那一层做一次升级（老值仍能翻译成新值）即可，但确实要做一次。
 *
 * 判据是"**用户能不能不打字换头像**"与"**服务端形状是否照旧**"，上面这几条都过了，
 * 所以才敢这么存；理由与代价同时记在 `docs/research/settings-tradeoffs-memoh.md` §8。
 *
 * ## 为什么不用厂商 mark（`assets/images/providers/**`）
 *
 * 那 48 张是**厂商商标**，用在模型选择器里表示"这组模型来自谁"是它的本意；拿来当某个
 * agent 的头像会读成"这个 agent 是 OpenAI 的"——那是另一个意思，而且商标不该由用户
 * 随意挑。头像要的是**辨识度**，不是品牌归属，所以这一版用 SF Symbols（系统图标，
 * 与仓库里其它图标同一种画法、跟着主题色走）。
 *
 * ## 判断与画法分家
 *
 * 这张表（纯数据 + 几个纯函数）在 `features`，所以 `node --test` 能直接测；画的部分在
 * `ui/BotAvatar.tsx`。`avatarFor` 只回一个 `{kind:'builtin', slug}`——**判断不认识 SF Symbol，
 * 画法不认识 token**，两边各自能单独改。
 */
import type { SymbolViewProps } from 'expo-symbols';

/**
 * 标识前缀。
 *
 * 刻意**不是** `http(s)://`：它不是一个地址，伪装成地址只会让下一个把它当 URL 用的人
 * 拿到一个静默的错误。`memoh:` 这个 scheme 由我们独占，不会和用户的真实图片地址撞车。
 */
export const BUILTIN_AVATAR_PREFIX = 'memoh:avatar/';

/**
 图标名用的就是 `SymbolView` 自己的那套类型（而不是 `string`）。

 两个好处：① 画的时候不用 cast；② **写错一个符号名在 `pnpm typecheck` 就红**——不然那是一枚
 只有真机上才看得见的空白方块。代价是这张表依赖 `expo-symbols` 的**类型**（`import type`，
 运行时不留痕），可以接受：这个表本来就是给 `ui/BotAvatar.tsx` 用的。
 */
type SymbolName = SymbolViewProps['name'];

export interface BuiltinAvatar {
  /** token 里那一段，也是稳定的存储值（**改了就是数据迁移**）。 */
  readonly slug: string;
  /** SF Symbol 名。 */
  readonly symbol: SymbolName;
  /** 显示名（选择器里的读屏标签、设置页那一行的值）。 */
  readonly nameKey: string;
}

/**
 * 可挑的这一组。
 *
 * 挑法：**形状彼此差别大**（尖的 / 圆的 / 有角的），因为头像在列表里只有 28pt 高，
 * 都是"某个几何图形"就分不出来了；动物的爪印、鸟、乌龟是全仓库其它地方没有的剪影，
 * 天体与物件（星光、月夜、闪电、叶子、火焰、方块）互相也不会看混。
 *
 * `nameKey` 都必须在 `locales/{en,zh-Hans}.json` 里有值，所以增删一项必须连文案一起改。
 */
export const BUILTIN_AVATARS: readonly BuiltinAvatar[] = [
  { slug: 'sparkles', symbol: 'sparkles', nameKey: 'avatar.preset.sparkles' },
  { slug: 'bolt', symbol: 'bolt.fill', nameKey: 'avatar.preset.bolt' },
  { slug: 'moon', symbol: 'moon.stars.fill', nameKey: 'avatar.preset.moon' },
  { slug: 'leaf', symbol: 'leaf.fill', nameKey: 'avatar.preset.leaf' },
  { slug: 'flame', symbol: 'flame.fill', nameKey: 'avatar.preset.flame' },
  { slug: 'paw', symbol: 'pawprint.fill', nameKey: 'avatar.preset.paw' },
  { slug: 'bird', symbol: 'bird.fill', nameKey: 'avatar.preset.bird' },
  { slug: 'tortoise', symbol: 'tortoise.fill', nameKey: 'avatar.preset.tortoise' },
  { slug: 'brain', symbol: 'brain.head.profile', nameKey: 'avatar.preset.brain' },
  { slug: 'cube', symbol: 'cube.fill', nameKey: 'avatar.preset.cube' },
];

/** slug → 这一项；不认识的 slug 回 `undefined`（画不出来就不画，不抛）。 */
export function builtinAvatarBySlug(slug: string): BuiltinAvatar | undefined {
  return BUILTIN_AVATARS.find((preset) => preset.slug === slug);
}

/**
 * 要写进 `avatar_url` 的值。
 *
 * 入参**只能是表里的 slug**（类型就是 `BuiltinAvatar`）：这样"服务端里出现一个我们画不
 * 出来的值"这件事从接口上就不可能。与 `avatarFor` 的宽容（认不出就回退）合起来，
 * 两头都堵住。
 */
export function builtinAvatarToken(preset: BuiltinAvatar): string {
  return `${BUILTIN_AVATAR_PREFIX}${preset.slug}`;
}

/**
 * 这个字符串是不是我们自己的标识；是就把 slug 取出来。
 *
 * 只看前缀，**不看 slug 认不认识**（那是 `builtinAvatarBySlug` 的事）：两件事分开，
 * "前缀对但我们没这一项"（老版本存的值、被手改过的值）才能落到一个明确的分支。
 *
 * 收 `unknown` 并且不做 trim：调用方（`avatarFor`）已经把"是不是非空字符串"判完了，
 * 这里再判一次只会让两处判据有机会不一致。
 */
export function builtinAvatarSlugOf(value: string): string | null {
  if (!value.startsWith(BUILTIN_AVATAR_PREFIX)) return null;
  const slug = value.slice(BUILTIN_AVATAR_PREFIX.length);
  return slug === '' ? null : slug;
}

/**
 * 这个字符串能不能**原样**当我们的标识用（前缀对 + 表里有）。
 * 界面上"当前选的是不是内置头像"这类判断用它。
 */
export function isBuiltinAvatar(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const slug = builtinAvatarSlugOf(value);
  return slug !== null && builtinAvatarBySlug(slug) !== undefined;
}
