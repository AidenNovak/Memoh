/**
 * 斜杠命令：composer 里的 `/` 菜单。
 *
 * ## 桌面端是怎么做的（照着分三类，不照抄实现）
 *
 * 桌面端的菜单项**由客户端拼**，执行分三种：
 *
 * | 类型 | 例子 | 谁执行 |
 * | --- | --- | --- |
 * | 服务端快捷动作 | `/help`、`/skill list`、`/permission` | `POST /bots/{id}/quick-actions/execute` |
 * | 纯客户端动作 | `/new`、`/model`、`/compact` | 客户端自己（`/compact` 另打一个 REST） |
 * | 技能 | `/<skill-name> [prompt]` | 当**普通消息**发出去，服务端从文本里解析（`internal/slash`） |
 *
 * ## 这一版只做能验证的那两段
 *
 * - **技能**：清单来自 `GET /bots/{bot_id}/skills/catalog`（实测有这条端点，形状是
 *   `{skills: [{name, display_name, description, source_kind, state}]}`）。发送时文本原样
 *   带上，并附 `requested_skills`（协议里本就有这个字段，桌面端也带）。
 * - **客户端动作**：`/new`、`/model`——它们真的只是本地动作，服务端不认识这两个词。
 * - **服务端快捷动作暂时不做**：`/help` 与 `/skill list` 要 `POST /quick-actions/execute`，
 *   而那个请求体（typed quick action）的形状我没有实测过。**宁可先不给**，也不做一个
 *   "点了必然报错"的菜单项——那比没有更坏。
 *
 * ## 一条纪律：不认识的 `/xxx` 按普通文本发
 *
 * 服务端对不认识的斜杠有明确的错误码（`unknown_slash` / `unsupported_command`）。
 * 所以这里只把**命中技能清单**的 `/name` 当成技能，其余照普通文本发——客户端不替服务端
 * 发明命令。
 */
import type { SkillSummary } from '../../api/types.ts';

/** 菜单里的一项。 */
export interface SlashItem {
  kind: 'builtin' | 'skill';
  /** 插入/执行用的名字（不含 `/`）。 */
  name: string;
  /** 主文案（含 `/`）。 */
  label: string;
  /**
   * 副文案。
   *
   * 内置动作给的是 **i18n key**（它要翻译），技能给的是服务端的 description **原文**
   * （技能名与说明是用户自己写进容器的，翻译它只会让用户找不到自己那个技能）。
   */
  description: string;
  descriptionIsKey: boolean;
}

/** 纯客户端动作（与桌面端同一组里我们真能执行的两个）。 */
export const SLASH_BUILTIN_NAMES = ['new', 'model'] as const;
export type SlashBuiltinName = (typeof SLASH_BUILTIN_NAMES)[number];

const BUILTIN_HINT_KEY: Record<SlashBuiltinName, string> = {
  new: 'chat.slash.new.hint',
  model: 'chat.slash.model.hint',
};

/**
 草稿是不是"正在打一个斜杠命令"。

 只有**开头是 `/` 且还没打空格**时才算：一旦有了空格，用户已经在写参数，这时弹菜单会把
 参数盖住（桌面端也是"输入 `/` 出菜单、选中后才补上空格"）。
 */
export function slashQuery(draft: string): string | null {
  const text = draft.trimStart();
  if (!text.startsWith('/')) return null;
  if (text.includes(' ') || text.includes('\n')) return null;
  return text.slice(1).toLowerCase();
}

/**
 菜单内容：内置动作 + 技能。

 `translate` 只用来把内置动作的说明翻出来参与匹配（菜单要能按说明搜到）。
 */
export function slashItems(
  query: string | null,
  skills: SkillSummary[],
  translate: (key: string) => string = (key) => key,
): SlashItem[] {
  const builtins: SlashItem[] = SLASH_BUILTIN_NAMES.map((name) => ({
    kind: 'builtin',
    name,
    label: `/${name}`,
    description: BUILTIN_HINT_KEY[name],
    descriptionIsKey: true,
  }));
  const skillItems: SlashItem[] = skills.map((skill) => ({
    kind: 'skill',
    name: skill.name,
    label: `/${skill.name}`,
    description: skill.description !== '' ? skill.description : (skill.display_name ?? ''),
    descriptionIsKey: false,
  }));
  const all = [...builtins, ...skillItems];
  if (query === null || query === '') return all;
  return all.filter((item) => {
    const hint = item.descriptionIsKey ? translate(item.description) : item.description;
    return item.name.toLowerCase().includes(query) || hint.toLowerCase().includes(query);
  });
}

/**
 发送时要把哪些技能告诉服务端。

 文本保持原样（`/name prompt`）——服务端自己的分类器就是从文本解析技能的
 （`internal/slash/classifier.go` 的 `DecisionSkillIntent`）。只有**首词命中技能清单**时
 才附上 `requested_skills`。
 */
export function requestedSkillsFor(draft: string, skills: SkillSummary[]): string[] {
  const text = draft.trim();
  if (!text.startsWith('/')) return [];
  const first = (text.split(/\s+/)[0] ?? '').slice(1).toLowerCase();
  if (first === '') return [];
  return skills.some((skill) => skill.name.toLowerCase() === first) ? [first] : [];
}

/** 点了某个技能之后草稿该变成什么（补一个空格，光标落在参数处）。 */
export function draftAfterSkill(name: string): string {
  return `/${name} `;
}
