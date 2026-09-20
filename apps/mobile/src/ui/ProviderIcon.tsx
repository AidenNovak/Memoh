/**
 * 厂商图标（模型选择器分组标题左侧那颗）。
 *
 * ## 为什么是单色 + `tintColor`
 *
 * 图标资源来自 lobehub（MIT，见 `assets/images/providers/README.md`）。有几家（OpenAI、
 * Anthropic、Claude、xAI、Groq、Ollama）**没有彩色版**，而它们恰好最常见——混着画会变成
 * "有的彩色有的黑白"。所以统一用单色那套，再染成和分组标题**同一个颜色**
 * （`secondaryLabel`）：AI HIG 下，分组标题旁边一颗纯黑的厂商标会比标题本身还重，
 * 看起来像另一条信息；同色之后它是标题的一部分。
 *
 * ## 认不出的厂商不留白
 *
 * Memoh 是自托管的，用户接任何厂商/网关/中转都合理。认不出时给一颗中性的 glyph
 * （SF Symbol `cpu`，同样是线性、同样染色），**不是空白**：留白会让分组标题看起来像
 * 少画了一块，而"没画完"和"这家我们不认识"是两件事。用 SF Symbol 而不是自绘一个问号，
 * 是因为系统图标就在旁边（同一屏的勾、⌄、返回箭头），系统的重量天然对得上。
 *
 * ## 为什么 testID 要给"外面那层"
 *
 * 图标是装饰，VoiceOver 不该念它；但验收要能断言"这一组旁边确实有图标/确实是默认兜底"，
 * 所以外面包一层只有 testID 的 `View`（纯容器不是无障碍元素，VoiceOver 本来就跳过），
 * 里面那颗图标按仓库惯例 `accessibilityElementsHidden`。
 */
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { View } from 'react-native';

import { providerIconSlug, type ProviderIconSlug } from '../features/chat/providerIcons.ts';
import { usePalette } from '../lib/theme/context.tsx';

/**
 slug → 打进来的资源。**必须是静态 `require` 字面量**：Metro 只认字面量，拼字符串它找不到文件。
 用 `Record<ProviderIconSlug, number>` 兜住完整性——加了 slug 忘了加图，`pnpm typecheck` 会先红。
 */
const PROVIDER_ICONS: Record<ProviderIconSlug, number> = {
  openai: require('../../assets/images/providers/openai.png'),
  anthropic: require('../../assets/images/providers/anthropic.png'),
  claude: require('../../assets/images/providers/claude.png'),
  google: require('../../assets/images/providers/google.png'),
  gemini: require('../../assets/images/providers/gemini.png'),
  googlecloud: require('../../assets/images/providers/googlecloud.png'),
  vertexai: require('../../assets/images/providers/vertexai.png'),
  azureai: require('../../assets/images/providers/azureai.png'),
  bedrock: require('../../assets/images/providers/bedrock.png'),
  xai: require('../../assets/images/providers/xai.png'),
  meta: require('../../assets/images/providers/meta.png'),
  mistral: require('../../assets/images/providers/mistral.png'),
  cohere: require('../../assets/images/providers/cohere.png'),
  nvidia: require('../../assets/images/providers/nvidia.png'),
  groq: require('../../assets/images/providers/groq.png'),
  together: require('../../assets/images/providers/together.png'),
  fireworks: require('../../assets/images/providers/fireworks.png'),
  cerebras: require('../../assets/images/providers/cerebras.png'),
  deepinfra: require('../../assets/images/providers/deepinfra.png'),
  replicate: require('../../assets/images/providers/replicate.png'),
  huggingface: require('../../assets/images/providers/huggingface.png'),
  cloudflare: require('../../assets/images/providers/cloudflare.png'),
  openrouter: require('../../assets/images/providers/openrouter.png'),
  perplexity: require('../../assets/images/providers/perplexity.png'),
  openwebui: require('../../assets/images/providers/openwebui.png'),
  dify: require('../../assets/images/providers/dify.png'),
  newapi: require('../../assets/images/providers/newapi.png'),
  fastgpt: require('../../assets/images/providers/fastgpt.png'),
  ollama: require('../../assets/images/providers/ollama.png'),
  lmstudio: require('../../assets/images/providers/lmstudio.png'),
  vllm: require('../../assets/images/providers/vllm.png'),
  xinference: require('../../assets/images/providers/xinference.png'),
  deepseek: require('../../assets/images/providers/deepseek.png'),
  kimi: require('../../assets/images/providers/kimi.png'),
  moonshot: require('../../assets/images/providers/moonshot.png'),
  qwen: require('../../assets/images/providers/qwen.png'),
  zhipu: require('../../assets/images/providers/zhipu.png'),
  minimax: require('../../assets/images/providers/minimax.png'),
  siliconcloud: require('../../assets/images/providers/siliconcloud.png'),
  doubao: require('../../assets/images/providers/doubao.png'),
  volcengine: require('../../assets/images/providers/volcengine.png'),
  hunyuan: require('../../assets/images/providers/hunyuan.png'),
  tencent: require('../../assets/images/providers/tencent.png'),
  baidu: require('../../assets/images/providers/baidu.png'),
  spark: require('../../assets/images/providers/spark.png'),
  stepfun: require('../../assets/images/providers/stepfun.png'),
  yi: require('../../assets/images/providers/yi.png'),
  baichuan: require('../../assets/images/providers/baichuan.png'),
};

/** 认不出厂商时的中性 glyph（线性、可染色，和旁边的系统图标同一种画法）。 */
const FALLBACK_SYMBOL = 'cpu';

export function ProviderIcon({ name, size = 16 }: { name: string; size?: number }) {
  const palette = usePalette();
  const slug = providerIconSlug(name);

  if (slug === null) {
    return (
      <View testID="provider-icon-default" style={{ width: size, height: size }}>
        <SymbolView
          name={FALLBACK_SYMBOL}
          size={size}
          tintColor={palette.secondaryLabel}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </View>
    );
  }

  return (
    <View testID={`provider-icon-${slug}`} style={{ width: size, height: size }}>
      <Image
        source={PROVIDER_ICONS[slug]}
        style={{ width: size, height: size }}
        // 单色资源只用得上 alpha，颜色由这里给（见文件头：跟标题同色才不会显得更重）。
        tintColor={palette.secondaryLabel}
        contentFit="contain"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </View>
  );
}
