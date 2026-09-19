/**
 * 预览页的取数：stat → 分流 → 才决定读不读内容。
 *
 * ## 顺序不能改
 *
 * 1. `fs`（stat）拿 `size` / `isDir`；**404 是"这个文件不存在"的唯一可靠信号**
 *    （`file-viewer.vue:287`），不是"网络坏了"。
 * 2. 按扩展名分流（`kind.ts` 的 `previewPlan`）。
 * 3. 扩展名不可信时才嗅探首字节——嗅探走 `fs/download` 的 `Range` 请求，**只取头部**，
 *    不把文件拉进内存；超过 `SNIFF_LIMIT` 就不嗅探，直接当二进制。
 * 4. 只有结论是"文本"时才 `fs/read`。
 *
 * 反过来（先 read 再判类型）在信息层面已经错了：`fs/read` 会把非法 UTF-8 换成 U+FFFD。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client.ts';
import { presentError, type ErrorPresentation } from '../errors/present.ts';
import { useSession } from '../session/store.tsx';
import { fileKind, previewPlan, sniffBinary, type FileKind, type PreviewPlan } from './kind.ts';
import { workspaceBaseName } from './paths.ts';
import { parseFileContent, parseStat, splitPreviewLines, type StatPayload } from './preview.ts';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** stat 404：文件已被删除或改名。 */
  | { status: 'notFound' }
  /** 见 `features/errors/present.ts`：标题与下一步的判据都来自它。 */
  | ({ status: 'error'; titleKey: string } & ErrorPresentation)
  | { status: 'folder' }
  | { status: 'text'; lines: string[]; truncated: number; size: number }
  /**
   * 图片：不读内容，只把"按这个 URL 取"需要的三样东西交给界面。
   *
   * `headers` 里是鉴权头——`expo-image` 支持带 headers 的 source，所以图片可以**直接**
   * 从服务端流式取，不用先落到 JS 内存里再转 base64（那样 20 MB 的图会先吃掉 20 MB 堆）。
   */
  | { status: 'image'; size: number; uri: string; headers: Record<string, string> }
  | { status: 'binary'; size: number; kind: FileKind; reason: 'extension' | 'sniffed' }
  | { status: 'tooLarge'; size: number; limit: number };

export interface FilePreviewView {
  state: PreviewState;
  reload: () => void;
}

export function useFilePreview(path: string | null, enabled = true): FilePreviewView {
  const { state, currentBot } = useSession();
  const client = state.client;
  const botId = currentBot?.id ?? null;
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (path === null || client === null || botId === null) {
      setPreview({ status: 'idle' });
      return;
    }
    const id = requestId.current + 1;
    requestId.current = id;
    setPreview({ status: 'loading' });

    try {
      const stat = parseStat(await client.statFile(botId, path));
      if (requestId.current !== id) return;
      if (stat === null) {
        // 形状不对不给重试：重发还是同一个形状（规则 R19）。
        setPreview({
          status: 'error',
          titleKey: 'files.error.stat',
          key: 'error.unreadableResponse',
          recovery: 'none',
        });
        return;
      }

      const plan = await resolvePlan(stat, path, (bytes) =>
        readHeadBytes(client.downloadTarget(botId, path), bytes),
      );
      if (requestId.current !== id) return;

      if (plan.kind === 'folder') {
        setPreview({ status: 'folder' });
        return;
      }
      if (plan.kind === 'image') {
        const target = client.downloadTarget(botId, path);
        setPreview({
          status: 'image',
          size: stat.size,
          uri: target.url,
          headers: target.headers,
        });
        return;
      }
      if (plan.kind === 'binary') {
        setPreview({
          status: 'binary',
          size: stat.size,
          // 类型名要给界面用：PDF / 视频 / 压缩包各有各的"为什么不能内嵌"。
          kind: fileKind(stat.name === '' ? workspaceBaseName(path) : stat.name, stat.isDir),
          reason: plan.reason,
        });
        return;
      }
      if (plan.kind === 'too_large') {
        setPreview({ status: 'tooLarge', size: stat.size, limit: plan.limit });
        return;
      }

      const content = parseFileContent(await client.readFile(botId, path));
      if (requestId.current !== id) return;
      if (content === null) {
        setPreview({
          status: 'error',
          titleKey: 'files.error.read',
          key: 'error.unreadableResponse',
          recovery: 'none',
        });
        return;
      }
      const text = splitPreviewLines(content.content);
      setPreview({
        status: 'text',
        lines: text.lines,
        truncated: text.truncated,
        size: content.size > 0 ? content.size : stat.size,
      });
    } catch (caught) {
      if (requestId.current !== id) return;
      if (caught instanceof ApiError && caught.status === 404) {
        setPreview({ status: 'notFound' });
        return;
      }
      setPreview({ status: 'error', titleKey: 'files.error.read', ...presentError(caught) });
    }
  }, [botId, client, path]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setPreview({ status: 'idle' });
      return;
    }
    void loadRef.current();
  }, [enabled, path, botId, client]);

  const reload = useCallback(() => void loadRef.current(), []);

  return { state: preview, reload };
}

/** 分流走完之后的结论：不再有"还要嗅探"这一档。 */
type ResolvedPlan = Exclude<PreviewPlan, { kind: 'sniff' }>;

/**
 * 走完"分流"这一步，必要时嗅探一次。
 *
 * 嗅探失败（网络、Range 被忽略到读不出字节）时**不猜**：当作二进制。猜成文本的代价是
 * 把一堆乱码画到屏幕上，猜成二进制的代价只是少看一次内容——两害相权。
 */
async function resolvePlan(
  stat: StatPayload,
  path: string,
  readHead: (bytes: number) => Promise<'text' | 'binary' | null>,
): Promise<ResolvedPlan> {
  const name = stat.name === '' ? workspaceBaseName(path) : stat.name;
  const first = previewPlan({ name, isDir: stat.isDir, size: stat.size });
  if (first.kind !== 'sniff') return first;
  const sniffed = await readHead(first.bytes);
  if (sniffed === null) return { kind: 'binary', reason: 'extension' };
  const resolved = previewPlan({ name, isDir: stat.isDir, size: stat.size, sniffed });
  // 带了 sniffed 之后不会再回到"还要嗅探"，这里只是把类型收窄。
  if (resolved.kind === 'sniff') return { kind: 'binary', reason: 'extension' };
  return resolved;
}

/**
 * 只取文件头部若干字节。
 *
 * 用 `Range` 请求：`fs/download` 是原始字节流、无上限，而我们只要前 8 KiB。
 * 服务端（Go 的 `http.ServeContent`）支持 Range；万一不支持，返回体也会被
 * `SNIFF_LIMIT` 这一层挡住（超过 1 MiB 的文件根本不会走到这里）。
 */
async function readHeadBytes(
  target: { url: string; headers: Record<string, string> },
  bytes: number,
): Promise<'text' | 'binary' | null> {
  try {
    const response = await fetch(target.url, {
      headers: { ...target.headers, Range: `bytes=0-${bytes - 1}` },
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return sniffBinary(new Uint8Array(buffer)) ? 'binary' : 'text';
  } catch {
    return null;
  }
}
