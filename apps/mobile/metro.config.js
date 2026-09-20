const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// 多个 worktree 共享 Metro 缓存时会互相污染（Expo 的 DOM transform 会把绝对路径
// 内联进产物）。把 __dirname 混进 cacheVersion 是这一行的全部目的。
config.cacheVersion = (config.cacheVersion ?? '') + ':' + __dirname;

// `@memoh-ios/kit` 是 `apps/mobile/modules/memoh-kit` 的 workspace 包
// （见 pnpm-workspace.yaml），由 pnpm 链接进 node_modules——Metro 走默认解析即可，
// 这里不需要 extraNodeModules 手工指路。

module.exports = config;
