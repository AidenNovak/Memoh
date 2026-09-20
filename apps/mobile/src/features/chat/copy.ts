/**
 * 这一屏的**文案推导**。
 *
 * 四处都是"从状态翻出一句话"，过去写在 `ChatScreen` 的函数体里。搬出来的理由是同一个：
 * 它们**错了也没人看得见**——读屏用户听不到播报、胶囊悄悄退回"默认"、失败原因被吞掉，
 * 都不会报错、不会崩，只能靠断言钉住。
 *
 * | 函数                | 翻的是什么                                            |
 * | ------------------- | ----------------------------------------------------- |
 * | `runFailureNotice`  | run 失败那一块：视觉两行 + 读屏那一句（同一个来源）   |
 * | `headerSubtitle`    | 表头副标题：谁在说话 · 现在在干什么                   |
 * | `modelPillLabel`    | 模型胶囊上写什么（三级兜底，每级都说实话）            |
 * | `userTextOfTurn`    | 某一轮里用户说的那句话（错误块的"再来一次"要重发的）  |
 */
import type { ComposerChoice, ModelSection } from './models.ts';
import { effortLabelKey, modelNameFor } from './models.ts';
import type { RenderTurn } from '../../models/chat.ts';
import type { RunStatus } from '../../api/protocol.ts';

/** 只用到"查表"这一件事，所以收得比 `useT` 的返回类型窄——纯函数不该依赖 hook。 */
export type Translate = (key: string) => string;

/** 这个 key 在我们自己的文案表里有没有。 */
export type HasKey = (key: string) => boolean;

export interface RunFailureNotice {
  /** 读屏念的那**一句**（视觉上是两行两句，R30/R48：读到什么 = 看到什么）。 */
  label: string;
  /** 屏幕上第二行的原因；`null` = 没有可说的原因（不编一句）。 */
  reason: string | null;
}

/**
 * run 失败那一块该怎么说。`null` = 这一轮没失败，界面不该出现这一块。
 *
 * `runError` 有两种来源：reducer 给的是我们自己的 i18n key（`error.runAbandoned`），
 * 协议里带的则可能是服务端**已经写好的句子**（那是给人看的，原样转达才诚实）。
 * 用 `hasTranslation` 查表分辨，不依赖 `startsWith('error.')` 那种命名约定（R23/R24）。
 *
 * 视觉与读屏**共用这一个来源**：分两处算就会出现"看到的和听到的不一样"。
 *
 * `hasKey` 是**注入**的（而不是 `import { hasTranslation }`）：`lib/i18n/index.ts` 顶部
 * 就 `getLocales()` + 两个 JSON import，纯逻辑测试（`node --test`）加载不了它。
 * 调用方给的是 `lib/i18n` 的 `hasTranslation`，语义不变。
 *
 * ⚠️ 分隔符不能用半角句点：原因那句可能是服务端原文（自带标点不可控），中文句子里拼出
 * 「这一轮提前停了. 这个 run …」这种半角句点加空格。用 `·`——`ui/PendingApprovals.tsx`
 * 的读屏标签也是这么拼的。
 */
export function runFailureNotice(
  input: { runStatus: RunStatus | null; runError: string | null },
  t: Translate,
  hasKey: HasKey,
): RunFailureNotice | null {
  if (input.runStatus !== 'errored') return null;
  const reason = reasonOf(input.runError, t, hasKey);
  const label = reason === null ? t('chat.run.failed') : `${t('chat.run.failed')} · ${reason}`;
  return { label, reason };
}

/**
 * `runError` → 屏幕上那一句原因。
 *
 * 两种来源：reducer 给的是我们自己的 i18n key，协议里带的可能是服务端**已经写好的句子**。
 * 用 `hasKey` 查表分辨（见 `runFailureNotice`）。
 */
export function reasonOf(raw: string | null, t: Translate, hasKey: HasKey): string | null {
  if (raw === null || raw === '') return null;
  if (hasKey(raw)) return t(raw);
  return raw;
}

/**
 * 表头副标题：谁在说话 · 现在在干什么。
 *
 * 把"正在生成"放在这里，而不是在内容区挂一个悬浮胶囊——导航栏的副标题是系统里
 * 传达这类状态的既有位置。两段都可能为空（没选 bot / 既不在跑也不 stale），
 * 空的那一段不出现（否则会拼出一个孤零零的 `·`）。
 *
 * 不写嵌套三元（AGENTS.md 明确禁止）：可读性差且容易读反。
 */
export function headerSubtitle(
  input: {
    bot: { name: string; display_name: string } | null;
    running: boolean;
    stale: boolean;
  },
  t: Translate,
): string {
  let who = '';
  if (input.bot !== null) {
    who = input.bot.display_name !== '' ? input.bot.display_name : input.bot.name;
  }
  let what = '';
  if (input.running) what = t('chat.thinking');
  else if (input.stale) what = t('chat.gap');
  return [who, what].filter((part) => part !== '').join(' · ');
}

/**
 * 胶囊上写什么。
 *
 * 三级兜底，每一级都说实话：
 * 1. 选过的模型 + 目录里有它 → 它的**名字**（`Kimi K3`）；
 * 2. 选过但目录还没到/没有它 → **原样显示 `modelId`**（不撒谎说"默认"，用户明明选过）；
 * 3. 没选过 → "默认"（服务端决定用哪个）。
 */
export function modelPillLabel(
  catalog: ModelSection[] | null,
  choice: ComposerChoice,
  t: Translate,
): string {
  if (choice.modelId === null) return t('chat.model.default');
  const name = modelNameFor(catalog, choice.modelId) ?? choice.modelId;
  if (choice.reasoningEffort === null) return name;
  // 强度也是"这一轮会发出去的东西"，所以它跟模型名一起写在胶囊上——否则用户得点开
  // 才知道自己上一轮到底是用哪个档位问的。
  const key = effortLabelKey(choice.reasoningEffort);
  return `${name} · ${key === null ? choice.reasoningEffort : t(key)}`;
}

/**
 * 某一轮里用户说了什么（错误块里的"再来一次"要重发的就是这一句）。
 *
 * 只取 `text` 块：用户输入里的附件、技能请求都随正文重建，不从协议里反推。
 * 找不到那一轮（历史被换掉、渲染被截断）返回空串——**宁可什么都不发**，
 * 也不发一条我们编出来的消息。
 */
export function userTextOfTurn(turns: readonly RenderTurn[], turnKey: string): string {
  const turn = turns.find((candidate) => candidate.key === turnKey);
  if (turn?.user === undefined) return '';
  return turn.user.blocks
    .filter((block) => block.kind === 'text')
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}
