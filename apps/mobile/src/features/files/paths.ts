/**
 * 工作区路径：拼接、归一化、面包屑。
 *
 * ## 为什么客户端要自己钉死根
 *
 * 服务端的 `fs/*` 只做 `path.Clean` + 拒 `..`（`internal/handlers/filemanager.go:102`），
 * **不校验绝对路径前缀**。也就是说，只要有人能让我们请求 `/etc/passwd`，服务端就会照办。
 * 手机端不欢迎"从消息里点一个绝对路径直接浏览"，所以安全边界必须在这里：
 *
 *   - 每次拼接都由浏览器自己逐级做（父路径 + 子项名），不接受外部传入的绝对路径；
 *   - 归一化后必须**仍在 `/data` 之下**，越界就返回 null，调用方显示错误态——
 *     不猜、不纠正、不"顺手改成 /data 下的同名路径"。
 *
 * 返回 null 而不是抛异常：路径可能来自 URL（深链、粘贴），是用户输入的一种，
 * 非法输入应当变成界面上的一个错误态，而不是让 App 崩。
 *
 * 这个模块是纯函数（不 import react / react-native），`tests/files.test.mjs` 直接跑它。
 */

/** 工作区根。服务端不校验它，所以我们钉死。 */
export const WORKSPACE_ROOT = '/data';

const NUL = '\u0000';

/**
 * 把任意输入归一化成 `/data` 之下的绝对路径。
 *
 * 接受的形态：
 *   - `''` / `'/'` / `'.'`            → 根（`/data`）
 *   - `/data/projects`                → 绝对路径，必须在 `/data` 下
 *   - `projects/memoh-ios`            → 相对路径，按根拼接
 *   - `data/projects`                 → 带 `data` 前缀的相对路径（路由参数拼出来的形态）
 *
 * 拒绝（返回 null）：`..` 越界、反斜杠、NUL、`/etc/passwd` 这种不在 `/data` 下的绝对路径。
 */
export function normalizeWorkspacePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  if (input.includes(NUL)) return null;
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === '/') return WORKSPACE_ROOT;

  // 反斜杠不是我们的分隔符。出现它只可能是有人想绕（`..\..\`），或者粘错了东西。
  if (trimmed.includes('\\')) return null;

  const absolute = trimmed.startsWith('/');
  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    segments.push(segment);
  }

  // 相对路径写 `data/...` 时按绝对理解（路由参数拼出来就是这种形态）。
  const anchored = absolute || segments[0] === 'data';
  let rest = segments;
  if (anchored) {
    // 绝对形态必须以 data 开头：`/etc/passwd` 不是"工作区里的路径"，
    // 悄悄改写成 `/data/etc/passwd` 会让用户看着一个不存在的目录发懵。
    if (segments[0] !== 'data') return null;
    rest = segments.slice(1);
  }

  const stack: string[] = [];
  for (const segment of rest) {
    if (segment === '..') {
      // 弹不动就是越界：`/data/..` 必须整体失败，而不是变成 `/data`。
      // 把根"修正"回 /data 会让用户以为自己在某个目录里，其实在另一个目录里。
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) return WORKSPACE_ROOT;
  return `${WORKSPACE_ROOT}/${stack.join('/')}`;
}

/**
 * 父路径 + 一个子项名 → 子路径。
 *
 * 目录项名来自服务端的列表，理论上不会有 `/` 或 `..`，但"理论上"不是安全边界：
 * 这里对名字做一次白名单校验，非法就返回 null（等于"这一行不渲染成可点"）。
 */
export function joinWorkspacePath(parent: string, name: string): string | null {
  if (typeof name !== 'string') return null;
  if (name === '' || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || name.includes(NUL)) return null;
  const base = normalizeWorkspacePath(parent);
  if (base === null) return null;
  return `${base}/${name}`;
}

/** 面包屑的一段。`label` 就是路径本身的一段，不做本地化（它是数据不是文案）。 */
export interface WorkspaceCrumb {
  label: string;
  path: string;
  /** 当前目录：不可点（点它等于原地刷新）。 */
  current: boolean;
}

/**
 * 把路径拆成可点的面包屑，第一段固定是根（`data`）。
 *
 * 手机上是"一页一目录"的 push，没有面包屑就只能连点三次返回——上游有实现但没被调用，
 * 我们这里必须用（见 `docs/research/ios-files-spec.md` §3）。
 */
export function workspaceCrumbs(path: string): WorkspaceCrumb[] {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === null) return [];
  const segments = normalized.split('/').filter((segment) => segment !== '');
  // 第一段是 'data'（根），它在界面上的文案就是 'data' —— 与设计稿一致。
  return segments.map((segment, index) => ({
    label: segment,
    path: `/${segments.slice(0, index + 1).join('/')}`,
    current: index === segments.length - 1,
  }));
}

/** 最后一段（根返回 `data`）。用作 push 出来的目录页标题、预览页文件名。 */
export function workspaceBaseName(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === null) return '';
  const segments = normalized.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/** 上一级；根的上一级是 null（界面上不该出现"再往上一级"）。 */
export function workspaceParentPath(path: string): string | null {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === null) return null;
  if (normalized === WORKSPACE_ROOT) return null;
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return null;
  const parent = normalized.slice(0, index);
  return parent === '' ? WORKSPACE_ROOT : parent;
}

/**
 * 中间截断，保留扩展名。
 *
 * RN 的 `numberOfLines={1}` 默认从**尾部**截断，于是一个长文件名最后只剩
 * 「very-long-na…」——扩展名没了，用户分不出这是图片还是脚本。系统文件 App 的做法是
 * 中间截断保留扩展名，RN 没有对应能力，所以按字符预算先截好。
 *
 * 字符预算在比例字体下只是近似值；宁可截短一点（后面还有 numberOfLines 兜一层），
 * 也不要让它真的溢出。
 */
export function truncateMiddle(name: string, max = 34): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  // 扩展名最多 9 个字符（含点）：`.tar.gz` 这种也留得住。
  const hasExtension = dot > 0 && name.length - dot <= 9;
  const extension = hasExtension ? name.slice(dot) : '';
  const budget = max - extension.length - 1;
  if (budget < 4) return `${name.slice(0, max - 1)}…`;
  return `${name.slice(0, budget)}…${extension}`;
}
