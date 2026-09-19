/**
 * 下载能力：这一轮**没有**落盘能力，所以它是一个显式的"不可用"，不是一个死按钮。
 *
 * ## 现状与判断
 *
 * `fs/download` 返回原始字节、无大小上限（`filemanager.go:489`），要落盘再交给
 * QuickLook / 分享。这需要 `expo-file-system` + `expo-sharing`，而 `apps/mobile/package.json`
 * 里没有它们——本轮明确不装新依赖。
 *
 * 于是这里做的是"把能力写成数据"：UI 拿到的是一句**原因**（"下载要落盘，这个版本还没有
 * 文件系统能力"），不是一个点了没反应的按钮。下一轮装上依赖时，只要把 `DOWNLOAD_CAPABILITY`
 * 换成可用、并实现 `DownloadSink` 的那半支，UI 一个字都不用改。
 *
 * `attemptDownload` 仍然完整地走 `client.downloadTarget()`——URL 与鉴权头是原生下载器的
 * 入参，形状在这里定死（`tests/files.test.mjs` 覆盖两条分支）。
 */

export type DownloadCapability = { available: true } | { available: false; reasonKey: string };

/**
 * 本轮的结论。**不要**在没有实现落盘的情况下把它改成 `available: true`——
 * 那会让界面给出一个必然失败的动作。
 */
export const DOWNLOAD_CAPABILITY: DownloadCapability = {
  available: false,
  reasonKey: 'files.download.unavailable',
};

export interface DownloadTarget {
  url: string;
  headers: Record<string, string>;
}

export type DownloadAttempt =
  { ok: true; url: string; headers: Record<string, string> } | { ok: false; reasonKey: string };

/**
 * 试着准备一次下载。
 *
 * `resolveTarget` 是懒的：不可用时**不该**去要 URL（那会白拿一次 token 拼装）。
 */
export function attemptDownload(input: {
  capability: DownloadCapability;
  resolveTarget: () => DownloadTarget;
}): DownloadAttempt {
  if (!input.capability.available) return { ok: false, reasonKey: input.capability.reasonKey };
  const target = input.resolveTarget();
  return { ok: true, url: target.url, headers: target.headers };
}
