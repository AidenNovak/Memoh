/**
 * 会话行的副标题规则（"来源 · 类型"），纯函数。
 *
 * ## 为什么值得一个纯函数 + 测试
 *
 * 这段逻辑原来内联在 store 的取数里：
 *
 * ```ts
 * source: [item.channel_type, item.type].filter((part) => part !== '').join(' · ')
 * ```
 *
 * 类型声明把 `channel_type` 写成必有的 `string`，TypeScript 于是认为它永远存在；
 * 但**这台部署服务端一个会话都不返回该字段**（实测 41/41 缺失）。`undefined !== ''`
 * 为真，所以它被保留，`join` 把 undefined 当空串——会话行的副标题变成
 * `" · chat"`：开头一个空段、一个多余的分隔符。
 *
 * 这类 bug 单看代码是对的（类型没撒谎，逻辑也没写错），只有对着真实服务端看
 * 渲染结果才会发现。所以规则独立出来、用测试钉住"缺字段时不能留空段"。
 */
import type { SessionSummary } from './store.tsx';

/**
 * 组装副标题的各个部分：**只保留确实有内容的**。
 *
 * 不假设任何字段一定存在——服务端给不给是它的事，界面的责任是"给了就显示、
 * 没给就不显示"，而不是渲染出一个空段。
 */
export function sessionSourceParts(session: { channelType?: string; type?: string }): string[] {
  return [session.channelType, session.type].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
}

/**
 * 副标题文案，**服务端形状的入口**（`Session` 的 snake_case 字段）。
 *
 * 存在的理由：会话副标题在仓库里有三处落点——会话列表、给当前会话补标题
 * （`store.tsx` 的 `ensureSessionInList`）、运行目标选择器的行。第二处曾经自己
 * 又写了一遍 `[channel_type, type].filter((part) => part !== '').join(' · ')`，
 * 于是" · chat"那个 bug 又长了一遍（`undefined !== ''` 为真）。现在三处都调这一个
 * 函数，规则只有一份。
 */
export function sessionSourceFromApi(session: { channel_type?: string; type?: string }): string {
  return sessionSourceParts({ channelType: session.channel_type, type: session.type }).join(' · ');
}

/**
 * 副标题文案。没有可显示的部分就返回空串——调用方据此**整行不渲染**，
 * 而不是渲染一个空的 Text（那会白占一行高度）。
 */
export function sessionSourceLabel(session: Pick<SessionSummary, 'source'>): string {
  return session.source.trim();
}
