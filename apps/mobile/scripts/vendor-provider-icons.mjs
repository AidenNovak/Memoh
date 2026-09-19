#!/usr/bin/env node
/**
 * 把 lobehub 的厂商图标搬进 `assets/images/providers/`。
 *
 * ## 为什么不装 `@lobehub/icons-*` 当依赖
 *
 * 那份包是**整包**的（900+ 个图标、每个厂商三四套变体：字标、彩色版、明/暗各一份），
 * 而我们只要不到 50 个单色版。装进来会把整个目录塞进打包范围，也把一个纯色小图标
 * 变成需要跟版本走的外部依赖。这里做的是**挑出来、复制进来**——离线可用、没有原生依赖、
 * 也不用在运行时从 CDN 拉（这个 App 要能在国内网络下跑）。
 *
 * ## 为什么用 `-static-png` 而不是 `-static-svg`
 *
 * SVG 那份是给 Web 的（`fill="currentColor"`），RN 侧要么引 `react-native-svg`，要么让
 * `expo-image` 走 SVG 解码（多一条解码路径）。PNG 走的是 App 已经在用的那条路。
 *
 * ## 为什么取 `light/`（黑）而不是 `dark/`（白）
 *
 * 两套只差颜色，alpha 完全一样。界面用 `tintColor` 染色（见 `src/ui/ProviderIcon.tsx`），
 * 染色只看 alpha，所以留一套就够——多存一套白的是白白多一倍体积。
 *
 * ## 用法
 *
 *     pnpm --filter @memoh-ios/mobile icons:vendor
 *
 * 清单以 `src/features/chat/providerIcons.ts` 的规则表为准（`tests/provider-icons.test.mjs`
 * 盯着"表里的每个 slug 都有图、每张图都在表里"）。要加一家厂商：先改那张表，再跑这个脚本。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_ICON_SLUGS } from '../src/features/chat/providerIcons.ts';

/** 锁版本：图标是**素材**，跟着上游漂会让每次重跑都产出不同的二进制。 */
const PACKAGE = '@lobehub/icons-static-png';
const VERSION = '1.97.0';
/** 复制哪一套（见文件头：只差 RGB，实际生效的是 alpha）。 */
const VARIANT = 'light';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESTINATION = join(HERE, '..', 'assets', 'images', 'providers');

const workDirectory = mkdtempSync(join(tmpdir(), 'memoh-provider-icons-'));
try {
  console.log(`取 ${PACKAGE}@${VERSION} …`);
  const archive = execFileSync('npm', ['pack', `${PACKAGE}@${VERSION}`], {
    cwd: workDirectory,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  execFileSync('tar', ['xzf', archive], { cwd: workDirectory });

  const source = join(workDirectory, 'package', VARIANT);
  const available = new Set(readdirSync(source));
  const missing = PROVIDER_ICON_SLUGS.filter((slug) => !available.has(`${slug}.png`));
  if (missing.length > 0) {
    // 上游改名/下架时**必须响**：安静地少几张图，表现是"某个厂商在界面上没有图标"，
    // 那种问题只会被用户发现。
    throw new Error(`${PACKAGE}@${VERSION} 里没有这些图标：${missing.join(', ')}`);
  }

  mkdirSync(DESTINATION, { recursive: true });
  for (const slug of PROVIDER_ICON_SLUGS) {
    cpSync(join(source, `${slug}.png`), join(DESTINATION, `${slug}.png`));
  }
  console.log(`写好了 ${PROVIDER_ICON_SLUGS.length} 个图标 → ${DESTINATION}`);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
