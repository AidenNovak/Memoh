/**
 * 头像计划（RN → 原生）的**唯一**组装处。
 *
 * ## 为什么要有这个文件
 *
 * 原生那边只有一个解码形状（`ios/Support/MemohAvatarPlan.swift`：`kind / symbol / uri /
 * connectionOpen`），而需要下发的界面有好几处：设置页的 agent 卡片、bot 设置页的页头、
 * 会话页的 agent 行与菜单、切 agent 选择器、头像选择器。以前这一段判断在
 * `screens/SettingsScreen.tsx` 与 `screens/NativeBotSettingsScreen.tsx` 里各写了一份
 * （两份**逐行相同**，只是一份收 `Bot`、一份收 `string`）——再往选择器上补三处，就是
 * 五份拷贝，改一处忘一处的结果是"同一个 bot 在不同页面上头像长得不一样"。
 *
 * ## 判据全在 `avatarFor`
 *
 * 这个函数**不自己判**"有没有头像"：`features/bots/avatar.ts` 已经把三种"没有头像"的
 * 形状（整个 key 缺失 / `null` / 不是字符串）以及 `memoh:avatar/<slug>` 这类内部标识
 * 归一化过了。这里只做一件原生做不了的事——**把 slug 翻成 SF Symbol 名**
 * （`avatarPresets` 那张表在 RN，原生不复制它）：认不出的 slug 落回吉祥物，与
 * `avatarFor` 的兜底同一条路。
 *
 * ## `connectionOpen` 为什么必须带下去
 *
 * 只有 `remote` 用得上它：原生远程头像加载失败后**最多重试一次**，而"什么时候算可以
 * 重试"由 RN 的连接状态决定（`avatarRetryOnConnection` 那一套判据）。`mark` / `builtin`
 * 是本地画的，这个值不影响它们——但仍然照契约填满，原生不去猜哪个字段该忽略。
 */
import { symbolName, type NativeSettingsAvatar } from '@memoh-ios/kit';

import { avatarFor } from './avatar.ts';
import { builtinAvatarBySlug } from './avatarPresets.ts';

/**
 * `avatarUrl`（bot 的 `avatar_url`，空串 = 没设）→ 原生要画的东西。
 *
 * 收**字符串**而不是 `Bot`：调用方手里有时只有一个草稿值（bot 设置页的 `draft.avatarUrl`、
 * 新建 bot 的表单），形状与 `avatarFor` 的 `BotAvatarSource` 不同，硬凑成一个假 bot 对象
 * 只会让"这个字段到底谁填"更难说清。
 */
export function nativeAvatarPlan(avatarUrl: string, connectionOpen: boolean): NativeSettingsAvatar {
  const plan = avatarFor({ avatar_url: avatarUrl });
  if (plan.kind === 'remote') return { kind: 'remote', uri: plan.uri, connectionOpen };
  if (plan.kind === 'builtin') {
    const preset = builtinAvatarBySlug(plan.slug);
    if (preset !== undefined) {
      return { kind: 'builtin', symbol: symbolName(preset.symbol), connectionOpen };
    }
  }
  // 兜底：吉祥物（`mark`）。内置 slug 认不出、值不是网址、值本来就是空——三条路都到这里。
  return { kind: 'mark', connectionOpen };
}
