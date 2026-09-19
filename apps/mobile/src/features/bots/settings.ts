/**
 * bot 设置页的纯逻辑：草稿、差分、以及"哪些能存"。
 *
 * ## 为什么要有"差分"这件事
 *
 * 服务端的设置接口是**指针语义**（`chat_model_id?: string`，nil = 保持、`""` = 清空）。
 * 一次把整份草稿都 POST 过去有两个真实后果：
 *
 * 1. 两个客户端（桌面端 + 手机）同时开着时，后点的那个会把**别人刚改的字段**覆盖回去；
 * 2. "我没动过的字段"也会被当成"用户要把它设成这个值"发出去，语义就不对了。
 *
 * 所以这里算出**只含改动字段**的补丁；一个字段都没改就返回空对象，调用方据此禁用保存。
 *
 * ## 模型为什么要分开校验
 *
 * `chat_model_id` 服务端接受**两种**写法（目录的 uuid 或 `model_id`，见
 * `settings/service.go` 的 `resolveModelUUID`）。我们发 `model_id`（如 `k3`）——
 * 它是人读得懂的那个，而且和 composer 上每消息带的值是同一套。但**模型被删掉之后**
 * 那个 id 就不再有效，所以保存前必须对着目录核一遍（`verifiedModelId`）。
 */
import type { Bot, BotSettings } from '../../api/types.ts';
import { DEFAULT_CHOICE, findModel, verifiedChoice, type ModelSection } from '../chat/models.ts';
import { normalizeAvatarUrl } from './avatar.ts';
import { AUTO_LANGUAGE, normalizeLanguage } from './languages.ts';
import { normalizeTimezone } from './timezones.ts';

/** 页面上会被改的东西。 */
export interface BotSettingsDraft {
  displayName: string;
  avatarUrl: string;
  isActive: boolean;
  /** `null` = 跟随服务端默认（不设 bot 级默认模型）。 */
  modelId: string | null;
  reasoningEffort: string | null;
  /** 对话语言：`auto`（跟随）或 ISO 639 code。见 `./languages.ts`。 */
  language: string;
  /**
   * 执行时区（IANA 名字）或 `''`（继承部署默认，本部署是 UTC）。见 `./timezones.ts`。
   *
   * 它**不是** settings 端点的字段：`POST /bots/{id}/settings` 收到空串会被
   * `COALESCE` 吃掉（实测：什么都不会变），所以它跟 `display_name` 一样走
   * `PUT /bots/{id}`——桌面端也是这么分的（`bot-settings.vue` 的 `buildJobs`）。
   */
  timezone: string;
  displayEnabled: boolean;
}

export function draftFrom(bot: Bot, settings: BotSettings | null): BotSettingsDraft {
  const modelId = settings?.chat_model_id ?? '';
  return {
    displayName: bot.display_name,
    // 服务端的 `avatar_url` 是 omitempty：没头像时**这个 key 根本不在响应里**（dev 栈实测，
    // 见 `./avatar.ts` 文件头），而草稿声明的是 `string`。不归一化的话设置页那个输入框
    // 会拿到 `undefined`（非受控），差分判断也会把"没动过"读成"改成了空串"。
    avatarUrl: normalizeAvatarUrl(bot.avatar_url),
    isActive: bot.is_active,
    modelId: modelId === '' ? null : modelId,
    reasoningEffort: settings?.reasoning_effort ?? null,
    language: normalizeLanguage(settings?.language),
    // 服务端的 `timezone` 是 omitempty：没设过时**这个 key 根本不在响应里**（实测），
    // 所以这里同时吃 `undefined` / `null` / `''` 三种"没设"。
    timezone: normalizeTimezone(bot.timezone),
    // 服务端没给 `display_enabled` 时**不当成"关着"**：那会让保存时把它写成一个用户
    // 从没选过的值。缺省 = 保持不动（见 patchFrom 的 null 处理）。
    displayEnabled: settings?.display_enabled !== false,
  };
}

/**
 计算要发出去的补丁。

 返回 `null` 表示"什么都没改"——调用方据此禁用保存按钮（而不是发一个空请求）。
 */
export function patchFrom(
  bot: Bot,
  settings: BotSettings | null,
  draft: BotSettingsDraft,
): { bot: Record<string, unknown>; settings: Record<string, unknown> } | null {
  const botPatch: Record<string, unknown> = {};
  if (draft.displayName !== bot.display_name) botPatch.display_name = draft.displayName;
  // 两边都归一化：服务端没给这个字段时是 `undefined`，直接比会把"我没动过"算成
  // "改成空串"，于是每次保存都多发一个 `avatar_url: ""`（别人刚设的头像会被清掉）。
  if (draft.avatarUrl !== normalizeAvatarUrl(bot.avatar_url)) botPatch.avatar_url = draft.avatarUrl;
  if (draft.isActive !== bot.is_active) botPatch.is_active = draft.isActive;
  /**
   时区：只在真的改过时发，而且发空串是**清空**（服务端把列写成 NULL → 回落部署默认），
   不是"没带这个字段"。两端读出来的"没设"都是空/缺失，所以这一句就是完整的差分判断。
   见 `./timezones.ts` 文件头里 2026-09-16 的实测记录。
   */
  if (normalizeTimezone(draft.timezone) !== normalizeTimezone(bot.timezone)) {
    botPatch.timezone = normalizeTimezone(draft.timezone);
  }

  const settingsPatch: Record<string, unknown> = {};
  const currentModelId = settings?.chat_model_id ?? '';
  // 空串 = **清空**（回到"跟随服务端默认"），不是"不改"——这是服务端的指针语义。
  if ((draft.modelId ?? '') !== currentModelId) settingsPatch.chat_model_id = draft.modelId ?? '';
  const currentEffort = settings?.reasoning_effort ?? '';
  if ((draft.reasoningEffort ?? '') !== currentEffort) {
    settingsPatch.reasoning_effort = draft.reasoningEffort ?? '';
  }
  // 语言：`auto` 发空串（服务端归一化成 `"auto"`），与桌面端下拉的存法一致。
  const currentLanguage = normalizeLanguage(settings?.language);
  if (normalizeLanguage(draft.language) !== currentLanguage) {
    settingsPatch.language = draft.language === AUTO_LANGUAGE ? '' : draft.language;
  }
  // `display_enabled` 缺省时不动它（老服务端可能没有这个字段）。
  if (
    settings?.display_enabled !== undefined &&
    draft.displayEnabled !== settings.display_enabled
  ) {
    settingsPatch.display_enabled = draft.displayEnabled;
  }

  if (Object.keys(botPatch).length === 0 && Object.keys(settingsPatch).length === 0) return null;
  return { bot: botPatch, settings: settingsPatch };
}

/**
 保存前的模型校验。

 用户可能在上次进来之后把那个模型删了/禁用了。那时保存一个失效的 id 只会让服务端报
 `invalid model ref`，而界面上写着"已选 xxx"——所以这里当场退回"跟随默认"，并把这件事
 通过返回值告诉界面（`null`）。
 */
export function verifiedModelId(
  draft: BotSettingsDraft,
  sections: ModelSection[] | null,
): string | null {
  if (draft.modelId === null) return null;
  if (sections === null) return draft.modelId;
  return verifiedChoice(
    { modelId: draft.modelId, reasoningEffort: draft.reasoningEffort },
    sections,
  ).modelId;
}

/** 目录里这个模型支持哪些思考档位（决定设置页要不要给强度那一行）。 */
export function effortsFor(draft: BotSettingsDraft, sections: ModelSection[] | null): string[] {
  const model = sections === null ? null : findModel(sections, draft.modelId ?? '');
  if (model === null || !model.supportsReasoning) return [];
  const choices = model.canDisableReasoning ? ['off', ...model.efforts] : model.efforts;
  return choices;
}

/** 草稿里模型的显示名（拿不到目录就退回 id 本身，不假装"默认"）。 */
export function modelLabel(draft: BotSettingsDraft, sections: ModelSection[] | null): string {
  if (draft.modelId === null) return '';
  if (sections === null) return draft.modelId;
  return findModel(sections, draft.modelId)?.name ?? draft.modelId;
}

export const EMPTY_SETTINGS_CHOICE = DEFAULT_CHOICE;

/**
 强度档位循环（设置页点一下换下一个）。

 为什么是"循环"而不是下拉：可选项来自服务端能力（`reasoning.efforts`），通常两三个，
 在设置行上点一下就换比再开一层选择器省一次跳转。档位清单为空时**原样返回**——
 不要因为"没有可选项"就悄悄把值改成别的东西。
 */
export function nextEffort(current: string | null, options: string[]): string | null {
  if (options.length === 0) return current;
  const index = options.indexOf(current ?? '');
  const next = options[(index + 1) % options.length];
  return next === undefined ? current : next;
}
