# 厂商图标（vendored）

模型选择器分组标题左侧那一排图标。**这些是复制进来的静态资源，不是依赖**：

- 来源：[`@lobehub/icons-static-png@1.97.0`](https://github.com/lobehub/lobe-icons) 的 `light/` 目录，
  MIT License（Copyright © 2023 LobeHub）。图标里的品牌标识归各家厂商所有，仅用于标识对应的服务。
- 只取了**单色**那一套：OpenAI / Anthropic / Claude / xAI / Groq / Ollama 等本就没有彩色版，
  混着来会比统一单色更难看；颜色由界面 `tintColor` 给（见 `src/ui/ProviderIcon.tsx`），
  所以多存一份白色（`dark/`）没有意义——两套的 alpha 完全一样。
- 文件名 = `src/features/chat/providerIcons.ts` 里的 slug。**那张表就是清单**，
  `tests/provider-icons.test.mjs` 会检查"表里的每个 slug 都有图、每张图都在表里"。

重新取（加一家厂商之后）：

```bash
pnpm --filter @memoh-ios/mobile icons:vendor
```

脚本锁了版本（图标是素材，跟着上游漂会让每次重跑产出的二进制都不一样），原始尺寸 640×640，
按上游原样复制、不做二次处理——这样任何人都能用 `npm pack` 逐字节核对。
