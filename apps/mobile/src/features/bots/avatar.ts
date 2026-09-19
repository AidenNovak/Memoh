/**
 * bot 头像该画什么——纯判断。
 *
 * 放在 `features`（不是 UI 文件里）是为了**能直测**：`.tsx` 里的函数没法被
 * `node --test` import（没有 JSX 转换），而这条判断恰好有一个"写错了也不明显"的分岔：
 *
 * 1. bot 自带 `avatar_url` 且能加载 → 那张图；
 * 2. 没有 `avatar_url` → 默认那枚吉祥物；
 * 3. 有 `avatar_url` 但**加载失败** → 也是吉祥物；
 * 4. `avatar_url` 是**我们自己的内置头像标识**（`memoh:avatar/<slug>`）→ 本地画那一枚，
 *    不联网（见 `./avatarPresets.ts`：为什么这么存、好处与代价）。
 *
 * 第 3 条是这轮修的真 bug：以前"有 url 就画 url"，图挂了就是一个**空白灰方块**——用户看到的
 * 是"还没画完"，而不是"这个 bot 没有头像"。图挂了不是用户的错，界面也不该把它表现成半成品。
 *
 * ## "没有头像"不止一种形状（2026-09-16，dev 栈实测）
 *
 * 服务端 `internal/bots/types.go` 是 `AvatarURL string \`json:"avatar_url,omitempty"\``：
 * 值空时**整个 key 都不出现**。实测 `GET /bots`（vultr-sg 的 dev 栈）响应里每个 bot 都
 * **没有** `avatar_url` 这个 key。固定服务端一直给 `''`，于是"客户端把 undefined 当必然存在"
 * 这类 bug 在 fixture 上全绿、在真服务端上整屏红屏：
 * `bot.avatar_url.trim()` → `Cannot read property 'trim' of undefined`（会话列表）。
 *
 * 所以判据写成"**是不是非空字符串**"：`undefined` / `null` / 非字符串一律走兜底那条路。
 * 兜底放在这一层（而不是在各调用点塞 `?? ''`）：`BotAvatar` 有三处调用（agent 卡片、
 * 切换器、设置页的 agent 卡片），漏一处就是又一次红屏。
 */
import {
  BUILTIN_AVATAR_PREFIX,
  builtinAvatarBySlug,
  builtinAvatarSlugOf,
} from './avatarPresets.ts';

export type AvatarPlan =
  | { kind: 'mark' }
  /** 内置头像。`slug` **一定在这张表里**（认不出的 slug 落到 `mark`，见 `avatarFor`）。 */
  | { kind: 'builtin'; slug: string }
  | { kind: 'remote'; uri: string };

/**
 头像加载失败之后的**重试**判据（纯函数，能直测）。

 ## 为什么要重试一次

 改前 `onError` 一置就是**永久**：只有换 bot / 换 url 才重置。用户在电梯里打开过一次
 的 bot，头像就再也不会回来——图没坏，只是那一次网络没通。做法照 Element X 的
 `loadImageRetryingOnReconnection`：**等"可达"事件再试一次**，而不是无限重试。

 ## 为什么"同一次 open 只给一次"

 图真的坏了（404、桶里没这张图）时，无限重试就是一个死循环：每次失败都触发一次新的
 请求。所以"这一次 open 里给过了"要记下来，只有**连接真正重开**（断开→再 open）
 才重置。两条合起来的语义是"每次网络恢复最多重试一次"。

 断言在 `tests/settings-and-avatar.test.mjs`；`BotAvatar` 只负责把连接状态喂进来。
 */
export interface AvatarRetryState {
  /** 这一次加载是不是失败了（失败态才需要重试）。 */
  readonly failed: boolean;
  /** 这一次 open 里是不是已经给过重试了。 */
  readonly retriedOnOpen: boolean;
}

/**
 连接状态变了之后，失败态该怎么走。

 - 不在 `open`：把"这一次给过了"清掉（断开→再回来就是新的一次，还能再试一次）。
 - 在 `open` 且失败过且还没试过：清掉失败态 —— 于是那张图会被重新请求一次。
 - 其余：原样返回（**同一个对象**，调用方据此判断"什么都没变"）。

 `open` 之外的档（`idle` / `connecting` / `reconnecting` / `closed` / `unauthorized`）
 都算"网络没回来"。`unauthorized` 尤其不能当成恢复：凭据没了，重试一次也只是再失败一次。
 */
export function avatarRetryOnConnection(
  state: AvatarRetryState,
  connectionOpen: boolean,
): AvatarRetryState {
  if (!connectionOpen) {
    return state.retriedOnOpen ? { failed: state.failed, retriedOnOpen: false } : state;
  }
  if (!state.failed || state.retriedOnOpen) return state;
  return { failed: false, retriedOnOpen: true };
}

/**
 头像只看这一个字段，而且**它的形状不可信**：可以整个不存在（服务端 omitempty）、
 可以是 `null`、也可以是别的类型。所以这里收 `unknown`，由 `avatarFor` 自己判。

 不写成 `Pick<Bot, 'avatar_url'>`：`types.ts` 声明它是 `string`，而真服务端上那份声明和
 实际响应不一致——把这个谎带进函数体里正是这次红屏的成因，只有在这一层挡得住。
 */
export type BotAvatarSource = { avatar_url?: unknown };

/** 空串与纯空白都算"没有头像"（服务端给的是 `""`，但也别赌它一定 trim 过）。 */
export function avatarFor(bot: BotAvatarSource | null): AvatarPlan {
  if (bot === null) return { kind: 'mark' };
  const raw: unknown = bot.avatar_url;
  // 先判类型再 `.trim()`：`undefined` / `null` / 数字 / 对象都从这里落到吉祥物。
  if (typeof raw !== 'string') return { kind: 'mark' };
  const uri = raw.trim();
  if (uri === '') return { kind: 'mark' };
  const slug = builtinAvatarSlugOf(uri);
  /**
   在我们的命名空间里（前缀对）→ **绝不**当成远程图去请求。

   两种"前缀对但用不了"的值都在这里落回吉祥物：**只写了前缀没写 slug**、以及**项认不出**
   （更早的版本存的、被别处手改过）。以前者为例，把它交给 `<Image src="memoh:avatar/">` 只会
   发一次注定失败的请求，然后在 `onError` 之后退回吉祥物——同一个结果，多一次无谓的网络动作，
   而且中途那一帧是空白的。
   */
  if (uri.startsWith(BUILTIN_AVATAR_PREFIX)) {
    if (slug === null) return { kind: 'mark' };
    if (builtinAvatarBySlug(slug) === undefined) return { kind: 'mark' };
    return { kind: 'builtin', slug };
  }
  return { kind: 'remote', uri };
}

/**
 设置页那一行右边写什么（i18n key）。

 三种值要用**用户的话**说出来，不能把值本身摆上去：内置头像是 20 个字符的标识，自定义
 头像是一串长网址——直接显示都会把标签挤没（真机截图上 "Avata/r URL" 就是这么来的）。
 所以这一行只说"是哪种"，具体画在页面顶部那枚 44pt 的头像上。

 只有这三种（`AvatarPlan` 是封闭集合），用 `if` 而不是嵌套三元（`AGENTS.md`）。
 */
export function avatarValueKey(plan: AvatarPlan): string {
  if (plan.kind === 'mark') return 'avatar.default';
  if (plan.kind === 'builtin') {
    return builtinAvatarBySlug(plan.slug)?.nameKey ?? 'avatar.default';
  }
  return 'avatar.custom';
}

/**
 把服务端给的 `avatar_url` 归一化成**能当输入框的 value、能直接比较**的字符串。

 "没有头像"的三种形状（整个 key 缺失 / `null` / 不是字符串）在这里都变成 `''`。
 归一化不是为了显示（显示走 `avatarFor`），而是为了设置页的草稿：它的声明类型是
 `string`，拿 `undefined` 当 value 会让那个输入框变成非受控的；差分比较两边写法不统一
 还会凭空产生一个补丁。

 不 trim：用户正在输入的那个值要原样留着（`'  '` 到了判断那一层由 `avatarFor` 处理）。

 **内置头像标识（`memoh:avatar/<slug>`）在这里就是普通字符串**：归一化与差分（`patchFrom`）
 都不用认识它——选内置头像存进去的是一条短字符串，和存一个网址走的是同一条路。这也是
 选"存标识"而不是"存托管 URL"的一个好处：差分/归一化那套一行都不用动。
 */
export function normalizeAvatarUrl(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}
