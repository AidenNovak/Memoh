/**
 * 目录列表的解析与排序。
 *
 * ## 两个容易做错的地方
 *
 * 1. **字段是 camelCase**（`isDir` / `modTime`），是全仓库唯一的例外（上游 Go 的
 *    `filemanager.go:28-35`）。写成 snake_case 不会报错——它只会让每个条目都变成
 *    "0 字节的文件"，而界面上看起来像"服务端没给大小"。
 * 2. **服务端不排序**，dirs-first 是客户端行为（上游 `file-manager/utils.ts:97`）。
 *    另外这里排序用**自然序**：`file2` 在 `file10` 前面。上游不区分自然序，
 *    但手机上目录里数字名很常见（`section-2.md`、`chapter-10.md`），值得做。
 *
 * 解析失败返回 `null` 而不是空数组：**"读不到"和"目录是空的"在屏幕上必须不一样**，
 * 后者是很正常的状态，前者是故障。空数组会把故障伪装成正常。
 *
 * 纯函数模块，`tests/files.test.mjs` 直接跑。
 */

/** 一个目录项的最小形状（就是协议里的那个样子，不做二次包装）。 */
export interface WorkspaceEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 字节。服务端缺失或给负数时归 0——界面不显示"0 B"这种情况由调用方决定。 */
  size: number;
  /** ISO 字符串；拿不到就是空串。 */
  modTime: string;
  mode: string;
}

/**
 * 一次渲染上限。
 *
 * 上游 `fs/list` 无分页、无上限（`maxEntries=0`），一万个文件的目录会把列表打死。
 * 500 行 + 底部「显示更多」是"看得出还有内容、但不一次画一万行"的折中。
 */
export const MAX_VISIBLE_ENTRIES = 500;

function asEntry(raw: unknown): WorkspaceEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  if (name === '') return null;
  const size = record.size;
  return {
    name,
    path: typeof record.path === 'string' ? record.path : '',
    // 严格用 camelCase：写成 `is_dir` 是读错了协议，别在这里兜底掩盖它。
    isDir: record.isDir === true,
    size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0,
    modTime: typeof record.modTime === 'string' ? record.modTime : '',
    mode: typeof record.mode === 'string' ? record.mode : '',
  };
}

/**
 * 解析 `fs/list` 的响应。
 *
 * 认 `entries`（真实服务的形状），也认 `items`（`types.ts` 里记下来的另一种历史形状）。
 * 两者都没有、或者不是数组 → null：调用方要显示"列目录失败"，而不是空目录。
 */
export function parseDirectoryEntries(payload: unknown): WorkspaceEntry[] | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const raw = record.entries ?? record.items;
  if (!Array.isArray(raw)) return null;
  const entries: WorkspaceEntry[] = [];
  for (const item of raw) {
    const entry = asEntry(item);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

const isDigit = (character: string): boolean => character >= '0' && character <= '9';

/**
 * 自然序比较。
 *
 * 手写而不是 `localeCompare(..., {numeric: true})`：后者依赖运行时的 ICU 数据
 * （Node 与 Hermes 的结果不保证一致），而这一条规则要在两个环境里给出**同一个顺序**，
 * 否则"测试里是对的、手机上是另一个顺序"。
 */
export function naturalCompare(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (isDigit(a[i] ?? '') && isDigit(b[j] ?? '')) {
      let endA = i;
      while (endA < a.length && isDigit(a[endA] ?? '')) endA += 1;
      let endB = j;
      while (endB < b.length && isDigit(b[endB] ?? '')) endB += 1;
      // 去前导零后比长度，再比字典序——避免 Number() 对超长数字串丢精度。
      const digitsA = a.slice(i, endA).replace(/^0+/, '');
      const digitsB = b.slice(j, endB).replace(/^0+/, '');
      if (digitsA.length !== digitsB.length) return digitsA.length - digitsB.length;
      if (digitsA !== digitsB) return digitsA < digitsB ? -1 : 1;
      i = endA;
      j = endB;
      continue;
    }
    const characterA = a[i] ?? '';
    const characterB = b[j] ?? '';
    if (characterA !== characterB) return characterA < characterB ? -1 : 1;
    i += 1;
    j += 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  // 大小写不同但排序相等时给一个稳定结果，否则同一份数据的顺序可能变。
  if (left !== right) return left < right ? -1 : 1;
  return 0;
}

/** dirs-first + 自然序。返回新数组，不改调用方的那份。 */
export function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    const byName = naturalCompare(left.name, right.name);
    if (byName !== 0) return byName;
    return naturalCompare(left.path, right.path);
  });
}

/** 截断到 `limit` 行，并告知还有多少没显示。 */
export function visibleEntries(
  entries: WorkspaceEntry[],
  limit: number = MAX_VISIBLE_ENTRIES,
): { visible: WorkspaceEntry[]; hidden: number } {
  if (entries.length <= limit) return { visible: entries, hidden: 0 };
  return { visible: entries.slice(0, limit), hidden: entries.length - limit };
}
