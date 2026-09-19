/**
 * composer 上的**模型 + 思考强度**选择：纯逻辑。
 *
 * ## 为什么这些判断值得单拎出来
 *
 * 这里每一件事都有"写错了也不明显"的分岔：
 *
 * 1. **分组**：桌面端按 provider 分组。`GET /models` 只给 `provider_id`，所以要么去
 *    `GET /providers` 拿名字，要么**退回平铺**——但绝不能把一串 uuid 当分组标题，
 *    那不是分组，是把列表切碎。
 * 2. **能力来自服务端**：思考强度能不能选、能不能关、有哪些档位，全读 `reasoning`
 *    这个对象。客户端自己从 `config.compatibilities` 推是上游修过的 bug（web picker
 *    与协议各推一份、结论不一致）。
 * 3. **失效的选择**：用户上回选的模型可能已经被禁用/删除。那时必须**退回默认**并且
 *    **不要把这个 id 发出去**——发出去服务端会拒，而用户看着界面上写着一个还在的模型名。
 * 4. **`model_id` 与 `id`**：发消息带的是 `model_id`（如 `k3`），不是目录行的 uuid。
 *    这两个字段长得很像，混了之后服务端能找到模型才算运气好。
 */
import type { ModelSummary, ProviderSummary } from '../../api/types.ts';

/** 选择器里的一行：把服务端的字段整理成界面要的东西。 */
export interface ChatModel {
  /** 发送时用这个（服务端的 `model_id`），**不是**目录行的 `id`。 */
  modelId: string;
  name: string;
  providerId: string;
  providerName: string;
  supportsReasoning: boolean;
  /** 能不能选"关掉思考"。false 表示这个模型总是思考（有些模型不支持关）。 */
  canDisableReasoning: boolean;
  efforts: string[];
  defaultEffort: string;
}

export interface ModelSection {
  /** 分组的标题。没有 provider 名字时是 `null`（平铺）。 */
  title: string | null;
  models: ChatModel[];
}

/** composer 当前的选择。空 = 跟随服务端默认。 */
export interface ComposerChoice {
  modelId: string | null;
  reasoningEffort: string | null;
}

export const DEFAULT_CHOICE: ComposerChoice = { modelId: null, reasoningEffort: null };

function providerNameOf(providers: ProviderSummary[], providerId: string): string {
  const found = providers.find((provider) => provider.id === providerId);
  return found === undefined ? '' : found.name;
}

/**
 目录 → 可选项。

 只收 `type === 'chat'` 且没被显式禁用的（`enable: false` 是"配置里有但别用它"）。
 `type` 缺失时**当它可用**：老版本服务端不返回这个字段，把缺失当成"不是聊天模型"会让
 整个选择器空掉——错在更糟的方向。
 */
export function toChatModel(model: ModelSummary, providers: ProviderSummary[]): ChatModel | null {
  if (model.enable === false) return null;
  if (model.type !== undefined && model.type !== '' && model.type !== 'chat') return null;
  const reasoning = model.reasoning;
  return {
    modelId: model.model_id,
    name: model.name !== '' ? model.name : model.model_id,
    providerId: model.provider_id,
    providerName: providerNameOf(providers, model.provider_id),
    supportsReasoning: reasoning?.supported === true,
    canDisableReasoning: reasoning?.can_disable === true,
    efforts: reasoning?.efforts ?? [],
    defaultEffort: reasoning?.default_effort ?? '',
  };
}

/**
 分组。

 有 provider 名字就按名字分组（并按名字排序，保证同一份目录每次渲染顺序一致）；
 **一个名字都没有就平铺**（`title: null`），而不是拿 provider_id 分组。
 */
export function sectionsFrom(
  models: ModelSummary[],
  providers: ProviderSummary[] = [],
): ModelSection[] {
  const chat = models
    .map((model) => toChatModel(model, providers))
    .filter((model): model is ChatModel => model !== null);

  const named = chat.filter((model) => model.providerName !== '');
  if (named.length === 0) {
    return [{ title: null, models: sortByName(chat) }];
  }

  const byProvider = new Map<string, ChatModel[]>();
  for (const model of chat) {
    // 没有名字的那几条（provider 被删了之类）归到一个空标题组里，不混进别的品牌下。
    const key = model.providerName === '' ? '' : model.providerName;
    byProvider.set(key, [...(byProvider.get(key) ?? []), model]);
  }

  return (
    [...byProvider.entries()]
      // 没有 provider 名字的那一组永远排最后（它是兜底组，不是品牌）。写成显式分支而不是
      // 链式三元（AGENTS.md 禁止嵌套三元，也让"谁是兜底"这件事读得出来）。
      .sort(([left], [right]) => {
        if (left === right) return 0;
        if (left === '') return 1;
        if (right === '') return -1;
        return left.localeCompare(right);
      })
      .map(([title, grouped]) => ({
        title: title === '' ? null : title,
        models: sortByName(grouped),
      }))
  );
}

function sortByName(models: ChatModel[]): ChatModel[] {
  return [...models].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  );
}

/** 搜索：模型名与 model_id 都算命中（用户可能记得 `k3`，也可能记得 "Kimi K3"）。 */
export function filterSections(sections: ModelSection[], query: string): ModelSection[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return sections;
  return sections
    .map((section) => ({
      title: section.title,
      models: section.models.filter(
        (model) =>
          model.name.toLowerCase().includes(needle) ||
          model.modelId.toLowerCase().includes(needle) ||
          model.providerName.toLowerCase().includes(needle),
      ),
    }))
    .filter((section) => section.models.length > 0);
}

/**
 当前选择是否还有效；失效就退回默认。

 为什么要这一条：目录会因为**别人**（管理员、桌面端）改动而变化，而本地记住了上回的
 选择。失效的选择有两层危害——界面上写着一个已经不存在的模型，以及**发出去的
 `model_id` 服务端不认识**。两者都让用户以为"这个 App 自己改了我的设置"。
 */
export function verifiedChoice(choice: ComposerChoice, sections: ModelSection[]): ComposerChoice {
  if (choice.modelId === null) return DEFAULT_CHOICE;
  const model = findModel(sections, choice.modelId);
  if (model === null) return DEFAULT_CHOICE;
  // 强度也要重新核：换模型（或服务端改了支持档位）之后，上回那个档位可能不存在了。
  if (choice.reasoningEffort !== null) {
    if (!model.supportsReasoning) return { modelId: model.modelId, reasoningEffort: null };
    if (!model.efforts.includes(choice.reasoningEffort)) {
      return {
        modelId: model.modelId,
        reasoningEffort: model.defaultEffort === '' ? null : model.defaultEffort,
      };
    }
  }
  return choice;
}

export function findModel(sections: ModelSection[], modelId: string): ChatModel | null {
  for (const section of sections) {
    const found = section.models.find((model) => model.modelId === modelId);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 强度可选项：`off` + 各档位。

 `can_disable` 为假时**不给 off**（有些模型关不掉思考，给一个按不动的 off 是骗人）。
 */
export function effortChoices(model: ChatModel | null): string[] {
  if (model === null || !model.supportsReasoning) return [];
  if (model.canDisableReasoning) return ['off', ...model.efforts];
  return model.efforts;
}

/**
 强度档位的文案 key。**未知档位返回 null**，界面原样显示那个字符串。

 为什么不是"永远返回一个 key"：档位清单是服务端给的（`reasoning.efforts`），它可以加新的
 档位。客户端硬编码一份 `low/medium/high` 的映射、遇到新档位就显示空白或 `unknown`，
 是把自己变成那个会落后的一方；退回原字符串至少说的是真的。
 */
export function effortLabelKey(effort: string): string | null {
  if (effort === 'off') return 'chat.effort.off';
  if (effort === 'low') return 'chat.effort.low';
  if (effort === 'medium') return 'chat.effort.medium';
  if (effort === 'high') return 'chat.effort.high';
  return null;
}

/**
 模型目录的进程内缓存。
 *
 为什么要缓存：composer 那颗胶囊每次渲染都要显示"现在用的是哪个模型"，而目录只有打开
 选择器时才需要。为了给胶囊配一个名字去每次都拉 `/models` 是浪费；完全不拉就只能显示
 `k3` 这种 id——那不是给人看的。
 *
 为什么按 client 缓存而不是全局一次：Memoh 是自托管的，换服务器 = 换一份目录。
 缓存认的是**同一个 client 实例**，换服务器（client 重建）就自动作废。
 */
let cached: { client: unknown; promise: Promise<ModelSection[]> } | null = null;

export interface CatalogSource {
  listModels: () => Promise<{ items?: ModelSummary[] } | ModelSummary[]>;
  listProviders: () => Promise<{ providers?: ProviderSummary[] } | ProviderSummary[]>;
}

/** 取目录（同一 client 只真拉一次）。provider 名字拿不到不影响结果，只是不分组。 */
export function loadCatalog(client: CatalogSource): Promise<ModelSection[]> {
  if (cached !== null && cached.client === client) return cached.promise;
  const promise = (async () => {
    const [modelsPayload, providersPayload] = await Promise.all([
      client.listModels(),
      client.listProviders().catch(() => [] as ProviderSummary[]),
    ]);
    const models: ModelSummary[] = Array.isArray(modelsPayload)
      ? modelsPayload
      : (modelsPayload?.items ?? []);
    const providers: ProviderSummary[] = Array.isArray(providersPayload)
      ? providersPayload
      : (providersPayload?.providers ?? []);
    return sectionsFrom(models, providers);
  })();
  cached = { client, promise };
  // 拉失败不要把失败的 promise 留在缓存里——否则一次网络抖动会让这颗胶囊**整个 App
  // 生命周期内**都拿不到名字。
  promise.catch(() => {
    if (cached !== null && cached.promise === promise) cached = null;
  });
  return promise;
}

/** 丢掉缓存（退出登录、换服务器、验收时清场用）。 */
export function resetCatalogCache(): void {
  cached = null;
}

/** 胶囊上显示什么名字：选过就用它的名字，没选过/名字不知道就 null（界面自己兜底）。 */
export function modelNameFor(
  sections: ModelSection[] | null,
  modelId: string | null,
): string | null {
  if (sections === null || modelId === null) return null;
  return findModel(sections, modelId)?.name ?? null;
}
