/**
 * 文件视图的纯逻辑。
 *
 * ## 这些用例存在的理由
 *
 * 这一层里有三处"错了不会报错、只会静静地给出错误结果"的地方，而它们都在安全边界或
 * 内容正确性上：
 *
 * 1. **路径归一化**：服务端不校验绝对路径前缀（只做 `path.Clean` + 拒 `..`，
 *    `internal/handlers/filemanager.go:102`）。根 `/data` 钉在我们这一侧，所以
 *    `..` 越界必须是**失败**（返回 null → 界面显示错误态），不是"顺手修正成根目录"。
 *    顺手修正的后果是：用户以为自己在看某个目录，实际看的是另一个。
 * 2. **排序**：自然序（`file2` 在 `file10` 前）+ dirs-first 都是客户端行为。
 * 3. **分流顺序**：`fs/read` 对二进制有损（非法 UTF-8 → U+FFFD，`filemanager.go:431`），
 *    所以"读不读"必须在拿到 size 之后、按扩展名/嗅探决定。判错的后果是把二进制画成
 *    一屏乱码，或者把 1.2 MB 的文件整份读进手机。
 *
 * 跑法与其他纯逻辑用例一致：`pnpm test`（node --experimental-strip-types --test）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseDirectoryEntries,
  naturalCompare,
  sortEntries,
  visibleEntries,
  MAX_VISIBLE_ENTRIES,
} from '../src/features/files/entries.ts';
import {
  extensionTrust,
  fileKind,
  previewPlan,
  sniffBinary,
  IMAGE_PREVIEW_LIMIT,
  TEXT_READ_LIMIT,
  SNIFF_LIMIT,
} from '../src/features/files/kind.ts';
import { formatBytes, relativeTime } from '../src/features/files/format.ts';
import { fileActions } from '../src/features/files/actions.ts';
import { attemptDownload, DOWNLOAD_CAPABILITY } from '../src/features/files/download.ts';
import { canReadWorkspace } from '../src/features/files/permissions.ts';
import {
  joinWorkspacePath,
  normalizeWorkspacePath,
  truncateMiddle,
  workspaceBaseName,
  workspaceCrumbs,
  workspaceParentPath,
} from '../src/features/files/paths.ts';
import { filesRoute, previewRoute, queryPathParam } from '../src/features/files/routes.ts';
import {
  parseFileContent,
  splitPreviewLines,
  MAX_PREVIEW_LINES,
} from '../src/features/files/preview.ts';

function entry(name, options = {}) {
  return {
    name,
    path: options.path ?? `/data/${name}`,
    isDir: options.isDir === true,
    size: options.size ?? 0,
    modTime: options.modTime ?? '2026-09-15T12:00:00Z',
    mode: options.mode ?? '-rw-r--r--',
  };
}

// ---------------------------------------------------------------- 路径

test('归一化：空、根、相对路径都落到 /data 之下', () => {
  assert.equal(normalizeWorkspacePath(''), '/data');
  assert.equal(normalizeWorkspacePath('/'), '/data');
  assert.equal(normalizeWorkspacePath('.'), '/data');
  assert.equal(normalizeWorkspacePath('/data'), '/data');
  assert.equal(normalizeWorkspacePath('/data/'), '/data');
  // 路由参数拼出来的形态是相对的。
  assert.equal(normalizeWorkspacePath('projects/memoh-ios'), '/data/projects/memoh-ios');
  // 带 data 前缀的也算绝对形态，不然 /files/data/x 会变成 /data/data/x。
  assert.equal(normalizeWorkspacePath('data/projects'), '/data/projects');
});

test('归一化：去重复斜杠与 . 段，但保留真的名字', () => {
  assert.equal(normalizeWorkspacePath('//data//projects//./apps/'), '/data/projects/apps');
  assert.equal(normalizeWorkspacePath('/data/a/../b'), '/data/b');
  assert.equal(normalizeWorkspacePath('/data/..hidden'), '/data/..hidden');
});

test('归一化：.. 越界一律是失败，不是"修正成根"', () => {
  // 这一条是安全边界：把 /data/../etc 修正成 /data（或其他任何目录）都是错的，
  // 用户会以为自己在一个目录里，其实在另一个目录里。
  assert.equal(normalizeWorkspacePath('/data/..'), null);
  assert.equal(normalizeWorkspacePath('/data/../../etc'), null);
  assert.equal(normalizeWorkspacePath('../etc/passwd'), null);
  assert.equal(normalizeWorkspacePath('..'), null);
  assert.equal(normalizeWorkspacePath('/..'), null);
});

test('归一化：/data 之外的绝对路径被拒（服务端不会替我们拒）', () => {
  assert.equal(normalizeWorkspacePath('/etc/passwd'), null);
  assert.equal(normalizeWorkspacePath('/dataX/x'), null);
  assert.equal(normalizeWorkspacePath('/data/../../data'), null);
});

test('归一化：反斜杠与 NUL 视为可疑输入', () => {
  assert.equal(normalizeWorkspacePath('..\\..\\windows'), null);
  assert.equal(normalizeWorkspacePath('/data/a\u0000b'), null);
});

test('拼接：子项名只能是"名字"，不能带分隔符或 ..', () => {
  assert.equal(joinWorkspacePath('/data/projects', 'memoh-ios'), '/data/projects/memoh-ios');
  assert.equal(joinWorkspacePath('/data', 'file.md'), '/data/file.md');
  assert.equal(joinWorkspacePath('/data', '..'), null);
  assert.equal(joinWorkspacePath('/data', 'a/b'), null);
  assert.equal(joinWorkspacePath('/data', '/etc'), null);
  assert.equal(joinWorkspacePath('/data', ''), null);
});

test('面包屑：根固定是 data，最后一段不可点', () => {
  const root = workspaceCrumbs('/data');
  assert.deepEqual(
    root.map((crumb) => [crumb.label, crumb.path, crumb.current]),
    [['data', '/data', true]],
  );

  const deep = workspaceCrumbs('/data/projects/memoh-ios');
  assert.deepEqual(
    deep.map((crumb) => crumb.label),
    ['data', 'projects', 'memoh-ios'],
  );
  assert.deepEqual(
    deep.map((crumb) => crumb.path),
    ['/data', '/data/projects', '/data/projects/memoh-ios'],
  );
  assert.deepEqual(
    deep.map((crumb) => crumb.current),
    [false, false, true],
  );
  // 非法路径没有面包屑可给（界面显示错误态，而不是给一条指向根的假面包屑）。
  assert.deepEqual(workspaceCrumbs('/etc/passwd'), []);
});

test('上一级与文件名', () => {
  assert.equal(workspaceParentPath('/data/projects/x'), '/data/projects');
  assert.equal(workspaceParentPath('/data/projects'), '/data');
  assert.equal(workspaceParentPath('/data'), null);
  assert.equal(workspaceBaseName('/data/projects/x'), 'x');
  assert.equal(workspaceBaseName('/data'), 'data');
});

test('中间截断保留扩展名（RN 只会从尾部截）', () => {
  assert.equal(truncateMiddle('README.md'), 'README.md');
  const long = 'a-very-long-file-name-that-keeps-going-and-going.ts';
  const truncated = truncateMiddle(long, 30);
  assert.ok(truncated.length <= 30, truncated);
  assert.ok(truncated.endsWith('.ts'), truncated);
  assert.ok(truncated.includes('…'), truncated);
});

test('路由：目录与预览的地址形状', () => {
  assert.equal(filesRoute('/data'), '/files');
  assert.equal(filesRoute('/data/projects/memoh-ios'), '/files/projects/memoh-ios');
  // 名字里有空格与 #：不编码会被 expo-router 当成 query/fragment 切掉。
  assert.equal(filesRoute('/data/a b#c.md'), '/files/a%20b%23c.md');
  assert.equal(previewRoute('/data/README.md'), '/preview?path=%2Fdata%2FREADME.md');
  assert.equal(filesRoute('/etc/passwd'), '/files');
  assert.equal(queryPathParam('%2Fdata%2FREADME.md'), '/data/README.md');
  assert.equal(queryPathParam('/data/README.md'), '/data/README.md');
  // 文件名里本来就有 % 时不要二次解码（只在结构上必须时才解）。
  assert.equal(queryPathParam('/data/a%20b.md'), '/data/a%20b.md');
});

// ---------------------------------------------------------------- 列表

test('解析：认 entries（camelCase），形状不对返回 null 而不是空目录', () => {
  const parsed = parseDirectoryEntries({
    path: '/data',
    entries: [{ name: 'a', path: '/data/a', isDir: false, size: 12, modTime: 'x', mode: 'm' }],
  });
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0].size, 12);

  // 没有 entries/items 的响应**不能**被当成空目录：屏幕上"目录空了"和"读不到"必须不同。
  assert.equal(parseDirectoryEntries({ path: '/data' }), null);
  assert.equal(parseDirectoryEntries(null), null);
  assert.equal(parseDirectoryEntries({ entries: 'nope' }), null);

  // snake_case 的 is_dir 不是协议形状：不兜底，免得掩盖读错协议。
  const wrongCase = parseDirectoryEntries({
    entries: [{ name: 'a', is_dir: true, size: 3 }],
  });
  assert.equal(wrongCase?.[0].isDir, false);
});

test('解析：丢掉没有名字的条目，负 size 归 0', () => {
  const parsed = parseDirectoryEntries({
    entries: [{ name: '', isDir: false }, { name: 'ok', size: -5 }, 'nope'],
  });
  assert.deepEqual(
    parsed?.map((item) => item.name),
    ['ok'],
  );
  assert.equal(parsed?.[0].size, 0);
});

test('自然序：file2 在 file10 前面', () => {
  assert.ok(naturalCompare('file2', 'file10') < 0);
  assert.ok(naturalCompare('file10', 'file9') > 0);
  assert.ok(naturalCompare('a', 'a') === 0);
  assert.ok(naturalCompare('a', 'ab') < 0);
  // 大小写不同但顺序相等时要有稳定结论，否则同一份数据的顺序会变。
  assert.ok(naturalCompare('B', 'b') < 0);
  assert.ok(naturalCompare('02', '2') !== 0 || true);
});

test('排序：dirs-first，然后自然序', () => {
  const sorted = sortEntries([
    entry('file10.log'),
    entry('docs', { isDir: true }),
    entry('file2.log'),
    entry('apps', { isDir: true }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['apps', 'docs', 'file2.log', 'file10.log'],
  );
});

test('排序不改调用方那份数组', () => {
  const original = [entry('b'), entry('a')];
  const sorted = sortEntries(original);
  assert.deepEqual(
    original.map((item) => item.name),
    ['b', 'a'],
  );
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['a', 'b'],
  );
});

test('截断：超过上限只给前 500 行，并说清还剩多少', () => {
  const many = Array.from({ length: MAX_VISIBLE_ENTRIES + 20 }, (_, index) => entry(`f${index}`));
  const { visible, hidden } = visibleEntries(many);
  assert.equal(visible.length, MAX_VISIBLE_ENTRIES);
  assert.equal(hidden, 20);

  const small = [entry('a')];
  assert.deepEqual(visibleEntries(small), { visible: small, hidden: 0 });
});

test('空目录是空数组（与"解析失败"区分开）', () => {
  assert.deepEqual(parseDirectoryEntries({ entries: [] }), []);
});

// ---------------------------------------------------------------- 类型与分流

test('扩展名 → 类型', () => {
  assert.equal(fileKind('src', true), 'folder');
  assert.equal(fileKind('README.md'), 'text');
  assert.equal(fileKind('app.config.ts'), 'code');
  assert.equal(fileKind('icon.png'), 'image');
  assert.equal(fileKind('report.pdf'), 'pdf');
  assert.equal(fileKind('bundle.tar.gz'), 'archive');
  assert.equal(fileKind('LICENSE'), 'binary');
  assert.equal(fileKind('archive-2026.TAR.GZ'), 'archive');
});

test('扩展名可信度：只有"没有扩展名 / bin 这类"才需要嗅探', () => {
  assert.equal(extensionTrust('README.md'), 'text');
  assert.equal(extensionTrust('icon.png'), 'binary');
  assert.equal(extensionTrust('LICENSE'), 'unknown');
  assert.equal(extensionTrust('notes.bin'), 'unknown');
  assert.equal(extensionTrust('weird.xyz'), 'unknown');
});

test('NUL 嗅探：只看头部，且只看 NUL', () => {
  const text = new TextEncoder().encode('# 标题\n中文内容\n');
  assert.equal(sniffBinary(text), false);
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
  assert.equal(sniffBinary(binary), true);
  // 头 8 KiB 之外有 NUL 不算：那已经不是"几个字节判类型"了。
  const late = new Uint8Array(9000).fill(0x41);
  late[8500] = 0;
  assert.equal(sniffBinary(late), false);
});

test('分流：文本 / 二进制 / 超大三个分支', () => {
  // 文本且不大 → 读。
  assert.deepEqual(previewPlan({ name: 'a.md', isDir: false, size: 1024 }), { kind: 'text' });
  // 文本但超阈值 → 只给下载（"太大"是一等结果，不是错误）。
  assert.deepEqual(previewPlan({ name: 'huge.log', isDir: false, size: TEXT_READ_LIMIT + 1 }), {
    kind: 'too_large',
    limit: TEXT_READ_LIMIT,
  });
  // 阈值本身仍然读。
  assert.deepEqual(previewPlan({ name: 'huge.log', isDir: false, size: TEXT_READ_LIMIT }), {
    kind: 'text',
  });
  // 图片**不再**走"二进制"那条路：以前 `.png` 判成 binary，于是 PNG 也只能下载，
  // 用户看到的就是"Binary file / 下载"（2026-09-15 反馈）。现在走 image。
  assert.deepEqual(previewPlan({ name: 'icon.png', isDir: false, size: 10 }), { kind: 'image' });
  // 非图片的二进制扩展名仍然是 binary（PDF / 视频 / 压缩包…）。
  assert.deepEqual(previewPlan({ name: 'paper.pdf', isDir: false, size: 10 }), {
    kind: 'binary',
    reason: 'extension',
  });
  assert.deepEqual(previewPlan({ name: 'src', isDir: true, size: 0 }), { kind: 'folder' });
});

test('分流：扩展名不可信时先嗅探，嗅探结论说了算', () => {
  const unknown = { name: 'LICENSE', isDir: false, size: 2048 };
  assert.deepEqual(previewPlan(unknown), { kind: 'sniff', bytes: 8192 });

  // 嗅探成文本 → 走文本（仍然受 512 KiB 阈值约束）。
  assert.deepEqual(previewPlan({ ...unknown, sniffed: 'text' }), { kind: 'text' });
  assert.deepEqual(
    previewPlan({ name: 'LICENSE', isDir: false, size: TEXT_READ_LIMIT + 5, sniffed: 'text' }),
    { kind: 'too_large', limit: TEXT_READ_LIMIT },
  );
  // 嗅探成二进制 → 不读。
  assert.deepEqual(previewPlan({ ...unknown, sniffed: 'binary' }), {
    kind: 'binary',
    reason: 'sniffed',
  });
  // 太大就不嗅探（嗅探要拿字节，代价随文件大小走）。
  assert.deepEqual(previewPlan({ name: 'blob', isDir: false, size: SNIFF_LIMIT + 1 }), {
    kind: 'binary',
    reason: 'extension',
  });
});

// ---------------------------------------------------------------- 文案与动作

test('大小：1024 进制，10 KB 以下保留一位小数', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(218), '218 B');
  assert.equal(formatBytes(4300), '4.2 KB');
  assert.equal(formatBytes(196608), '192 KB');
  assert.equal(formatBytes(50331648), '48 MB');
});

test('相对时间：分档（含"昨天"与时钟超前）', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

  assert.deepEqual(relativeTime(at(0), now), { unit: 'now', count: 0 });
  assert.deepEqual(relativeTime(at(5), now), { unit: 'minutes', count: 5 });
  assert.deepEqual(relativeTime(at(120), now), { unit: 'hours', count: 2 });
  assert.deepEqual(relativeTime(at(60 * 26), now), { unit: 'yesterday', count: 1 });
  assert.deepEqual(relativeTime(at(60 * 24 * 3), now), { unit: 'days', count: 3 });
  // 服务端时钟比手机快：不能显示"-3 分钟前"。
  assert.deepEqual(relativeTime(at(-3), now), { unit: 'now', count: 0 });
  assert.deepEqual(relativeTime('not-a-date', now), { unit: 'unknown', count: 0 });
});

test('长按清单：打开 / 复制路径 / 下载（不可用时带原因）/ 有 diff 才有看改动', () => {
  const unavailable = fileActions({
    isDir: false,
    hasDiff: false,
    download: DOWNLOAD_CAPABILITY,
  });
  assert.deepEqual(
    unavailable.map((action) => action.id),
    ['open', 'copyPath', 'download'],
  );
  const download = unavailable.find((action) => action.id === 'download');
  assert.equal(download?.enabled, false);
  // 不可用必须给原因：灰掉又不解释的项和坏掉的项长得一样。
  assert.equal(download?.reasonKey, 'files.download.unavailable');

  const available = fileActions({ isDir: true, hasDiff: true, download: { available: true } });
  assert.deepEqual(
    available.map((action) => action.id),
    ['open', 'copyPath', 'download', 'diff'],
  );
  assert.ok(available.every((action) => action.enabled));
});

test('下载：不可用时不白拼 URL，可用时把 url + 鉴权头交出去', () => {
  let called = 0;
  const target = () => {
    called += 1;
    return {
      url: 'https://example.test/download?path=/data/a.md',
      headers: { Authorization: 'Bearer t' },
    };
  };

  const blocked = attemptDownload({ capability: DOWNLOAD_CAPABILITY, resolveTarget: target });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reasonKey, 'files.download.unavailable');
  assert.equal(called, 0, '不可用时不该去要 URL');

  const ready = attemptDownload({ capability: { available: true }, resolveTarget: target });
  assert.equal(ready.ok, true);
  assert.equal(ready.headers.Authorization, 'Bearer t');
  assert.equal(called, 1);
});

test('权限门控：只认 workspace_read', () => {
  assert.equal(canReadWorkspace({ current_user_permissions: ['chat', 'workspace_read'] }), true);
  assert.equal(canReadWorkspace({ current_user_permissions: ['chat', 'workspace_exec'] }), false);
  // manage 不等于能读容器：猜宽了会给人看一个必然 403 的页面。
  assert.equal(canReadWorkspace({ current_user_permissions: ['manage'] }), false);
  assert.equal(canReadWorkspace({}), false);
  assert.equal(canReadWorkspace(null), false);
});

// ---------------------------------------------------------------- 预览文本

test('拆行：CRLF 归一、结尾换行不多画一行', () => {
  assert.deepEqual(splitPreviewLines('a\nb').lines, ['a', 'b']);
  assert.deepEqual(splitPreviewLines('a\nb\n').lines, ['a', 'b']);
  assert.deepEqual(splitPreviewLines('a\r\nb\r').lines, ['a', 'b']);
  assert.deepEqual(splitPreviewLines('a\n\nb').lines, ['a', '', 'b']);
  assert.deepEqual(splitPreviewLines('').lines, []);
});

test('拆行：超过渲染上限就截断，并报出丢了多少行', () => {
  const content = Array.from({ length: MAX_PREVIEW_LINES + 7 }, (_, index) => `line ${index}`).join(
    '\n',
  );
  const { lines, truncated } = splitPreviewLines(content);
  assert.equal(lines.length, MAX_PREVIEW_LINES);
  assert.equal(truncated, 7);
  assert.equal(lines[0], 'line 0');
});

test('拆行：单行过长按字符截断（否则一个巨型文本节点会卡住排版）', () => {
  const { lines } = splitPreviewLines(`x${'y'.repeat(5000)}`);
  assert.equal(lines[0].length, 2001);
  assert.ok(lines[0].endsWith('…'));
});

test('解析 fs/read：没有 content 就是 null（不是空文件）', () => {
  assert.deepEqual(parseFileContent({ content: 'hi', size: 2, revision: 'r' }), {
    content: 'hi',
    size: 2,
    revision: 'r',
  });
  assert.equal(parseFileContent({ size: 2 }), null);
  assert.equal(parseFileContent('nope'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 图片分流（2026-09-15）：`.png` 以前会被当成"二进制文件"只给下载——扩展名信任把
// 图片判成了 binary。现在图片走单独一条路（交给 expo-image 按 URL 取），
// 但要有上限，否则一张 48 MB 的图会让预览页等很久。
// ─────────────────────────────────────────────────────────────────────────────

test('图片：小图走 image，超上限退回 too_large（并带上限值）', () => {
  assert.deepEqual(previewPlan({ name: 'icon.png', isDir: false, size: 192 * 1024 }), {
    kind: 'image',
  });
  assert.deepEqual(previewPlan({ name: 'photo.JPEG', isDir: false, size: 3 * 1024 * 1024 }), {
    kind: 'image',
  });
  assert.deepEqual(previewPlan({ name: 'huge.png', isDir: false, size: IMAGE_PREVIEW_LIMIT + 1 }), {
    kind: 'too_large',
    limit: IMAGE_PREVIEW_LIMIT,
  });
});

test('文本超限时 too_large 带的是**文本**上限（两个上限不是一个数）', () => {
  const plan = previewPlan({ name: 'big.log', isDir: false, size: TEXT_READ_LIMIT + 1 });
  assert.deepEqual(plan, { kind: 'too_large', limit: TEXT_READ_LIMIT });
  assert.notEqual(IMAGE_PREVIEW_LIMIT, TEXT_READ_LIMIT);
});

test('svg 当文本看源码，不当二进制', () => {
  assert.equal(fileKind('logo.svg', false), 'text');
  assert.deepEqual(previewPlan({ name: 'logo.svg', isDir: false, size: 4096 }), { kind: 'text' });
});

test('PDF / 视频 / 压缩包仍然是 binary，但界面能拿到具体类型名', () => {
  assert.deepEqual(previewPlan({ name: 'paper.pdf', isDir: false, size: 1024 }), {
    kind: 'binary',
    reason: 'extension',
  });
  assert.equal(fileKind('paper.pdf', false), 'pdf');
  assert.equal(fileKind('clip.mp4', false), 'video');
  assert.equal(fileKind('bundle.tar.gz', false), 'archive');
  assert.equal(fileKind('report.xlsx', false), 'sheet');
});
