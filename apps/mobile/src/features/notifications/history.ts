/**
 * 权限请求史（`policy.PermissionState` 里除 `status` 之外的两个字段）。
 *
 * ## 为什么要单独存
 *
 * `status` 每次都能从系统读，但**我们请求过几次、上次什么时候请求的**只有自己知道。
 * 而 policy 的两道闸（封顶 2 次、7 天冷却）吃的正是这两个数——不存它们，
 * "被拒不缠"这条判据就退化成"每次进设置页都请求一次"，而那正是 HIG 点名的反例。
 *
 * ## 为什么形状与读写分开
 *
 * 形状与"记一次请求"是纯逻辑（能在 `node --test` 里钉住）；读写要过 Keychain，
 * 只能在设备上验。所以读写留在 `store.ts`，这一层只管形状。
 */

export interface PermissionHistory {
  askedCount: number;
  lastAskedAt: number | null;
}

export const EMPTY_HISTORY: PermissionHistory = { askedCount: 0, lastAskedAt: null };

/** 读出来的东西不可信（老版本、被改坏、类型不对）时一律退回"没请求过"。 */
export function parsePermissionHistory(raw: string | null): PermissionHistory {
  if (raw === null || raw === '') return EMPTY_HISTORY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_HISTORY;
    const { askedCount, lastAskedAt } = parsed as Record<string, unknown>;
    const count = typeof askedCount === 'number' && Number.isFinite(askedCount) ? askedCount : 0;
    const at = typeof lastAskedAt === 'number' && Number.isFinite(lastAskedAt) ? lastAskedAt : null;
    return { askedCount: Math.max(0, Math.floor(count)), lastAskedAt: at };
  } catch {
    return EMPTY_HISTORY;
  }
}

export function serializePermissionHistory(history: PermissionHistory): string {
  return JSON.stringify({ askedCount: history.askedCount, lastAskedAt: history.lastAskedAt });
}

/**
 * 记一次请求。
 *
 * 只在**真的调了 `requestAuthorization`** 之后调用（哪怕结果是"用户没给"）——
 * 那道闸管的是"我们表达了几次诉求"，不是"用户答应了几次"。
 */
export function recordPermissionRequest(
  history: PermissionHistory,
  now: number,
): PermissionHistory {
  return { askedCount: history.askedCount + 1, lastAskedAt: now };
}
