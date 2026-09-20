/**
 * 文件类型判定：图标、颜色、以及**要不要读内容**。
 *
 * ## 判定顺序是这个模块存在的全部理由
 *
 * `fs/read` 无大小限制，而且对二进制是**有损**的（非法 UTF-8 字节被换成 U+FFFD，
 * `filemanager.go:431`）。所以：
 *
 *   stat 拿 size → 按扩展名分流 → 扩展名不可信时嗅探首字节 → 才决定读不读。
 *
 * 反过来做（先读再判类型）在信息层面已经错了：等我们拿到内容时，二进制早就变成
 * 一串 U+FFFD 了，再判也判不出来。
 *
 * 「太大」是一等结果，不是错误：给出原因 + 下载入口就是正确的降级。
 *
 * 这一层保持纯函数（`fileTint` 只是查表）。
 */

import type { SFSymbol } from 'expo-symbols';

export type FileKind =
  'folder' | 'text' | 'code' | 'image' | 'pdf' | 'archive' | 'audio' | 'video' | 'sheet' | 'binary';

/** 文本预览上限（`docs/research/ios-files-spec.md` §9.1：手感与流量的折中，可推翻）。 */
export const TEXT_READ_LIMIT = 512 * 1024;

/** 嗅探只取头部这么多字节：超过它就不是"几个字节判类型"了。 */
export const SNIFF_BYTES = 8 * 1024;

/** 超过这个大小就不嗅探（要拿字节就得走 download，大文件不能进内存）。 */
export const SNIFF_LIMIT = 1024 * 1024;

/**
 * 内嵌预览图片的上限。
 *
 * 服务端的 `fs/download` **没有上限**，而图片预览是让 `expo-image` 直接按 URL 去取
 * （带鉴权头，不经过 JS 内存）。所以这个上限不是为了内存，而是为了**等待时间**：
 * 一张 48 MB 的图在移动网络上要拉很久，而用户以为"点一下就该看到"。
 * 超过就退回"给原因 + 下载"，和文本那条路一致。
 */
export const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'xml',
  'svg',
  'plist',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'sql',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'lock',
  'patch',
  'diff',
  'gitignore',
  'dockerignore',
  'editorconfig',
  'pem',
  'crt',
  'tex',
  'rst',
  'org',
]);

const CODE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'py',
  'pyi',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'cs',
  'php',
  'lua',
  'r',
  'scala',
  'dart',
  'vue',
  'svelte',
  'ex',
  'exs',
  'erl',
  'hs',
  'pl',
  'pm',
  'm',
  'mm',
  'gradle',
  'groovy',
  'proto',
  'graphql',
  'gql',
  'tf',
  'hcl',
  'makefile',
  'cmake',
]);

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'heif',
  'bmp',
  'tiff',
  'tif',
  'ico',
  'avif',
]);

const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  '7z',
  'rar',
  'jar',
  'apk',
  'ipa',
  'dmg',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'oga',
  'opus',
  'aiff',
]);

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']);

const SHEET_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'pages',
  'numbers',
  'key',
  'rtf',
]);

/** 小写扩展名（不含点）。没有扩展名、或者以点结尾时返回空串。 */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** 按名字（目录优先）分到一种类型。未知扩展名归到 `binary`：宁可给下载，也不要赌它是文本。 */
export function fileKind(name: string, isDir: boolean): FileKind {
  if (isDir) return 'folder';
  const extension = fileExtension(name);
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (SHEET_EXTENSIONS.has(extension)) return 'sheet';
  if (extension === 'pdf') return 'pdf';
  return 'binary';
}

const SYMBOLS: Record<FileKind, SFSymbol> = {
  folder: 'folder.fill',
  text: 'doc.text.fill',
  code: 'curlybraces',
  image: 'photo.fill',
  pdf: 'doc.richtext.fill',
  archive: 'archivebox.fill',
  audio: 'waveform',
  video: 'film.fill',
  sheet: 'tablecells.fill',
  binary: 'doc.fill',
};

/** SF Symbol 名。按类型着色是这个视图的读法：一眼分出文件夹 / 图片 / 代码。 */
export function fileSymbol(kind: FileKind): SFSymbol {
  return SYMBOLS[kind];
}

/**
 * 图标底块的颜色。
 *
 * 用 iOS 系统色（浅色一套、深色一套），不用品牌紫：这是"类型"的语义色，
 * 全站唯一的强调色留给真正的动作（见 `docs/research/memoh-design-baseline.md` §2）。
 *
 * ## 三种类型换成了"深一档"的同色系（2026-09-17）
 *
 * 瓦片里放的是**白色** SF Symbol（`FilesScreen` 的 `tintColor="#FFFFFF"`），所以这里的
 * 底色要满足的判据是"白符号 vs 底色 ≥ 3:1"（WCAG 1.4.11 对非文字图形的下限）。
 * iOS 系统色里有三个是**浅色系**，白符号压上去只有 2.0–2.6:1：
 *
 * | 类型 | 改前（浅/深） | 改前对比度 | 改后（浅/深） | 改后对比度 |
 * | --- | --- | --- | --- | --- |
 * | code | `#34C759` / `#30D158` | 2.22 / 2.02 | `#248A3D` / `#2E9E55` | 4.40 / 3.42 |
 * | image | `#FF9500` / `#FF9F0A` | 2.20 / 2.06 | `#C93400` / `#D9481A` | 5.28 / 4.29 |
 * | sheet | `#30B0C7` / `#40C8E0` | 2.57 / 1.99 | `#1F7A8C` / `#2A93A8` | 4.98 / 3.60 |
 *
 * 对比度按 WCAG 相对亮度公式算（`(L1+0.05)/(L2+0.05)`，底色 vs 白）。改后都在 3.4:1
 * 以上，留了余量给截图的色彩管理偏差；色相没变（还是绿/橙/青），所以"一眼分类型"
 * 这个读法不受影响。深色一套改后仍比浅色一套**略亮**——那是 iOS 深色模式的惯例
 * （深底上要更亮的色块才认得出），不是因为对比度不够。
 *
 * 其余七类当时就达标，没动：text 4.02/3.65、pdf 3.55/3.41、archive 4.13/3.52、
 * audio 5.65/5.06、video 3.65/3.52、folder（灰）3.26/3.26。
 */
const TINTS: Record<FileKind, { light: string; dark: string }> = {
  folder: { light: '#8E8E93', dark: '#8E8E93' },
  text: { light: '#007AFF', dark: '#0A84FF' },
  code: { light: '#248A3D', dark: '#2E9E55' },
  image: { light: '#C93400', dark: '#D9481A' },
  pdf: { light: '#FF3B30', dark: '#FF453A' },
  archive: { light: '#AF52DE', dark: '#BF5AF2' },
  audio: { light: '#5856D6', dark: '#5E5CE6' },
  video: { light: '#FF2D55', dark: '#FF375F' },
  sheet: { light: '#1F7A8C', dark: '#2A93A8' },
  binary: { light: '#8E8E93', dark: '#8E8E93' },
};

export function fileTint(kind: FileKind, scheme: 'light' | 'dark'): string {
  return TINTS[kind][scheme];
}

/**
 * 扩展名可信到什么程度。
 *
 * `unknown` = 没有扩展名、或者扩展名不在任何一张表里（`bin` 之类）。
 * 只有 `unknown` 才值得去嗅探首字节——有扩展名时它更可信，也省一次网络请求。
 */
export function extensionTrust(name: string): 'text' | 'binary' | 'unknown' {
  const extension = fileExtension(name);
  if (extension === '') return 'unknown';
  if (extension === 'bin' || extension === 'dat' || extension === 'raw') return 'unknown';
  const kind = fileKind(name, false);
  if (kind === 'binary') return 'unknown';
  if (kind === 'text' || kind === 'code') return 'text';
  return 'binary';
}

/**
 * 首字节嗅探：出现 NUL 就认为是二进制。
 *
 * 这是"扩展名不可信"时的判据，也是唯一被允许的判据——**绝不用 `fs/read` 的结果反推
 * 类型**，那条路的信息在读到内容那一刻就已经丢了。
 */
export function sniffBinary(bytes: Uint8Array, limit: number = SNIFF_BYTES): boolean {
  const end = Math.min(bytes.length, limit);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/**
 * 预览分流的结果。
 *
 * `sniff` 是唯一一个"还需要一步才能定"的状态：调用方去拿前面那几个字节，再带着
 * `sniffed` 回来问一次。
 */
export type PreviewPlan =
  | { kind: 'folder' }
  | { kind: 'text' }
  /** 图片：不读内容，交给 `expo-image` 按 URL 取（见 `IMAGE_PREVIEW_LIMIT`）。 */
  | { kind: 'image' }
  | { kind: 'binary'; reason: 'extension' | 'sniffed' }
  /** 超过上限——带上限值，因为文本和图片的上限不是同一个数。 */
  | { kind: 'too_large'; limit: number }
  | { kind: 'sniff'; bytes: number };

export interface PreviewInput {
  name: string;
  isDir: boolean;
  size: number;
  /** 已经嗅探过首字节时的结论；没嗅探过就是 undefined。 */
  sniffed?: 'text' | 'binary';
}

export function previewPlan(input: PreviewInput): PreviewPlan {
  if (input.isDir) return { kind: 'folder' };

  // 图片走**另一条路**，且必须放在"扩展名信任"之前：`.png` 的 trust 是 `binary`，
  // 那条分支会把它当"二进制文件"打发掉——这正是"PNG 也只给下载"的由来。
  if (fileKind(input.name, false) === 'image') {
    if (input.size > IMAGE_PREVIEW_LIMIT) {
      return { kind: 'too_large', limit: IMAGE_PREVIEW_LIMIT };
    }
    return { kind: 'image' };
  }

  const trust = extensionTrust(input.name);

  if (trust === 'unknown') {
    if (input.sniffed === undefined) {
      // 太大就不嗅探：嗅探要拿字节，而拿字节的代价随文件大小走。
      if (input.size > SNIFF_LIMIT) return { kind: 'binary', reason: 'extension' };
      return { kind: 'sniff', bytes: SNIFF_BYTES };
    }
    if (input.sniffed === 'binary') return { kind: 'binary', reason: 'sniffed' };
    if (input.size > TEXT_READ_LIMIT) return { kind: 'too_large', limit: TEXT_READ_LIMIT };
    return { kind: 'text' };
  }

  if (trust === 'binary') return { kind: 'binary', reason: 'extension' };
  if (input.size > TEXT_READ_LIMIT) return { kind: 'too_large', limit: TEXT_READ_LIMIT };
  return { kind: 'text' };
}
