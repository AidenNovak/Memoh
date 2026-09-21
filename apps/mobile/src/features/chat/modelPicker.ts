/**
 * 模型 + 思考强度选择器：**组装原生选择器的模型 + 等一个结论**。
 *
 * 这一份替掉 `ui/ModelPickerPage.tsx`（那张 RN sheet 已删除）。**搬走的只有"画"**：
 * 拉目录、按 provider 分组、搜索过滤、强度档位、换模型时强度跟着默认值——逐行照旧，
 * 因为它们每一条都有"写错了也不明显"的分岔（见 `features/chat/models.ts` 的文件头）。
 *
 * ## 为什么 client 要由调用方传进来
 *
 * 以前那一页用 `useSession()` 拿 client，而这里是一个**普通函数**（在事件处理里被调起），
 * 用不了 hook。所以取数来源走参数——与 `features/*` 里其它函数（`loadSkills`、
 * `submit`）同一条规矩：**依赖显式传，函数自己不去摸全局**。
 *
 * ## 三个状态都在 RN 这一侧判
 *
 * 原生只会照 `status` 画（`loading` 转圈、`error` 画标题+原因+重试），而"现在是哪一种"
 * 由这里决定：
 *
 * | 情形 | status | 原生画什么 |
 * | --- | --- | --- |
 * | 目录还没到 | `loading` | 转圈 + `loadingLabel` |
 * | 目录到了 | `ready` | 分组列表 |
 * | 拉失败 | `error` | 标题 + 原因（`reasonKeyOf`）+ 能不能重试 |
 *
 * 失败要不要给重试钮，读的是 `features/errors/present.ts` 那一条白名单判据
 * （传输层失败才配重试），**不是"失败了就给"**。
 */
import type { ModelSummary, ProviderSummary } from '../../api/types.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
  type NativePickerSection,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import { canRetry, presentError, reasonKeyOf, type ErrorPresentation } from '../errors/present.ts';
import {
  DEFAULT_CHOICE,
  effortChoices,
  effortLabelKey,
  filterSections,
  findModel,
  sectionsFrom,
  type CatalogSource,
  type ComposerChoice,
  type ChatModel,
  type ModelSection,
} from './models.ts';
import { providerIconSlug } from './providerIcons.ts';

export interface ModelPickerParams {
  /** 目录来源（`GET /models` + `GET /providers`）。null = 还没建连，这时不开这张 sheet。 */
  client: CatalogSource | null;
  /** 打开时带进来的当前选择；选完返回新的选择。取消 = `cancelled`（调用方不动现状）。 */
  choice: ComposerChoice;
}

export function presentModelPicker(
  params: ModelPickerParams,
): Promise<PresentationResult<ComposerChoice>> {
  const { client } = params;
  /**
   没有 client 时**不开**这张 sheet。

   以前那一页在 client 还没建连时停在转圈上——用户面对的是一张永远拉不到东西的列表，
   除了下滑没有别的动作。这里直接回 `cancelled`（调用方本来就区分两支，行为等于"没点过"）。
   */
  if (client === null) return Promise.resolve({ status: 'cancelled' });

  const choice = params.choice;
  /** 目录。null = 还没到（或正在重拉）。 */
  let sections: ModelSection[] | null = null;
  /** 搜索框里的字。过滤留在 RN（`filterSections`），原生只把击键报回来。 */
  let query = '';
  let failure: ErrorPresentation | null = null;

  const buildRequest = (): NativePickerRequest => ({
    title: t('chat.model.a11y'),
    searchPlaceholder: t('chat.model.search'),
    // 沿用原页的标识（`ui/ModelPickerPage.tsx` 的搜索框就是 `model-search`）。
    searchTestID: 'model-search',
    sections: buildSections(sections, choice, query),
    status: statusOf(sections, failure),
    loadingLabel: t('common.loading'),
    errorTitle: t('chat.model.failed'),
    errorBody: failure === null ? '' : t(reasonKeyOf(failure)),
    retryLabel: failure !== null && canRetry(failure) ? t('common.retry') : '',
  });

  const load = async (handle: NativePickerHandle) => {
    try {
      const [modelsPayload, providersPayload] = await Promise.all([
        client.listModels(),
        // provider 名字是"锦上添花"：拿不到就平铺，**不能让整页因此失败**。
        client.listProviders().catch(() => [] as ProviderSummary[]),
      ]);
      const models: ModelSummary[] = Array.isArray(modelsPayload)
        ? modelsPayload
        : (modelsPayload?.items ?? []);
      const providers: ProviderSummary[] = Array.isArray(providersPayload)
        ? providersPayload
        : (providersPayload?.providers ?? []);
      sections = sectionsFrom(models, providers);
      failure = null;
    } catch (caught) {
      failure = presentError(caught);
    }
    handle.update(buildRequest());
  };

  return presentNativePicker<ComposerChoice>(buildRequest(), {
    onPresented: (handle) => {
      void load(handle);
    },
    onSearch: (text, handle) => {
      query = text;
      handle.update(buildRequest());
    },
    onRetry: (handle) => {
      // 重拉走的是和首次完全相同的那条路（同样会重新拉 provider、同样会清掉上一次的失败）。
      sections = null;
      failure = null;
      handle.update(buildRequest());
      void load(handle);
    },
  });
}

/** 目录还没到 → 转圈；拉失败 → 错误块；到了 → 列表。 */
function statusOf(
  sections: ModelSection[] | null,
  failure: ErrorPresentation | null,
): 'ready' | 'loading' | 'error' {
  if (sections !== null) return 'ready';
  if (failure === null) return 'loading';
  return 'error';
}

/** 目录 → 分组。`query` 非空时先过滤（过滤规则在 `models.ts`，这里不重写一遍）。 */
function buildSections(
  sections: ModelSection[] | null,
  choice: ComposerChoice,
  query: string,
): NativePickerSection[] {
  if (sections === null) return [];

  const groups: NativePickerSection[] = [
    {
      id: 'default',
      header: t('chat.model.default.group'),
      rows: [
        {
          id: 'default',
          label: t('chat.model.default'),
          detail: t('chat.model.default.hint'),
          // 「跟随服务端默认」也是一项：用户改过之后必须能改回来。
          selected: choice.modelId === null,
          valueJson: JSON.stringify(DEFAULT_CHOICE),
        },
      ],
    },
  ];

  for (const [index, section] of filterSections(sections, query).entries()) {
    groups.push({
      // 没有 provider 名字时是平铺（`title: null`），这时分组 id 只用来区分顺序。
      id: section.title === null ? `flat-${index}` : `provider:${section.title}`,
      header: section.title ?? '',
      icon: section.title === null ? '' : (providerIconSlug(section.title) ?? ''),
      rows: section.models.map((model) => ({
        id: model.modelId,
        label: model.name,
        detail: model.supportsReasoning ? t('chat.model.reasoning.supported') : model.modelId,
        selected: choice.modelId === model.modelId,
        valueJson: JSON.stringify(choiceForModel(model.modelId, model)),
      })),
    });
  }

  // 强度段：只有当前模型支持思考时才出现（它是"这个模型的档位"，不是另一个模型）。
  const efforts = effortChoices(findModel(sections, choice.modelId ?? ''));
  if (efforts.length > 0) {
    groups.push({
      id: 'effort',
      header: t('chat.model.reasoning'),
      rows: efforts.map((effort) => {
        const key = effortLabelKey(effort);
        return {
          id: `effort-${effort}`,
          // 未知档位原样显示那个字符串：档位清单是服务端给的，它可以加新的。
          label: key === null ? effort : t(key),
          selected: (choice.reasoningEffort ?? '') === effort,
          valueJson: JSON.stringify({ modelId: choice.modelId, reasoningEffort: effort }),
        };
      }),
    });
  }

  return groups;
}

/**
 选中某个模型之后该用哪个强度。

 换模型时强度跟着**该模型的默认值**——上回那个档位属于上一个模型，跟过来是错的。
 模型不支持思考时一律 null（不是空串：空串在服务端是一个"档位"的样子）。
 */
function choiceForModel(modelId: string, model: ChatModel | null): ComposerChoice {
  if (model?.supportsReasoning !== true) return { modelId, reasoningEffort: null };
  return { modelId, reasoningEffort: model.defaultEffort === '' ? null : model.defaultEffort };
}
