/**
 * 重命名会话：**组装原生选择器的模型 + 等一个结论**。
 *
 * 这一份替掉 `ui/RenameSessionPage.tsx`（那张 RN sheet 已删除）。原页那三条判据原样保留：
 *
 * 1. **保存是差分的**：只发 `{title}`，而且**没改就不发**（`renamePatch` 返回 null）。
 *    `PATCH /bots/{id}/sessions/{id}` 是字段级更新，整份回写会把桌面端同时改的东西带回去。
 * 2. **保存完要重拉列表**：列表上那份标题是本地缓存的，不重拉就还是旧的——用户会以为
 *    改名没生效。
 * 3. **失败留在这一屏**：把原因画回去（`presentError` → `reasonKeyOf`），而不是静默走掉。
 *
 * ## 与 spec §1 的一处对应
 *
 * 原生那条规矩是"`select` 之后自动收 sheet，`submit` 不自动收"——重命名正好用得上：
 * 按"保存"只是**一个信号**（`submit`），成不成只有 RN 知道（要发 `PATCH`）。所以这里是
 * **RN 自己收**：成功 → `handle.finish(...)`（顺带收掉），失败 → `update` 一份带错误
 * 的模型（sheet 留在原地，用户可以直接改了再按一次）。
 *
 * ## 已知的两处观感差别（明说）
 *
 * 1. **"保存中"**用 `status: 'loading'` 表达（原页是按钮里一颗转圈）。原生在 loading 态
 *    画的是转圈 + `loadingLabel`（占住列表区；底部输入区照旧在）——用的是现成的
 *    `botSettings.saving`（"Saving…"），因为这一轮不许新增 i18n key。
 * 2. **"没改就不发请求"**：原页这时按钮是灰的，现在按了会直接收掉（以当前标题结算）。
 *    调用方只关心"列表要不要重拉"，这两条路对它是同一件事。
 */
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import { presentError, reasonKeyOf, type ErrorPresentation } from '../errors/present.ts';
import { renamePatch } from './actions.ts';

/** 这一页只用得上"改会话"这一个方法（与 `features/chat/models.ts` 的 `CatalogSource` 同一条规矩）。 */
export interface SessionPatchSource {
  updateSession(botId: string, sessionId: string, body: Record<string, unknown>): Promise<unknown>;
}

export interface RenameSessionParams {
  client: SessionPatchSource | null;
  botId: string | null;
  sessionId: string;
  /** 当前标题（进来先填上，用户改的是它，不是从空白开始写）。 */
  title: string;
  /** 保存成功后重拉会话列表（`useSession()` 的 `refreshSessions`）。 */
  refreshSessions: () => Promise<void>;
}

export interface RenameSessionResult {
  title: string;
}

export function presentRenameSession(
  params: RenameSessionParams,
): Promise<PresentationResult<RenameSessionResult>> {
  const { botId, client, refreshSessions, sessionId } = params;
  if (client === null || botId === null) return Promise.resolve({ status: 'cancelled' });

  const current = params.title;
  /** 输入框里的草稿。击键过桥回到这里（受控），提交时用它。 */
  let draft = current;
  let busy = false;
  let failure: ErrorPresentation | null = null;

  const buildRequest = (): NativePickerRequest => ({
    title: t('session.rename.title'),
    // 这一页没有列表，只有底部那个单字段表单。
    sections: [],
    input: {
      label: t('session.rename.placeholder'),
      placeholder: t('session.rename.placeholder'),
      value: draft,
      submitLabel: t('common.done'),
    },
    status: statusOf(busy, failure),
    loadingLabel: t('botSettings.saving'),
    errorTitle: t('session.rename.failed'),
    errorBody: failure === null ? '' : t(reasonKeyOf(failure)),
  });

  const save = (text: string, handle: NativePickerHandle) => {
    draft = text;
    if (busy) return;
    const patch = renamePatch(current, draft);
    if (patch === null) {
      // 没改（或改成了空）就不发请求：发一个与现值一样的 title 只是白跑一趟。
      // 见文件头"已知的观感差别"第 2 条。
      handle.finish({ title: current });
      return;
    }
    busy = true;
    failure = null;
    handle.update(buildRequest());
    void (async () => {
      try {
        await client.updateSession(botId, sessionId, patch);
        // 列表上那份标题是本地缓存的，不重拉就还是旧的——用户会以为改名没生效。
        await refreshSessions();
        handle.finish({ title: patch.title });
      } catch (caught) {
        busy = false;
        // 失败就**留在这一屏**并把原因摆出来（换个名字失败通常就是权限或参数）。
        failure = presentError(caught);
        handle.update(buildRequest());
      }
    })();
  };

  return presentNativePicker<RenameSessionResult>(buildRequest(), {
    onInput: (text, handle) => {
      draft = text;
      handle.update(buildRequest());
    },
    onSubmit: save,
  });
}

/** 保存中 → 转圈；失败 → 错误块；其余 → 表单。 */
function statusOf(busy: boolean, failure: ErrorPresentation | null): 'ready' | 'loading' | 'error' {
  if (busy) return 'loading';
  if (failure === null) return 'ready';
  return 'error';
}
