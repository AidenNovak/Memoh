/**
 * 一次失败 → 「屏幕上该说什么 + 该给什么动作」。
 *
 * ## 为什么要把它抽成纯函数
 *
 * 以前这件事散在各处，而且各处的答案不一致：`describeError` 把 i18n key 和**服务端原文**
 * 混在同一个 string 里返回（调用方靠 `startsWith('error.')` 去猜它是什么），`useDirectory`
 * 又自己抄了一份判据，`BotSettingsScreen` 干脆直接把 `caught.message` 打到屏幕上。
 * 结果是同一件事在三个屏上说三种话，而"要不要给重试"完全靠当时谁写的。
 *
 * 现在只有这一处判断。规则见 `docs/research/ios-error-and-feedback.md` §3、§4：
 *
 * - **`retry` 是白名单，不是默认值。** 只有"这次没成功、下次可能成功"的传输层失败
 *   （网络 / 超时 / 429 / 5xx）才配重试按钮。业务拒绝、凭据失效、协议形状不对，
 *   重试一百次也不会变——给按钮等于让用户去做一件我们已经知道不会成的事。
 * - **服务端原文只在"它带着原因"时才透出**：判据是服务端给了**类型化错误码**
 *   （`code` 字段）。那说明我们的 fork 有意让客户端分辨这一档（先例：压缩的
 *   `compaction_model_unavailable`）。没有 `code` 的 `message` 是给开发者看的
 *   （`HTTP 500`、网关的 HTML、`Network request failed`），永远不上屏。
 * - 返回的 `key` 是**补充说明那一句**（"发生了什么"），不是标题：标题由所在屏给
 *   （"拉不到会话列表" vs "保存不上"是两件事，只有屏知道）。`detail` 有值时优先用它。
 */
import { ApiError } from '../../api/client.ts';

/**
 * 用户下一步能做什么。
 *
 * - `retry`：同一件事再来一次**可能**会成功（传输层失败）。
 * - `signin`：只有重新登录能解决（凭据失效）。
 * - `none`：重试没有意义。界面不要再给重试按钮——那是在撒谎。
 */
export type ErrorRecovery = 'retry' | 'signin' | 'none';

export interface ErrorPresentation {
  /** 补充说明那一句的 i18n key（"发生了什么"）。屏自己给标题。 */
  key: string;
  /** 服务端写的原因。只有 `code` 在场才有值，见 `detailOf`。 */
  detail?: string;
  recovery: ErrorRecovery;
}

/**
 * 服务端原文值不值得给用户看。
 *
 * 只有**类型化错误码 + 非空 message** 才算数：`code` 是我们 fork 给客户端的信号，
 * 说明这条错误是**有意**被分辨出来的。`HTTP 500` 这种兜底文案即使碰巧有 code 也不上屏。
 */
export function detailOf(error: ApiError): string | undefined {
  const code = error.code;
  if (code === undefined || code.trim() === '') return undefined;
  const message = error.message.trim();
  if (message === '') return undefined;
  // `api/client.ts` 的兜底：响应体不是 JSON（或没有 message/error 字段）时用状态码拼的。
  if (/^HTTP \d+$/.test(message)) return undefined;
  return message;
}

export function presentError(caught: unknown): ErrorPresentation {
  if (caught instanceof ApiError) return presentApiError(caught);
  // 不是 API 层的错误 = 我们自己代码里的意外。不把堆栈/内部消息给用户。
  return { key: 'error.unexpected', recovery: 'none' };
}

function presentApiError(error: ApiError): ErrorPresentation {
  // 顺序即优先级：401 不会同时被判成网络错误，但超时也走 status 0，
  // 所以它必须排在 `isNetwork` 前面（两个都 status 0，含义相反）。
  if (error.isUnauthorized) return { key: 'error.unauthorized', recovery: 'signin' };
  if (error.code === 'timeout') return { key: 'error.timeout', recovery: 'retry' };
  if (error.isNetwork) return { key: 'error.network', recovery: 'retry' };
  if (error.status === 403) return { key: 'error.forbidden', recovery: 'none' };
  if (error.status === 404) return { key: 'error.notFound', recovery: 'none' };
  if (error.status === 429) return { key: 'error.rateLimited', recovery: 'retry' };

  /**
   ⚠️ 服务端**给了类型化 code** 的 5xx 与"网关挂了"不是一件事。

   5xx 大多是传输层那类（502、panic、网关 HTML 页），它们**没有** `code`——那才配"重试"。
   而带着 `code` 的 5xx 是服务端**知道原因并有意分辨**的那一类（先例：
   `schedule_write_conflict`、`compaction_model_unavailable`）。这时：

   - 它的话原样上屏（那就是用户需要的信息，R24/R26）；
   - **不给重试**：它已经说了"为什么"，再发一次同样的请求还是同一个拒绝（R19/R20）。

   2026-09-16 实测踩到：以前 5xx 一视同仁地短路成"服务器出错了 + 重试"，
   于是"另一个客户端改过这条"永远说不出来，而用户只能反复按 Save。
   */
  const detail = detailOf(error);
  if (error.status >= 500) {
    if (detail === undefined) return { key: 'error.server', recovery: 'retry' };
    return { key: 'error.server', detail, recovery: 'none' };
  }

  // 剩下的 4xx：服务端明确拒绝了这个请求。同一个请求再发一次还是被拒。
  if (detail === undefined) return { key: 'error.rejected', recovery: 'none' };
  return { key: 'error.rejected', detail, recovery: 'none' };
}

export function canRetry(presentation: ErrorPresentation): boolean {
  return presentation.recovery === 'retry';
}

/**
 * 补充说明那一句话。有服务端原因就用它的（R26：原文当补充说明，不当标题），
 * 否则用我们自己的。
 */
export function reasonKeyOf(presentation: ErrorPresentation): string {
  return presentation.detail === undefined ? presentation.key : presentation.detail;
}
