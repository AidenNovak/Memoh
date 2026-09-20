/**
 * 文本预览的纯逻辑：拆行、超长行、上限。
 *
 * ## 为什么要设渲染行上限
 *
 * 阈值（512 KiB）管的是"读不读"，不是"画不画"。512 KiB 的日志大约一万行，
 * 一次挂一万个 `Text` 会把滚动直接拖死——这跟列表的 500 行截断是同一个理由。
 * 所以预览再截一层，并在底部**明说**只显示了多少行（不说的话，用户会以为文件就这么长，
 * 那比不给看更糟）。
 *
 * 这一层保持纯函数，不依赖界面。
 */

/**
 * 一次渲染的最大行数。
 *
 * 每行是两个 `Text`（行号 + 内容），800 行 ≈ 1600 个节点——与首页 500 行会话列表
 * （每行 3 个文本节点）同一量级，滚动不掉帧。再往上就该上虚拟化了，那是另一个话题。
 */
export const MAX_PREVIEW_LINES = 800;

/**
 * 单行最大字符数。
 *
 * 长行要横向滚动、**不折行**（折行的代码没法读）。RN 里不折行靠的是"父容器宽度不受限"，
 * 而真正的不受限意味着压缩过的单行 JS（几十万字符）会被当成一个巨型文本节点去排版——
 * 那会直接卡住界面。所以超过这个长度的行按字符截断并加省略号：这是唯一一处
 * "少给一点"，理由是这个量级的单行已经不是人能读的代码了。
 */
export const MAX_LINE_CHARACTERS = 2000;

export interface PreviewText {
  lines: string[];
  /** 因为超过上限而被丢掉的行数（0 = 没截断）。 */
  truncated: number;
}

/**
 * 拆行。
 *
 * - `\r\n` / `\r` 都归成 `\n`：容器里的文件常来自 Windows，留着 `\r` 会在行尾
 *   多出一个看不见的字符。
 * - 结尾的换行不产生一个空行：文件以 `\n` 结尾是惯例，多画一行会让行号对不上。
 */
export function splitPreviewLines(content: string, limit: number = MAX_PREVIEW_LINES): PreviewText {
  const normalized = content.replace(/\r\n?/g, '\n');
  const raw = normalized.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  if (raw.length <= limit) return { lines: raw.map(clampLine), truncated: 0 };
  return { lines: raw.slice(0, limit).map(clampLine), truncated: raw.length - limit };
}

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARACTERS) return line;
  return `${line.slice(0, MAX_LINE_CHARACTERS)}…`;
}

export interface FileContentPayload {
  content: string;
  size: number;
  revision: string;
}

/**
 * 解析 `fs/read` 的响应。
 *
 * 拿不到 `content` 时返回 null（而不是空字符串）：空字符串会渲染成一个"空文件"，
 * 而实际是响应形状不对——两者在屏幕上必须能分辨。
 */
export function parseFileContent(payload: unknown): FileContentPayload | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.content !== 'string') return null;
  return {
    content: record.content,
    size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0,
    revision: typeof record.revision === 'string' ? record.revision : '',
  };
}

export interface StatPayload {
  name: string;
  isDir: boolean;
  size: number;
  modTime: string;
}

/** 解析 `fs`（stat）的响应；形状不对返回 null。 */
export function parseStat(payload: unknown): StatPayload | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  const size = record.size;
  return {
    name,
    isDir: record.isDir === true,
    size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0,
    modTime: typeof record.modTime === 'string' ? record.modTime : '',
  };
}
