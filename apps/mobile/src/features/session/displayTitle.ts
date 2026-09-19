/**
 * 会话标题的显示规则。
 *
 * ## 为什么需要它
 *
 * 服务端允许会话没有标题（新建的、从 IM 频道来的）。之前各处用
 * `session.id.slice(0, 8)` 兜底，于是界面上出现 `fixture-a3f2` 这种 id 片段——
 * 对用户毫无意义，而且一眼看出是没做完的东西。固定数据截图把它暴露了出来。
 *
 * 现在：空标题 → 显示"未命名会话"（走 i18n）。
 *
 * ## 为什么放在渲染层而不是 store
 *
 * 语言可以运行时切换。如果把本地化字符串固化进 store，切完语言列表不会更新，
 * 而且不同语言的截图上会出现同一个语言的地名。数据保持原样、显示时翻译，
 * 是唯一不会出错的分工。
 */
import type { SessionSummary } from './store.tsx';

/**
 * 取会话的显示标题。
 *
 * `t` 传进来而不是在这里 import i18n：这样它是纯函数，可以在没有 React 的地方
 * 测试与复用（也避免这个模块反向依赖 i18n 的初始化顺序）。
 *
 * 参数类型写成 `{ title?: string | null }` 而不是 `Pick<SessionSummary, 'title'>`：
 * 这个函数是**服务端形状的兜底口**，而类型声明说了不算——`SessionSummary.title` 写的是
 * `string`，真实响应里却可能是缺字段或 `null`（固定服务端的 `sessions-sparse` 一档
 * 就是这两种形状；缺字段那条在这台部署上是实测的：`channel_type` 41/41 缺失）。
 * 直接 `.trim()` 的后果不是少一行字，而是**整屏崩**——一个坏字段不该让会话列表消失。
 */
export function sessionDisplayTitle(
  session: { title?: string | null } | null | undefined,
  t: (key: string) => string,
): string {
  const title = (session?.title ?? '').trim();
  return title === '' ? t('home.untitled') : title;
}
