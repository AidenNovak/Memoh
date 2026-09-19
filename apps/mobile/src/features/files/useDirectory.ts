/**
 * 一个目录的取数。
 *
 * ## 三态是必须的，而且"读不到"不能长得像"空"
 *
 * 上游在列目录失败时是「toast + 退化成空目录 + 自动重试 3 次」。手机上没有 toast 的位置，
 * 而"退化成空目录"会被读成「这个目录是空的」——一个完全正常的结论，于是用户不会去重试，
 * 只会以为东西没了。所以这里把失败做成**屏幕上的错误行 + 重试**，并把原因带出来。
 *
 * ## 刷新只刷列表
 *
 * 上游会每 2 秒轮询 `fs/read` 的 revision 来发现外部改动（`file-viewer.vue:305`）。
 * 手机上一次读整个文件太贵，而且 `fs/read` 无上限，所以这里不做任何内容轮询：
 * 页面重新获得焦点时刷一次列表（从子目录返回、从预览返回都能落到这里），下拉手动刷。
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../../api/client.ts';
import { presentError, type ErrorPresentation } from '../errors/present.ts';
import { useSession } from '../session/store.tsx';
import { rememberDirectoryCount } from './counts.ts';
import {
  MAX_VISIBLE_ENTRIES,
  parseDirectoryEntries,
  sortEntries,
  visibleEntries,
  type WorkspaceEntry,
} from './entries.ts';

/**
 * 列目录失败。
 *
 * **标题与"下一步"都由这里定，不由屏定**：同一句"列目录失败"，404（这个目录不在了）
 * 与没网（等一下可能就好）要给的动作完全不同。判据在 `features/errors/present.ts`，
 * 这里只补两件它不知道的事：标题写哪一句、以及要不要给"回上一层"。
 */
export interface DirectoryError extends ErrorPresentation {
  /** 用户要能一眼分辨这是故障，不是空目录。 */
  titleKey: string;
  /** 404 时最有用的一步是"回到上一层"，而不是"重试"。 */
  up?: boolean;
}

export type DirectoryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DirectoryView {
  status: DirectoryStatus;
  entries: WorkspaceEntry[];
  /** 还压在"显示更多"后面的条数。 */
  hidden: number;
  error: DirectoryError | null;
  refreshing: boolean;
  reload: () => void;
  loadMore: () => void;
}

type LoadMode = 'initial' | 'refresh';

export function useDirectory(path: string | null, enabled = true): DirectoryView {
  const { state, currentBot } = useSession();
  const client = state.client;
  const botId = currentBot?.id ?? null;

  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [status, setStatus] = useState<DirectoryStatus>('idle');
  const [error, setError] = useState<DirectoryError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [limit, setLimit] = useState(MAX_VISIBLE_ENTRIES);

  /** 只认最后一次请求的结果：快速在两级目录间来回时，先发的响应可能后到。 */
  const requestId = useRef(0);

  const load = useCallback(
    async (mode: LoadMode) => {
      if (path === null || client === null || botId === null) {
        setStatus('idle');
        return;
      }
      const id = requestId.current + 1;
      requestId.current = id;
      if (mode === 'initial') setStatus('loading');
      else setRefreshing(true);

      try {
        const payload = await client.listFiles(botId, path);
        if (requestId.current !== id) return;
        const parsed = parseDirectoryEntries(payload);
        if (parsed === null) {
          // 响应形状不对：不能当成空目录——那会把"协议读错了"伪装成"文件没了"。
          // 而且**不给重试**：同一个请求重发一百次还是同一个形状（规则 R19/R20）。
          setEntries([]);
          setError({
            titleKey: 'files.error.list',
            key: 'error.unreadableResponse',
            recovery: 'none',
          });
          setStatus('error');
          return;
        }
        const sorted = sortEntries(parsed);
        setEntries(sorted);
        setError(null);
        setStatus('ready');
        // 记下来给父级用：项数只有进过这个目录才知道（见 counts.ts）。
        rememberDirectoryCount(path, sorted.length);
      } catch (caught) {
        if (requestId.current !== id) return;
        setError(directoryErrorOf(caught));
        setStatus('error');
      } finally {
        if (requestId.current === id) setRefreshing(false);
      }
    },
    [botId, client, path],
  );

  // 放进 ref：这样下面两个 effect 都不必依赖 load 的身份，避免"依赖一变就重取"。
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setLimit(MAX_VISIBLE_ENTRIES);
    if (!enabled) {
      setStatus('idle');
      return;
    }
    void loadRef.current('initial');
  }, [enabled, path, botId, client]);

  /**
   * 重新获得焦点时刷一次。
   *
   * 首次聚焦跳过：那一次和上面的 mount effect 是同一件事，跑两遍会白白多发一次请求
   * （开发构建里 effect 本来就可能跑两次，这里不必再叠一层）。
   */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      if (!enabled) return;
      void loadRef.current('refresh');
    }, [enabled]),
  );

  const visible = useMemo(() => visibleEntries(entries, limit), [entries, limit]);

  const reload = useCallback(() => void loadRef.current('initial'), []);
  const loadMore = useCallback(() => setLimit((current) => current + MAX_VISIBLE_ENTRIES), []);

  return {
    status,
    entries: visible.visible,
    hidden: visible.hidden,
    error,
    refreshing,
    reload,
    loadMore,
  };
}

/**
 * 404 在这里的含义很具体：**这个目录刚被删或改名了**（不是"网络坏了"）。所以标题换成
 * "这个目录已经不存在了"，并且给"回到上一层"——那里通常还在，用户就能接着干活。
 *
 * 其余一律交给 `presentError`：重试与否、要不要带服务端原文，判据只有那一处。
 */
function directoryErrorOf(caught: unknown): DirectoryError {
  if (caught instanceof ApiError && caught.status === 404) {
    return {
      titleKey: 'files.error.dirMissing',
      key: 'error.notFound',
      recovery: 'none',
      up: true,
    };
  }
  return { titleKey: 'files.error.list', ...presentError(caught) };
}
