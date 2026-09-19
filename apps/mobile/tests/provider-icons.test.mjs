/**
 * 厂商图标映射（`src/features/chat/providerIcons.ts`）。
 *
 * ## 三件"写错了也不明显"的事，各有一组断言
 *
 * 1. **认厂商只认名字**：`client_type` 是协议不是厂商（Kimi / DeepSeek / SiliconFlow 全填
 *    `openai-completions`），照它画图标等于把所有人都画成 OpenAI。所以这里用 `client_type`
 *    是 `openai-completions` 的 provider 反过来验：名字不是 OpenAI 就不该拿到 OpenAI 的图标。
 * 2. **认不出必须返回 `null`**（界面兜底成中性 glyph）。要是这里凭一个不认识的字符串硬凑
 *    一家，界面上就会出现"这家厂商的图标"——比没有图标错得更远。
 * 3. **清单与资源必须一致**：表里每一个 slug 都得有
 *    `assets/images/providers/<slug>.png`，反过来每张图也都得在表里。少一步都是静默的：
 *    漏一张图 = 界面上那家没有图标；多余一张图 = 没人用的二进制跟着 App 走。
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PROVIDER_ICON_RULES,
  PROVIDER_ICON_SLUGS,
  normalizeProviderName,
  providerIconSlug,
} from '../src/features/chat/providerIcons.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_DIRECTORY = join(HERE, '..', 'assets', 'images', 'providers');

test('归一化：忽略大小写与分隔符，保留中文', () => {
  assert.deepEqual(normalizeProviderName('Kimi (Moonshot-AI)').tokens, ['kimi', 'moonshot', 'ai']);
  assert.equal(normalizeProviderName('Google Cloud').compact, 'googlecloud');
  assert.deepEqual(normalizeProviderName('智谱 GLM').tokens, ['智谱', 'glm']);
  assert.deepEqual(normalizeProviderName('   ').tokens, []);
});

test('认识常见厂商（各家写法的宽度）', () => {
  const cases = [
    ['OpenAI', 'openai'],
    ['openai-compatible', 'openai'],
    ['ChatGPT Proxy', 'openai'],
    ['Anthropic', 'anthropic'],
    ['Claude', 'claude'],
    ['Google', 'google'],
    ['Google AI Studio', 'google'],
    ['Gemini', 'gemini'],
    ['DeepSeek', 'deepseek'],
    ['Kimi', 'kimi'],
    ['Moonshot AI', 'moonshot'],
    ['月之暗面', 'moonshot'],
    ['Qwen', 'qwen'],
    ['通义千问', 'qwen'],
    ['DashScope', 'qwen'],
    ['智谱', 'zhipu'],
    ['GLM-4', 'zhipu'],
    ['SiliconFlow', 'siliconcloud'],
    ['硅基流动', 'siliconcloud'],
    ['Doubao', 'doubao'],
    ['xAI', 'xai'],
    ['Grok', 'xai'],
    ['Ollama', 'ollama'],
    ['LM Studio', 'lmstudio'],
    ['New API', 'newapi'],
    ['Open WebUI', 'openwebui'],
    ['HuggingFace', 'huggingface'],
    ['百度千帆', 'baidu'],
    ['腾讯混元', 'hunyuan'],
    ['火山方舟', 'volcengine'],
  ];
  for (const [name, slug] of cases) {
    assert.equal(providerIconSlug(name), slug, `${name} 应认成 ${slug}`);
  }
});

test('托管版画成托管方，不画成上游厂商', () => {
  // Azure OpenAI 给的是 OpenAI 的模型，但这张 provider 卡是 Azure 的——画 OpenAI 会让人
  // 以为自己直连了 OpenAI。
  assert.equal(providerIconSlug('Azure OpenAI'), 'azureai');
  assert.equal(providerIconSlug('AWS Bedrock'), 'bedrock');
  assert.equal(providerIconSlug('Google Cloud'), 'googlecloud');
  assert.equal(providerIconSlug('Vertex AI'), 'vertexai');
});

test('认不出返回 null（界面兜底，不硬凑一家）', () => {
  for (const name of ['本地模型', 'Internal Gateway', '我的中转站', 'Metamath', '', '   ']) {
    assert.equal(providerIconSlug(name), null, `${name} 不该被认出来`);
  }
  assert.equal(providerIconSlug(null), null);
  assert.equal(providerIconSlug(undefined), null);
});

test('短别名按整词判：别把像的不像的认成一家', () => {
  // 'meta'/'yi'/'ark' 这类短名如果按"包含"判，会把无关名字卷进来。
  assert.equal(providerIconSlug('Metamath'), null);
  assert.equal(providerIconSlug('Yiyan'), null);
  assert.equal(providerIconSlug('Arkham'), null);
  // 整词命中仍然要成立。
  assert.equal(providerIconSlug('Meta'), 'meta');
  assert.equal(providerIconSlug('Llama (Meta)'), 'meta');
  assert.equal(providerIconSlug('Ark'), 'volcengine');
});

test('表里每个 slug 都有对应资源，每张资源也都在表里', () => {
  const files = readdirSync(ICON_DIRECTORY)
    .filter((name) => name.endsWith('.png'))
    .map((name) => name.slice(0, -'.png'.length))
    .sort();
  const slugs = [...PROVIDER_ICON_SLUGS].sort();

  const missing = slugs.filter((slug) => !files.includes(slug));
  assert.deepEqual(
    missing,
    [],
    `这些 slug 还没有图：${missing.join(', ')}（跑 pnpm icons:vendor）`,
  );

  const unused = files.filter((file) => !slugs.includes(file));
  assert.deepEqual(unused, [], `这些图没有任何规则在用：${unused.join(', ')}`);
});

test('slug 不重复出现（一个图标一条规则，顺序才好推理）', () => {
  const slugs = PROVIDER_ICON_RULES.map((rule) => rule.slug);
  assert.equal(new Set(slugs).size, slugs.length, '同一个 slug 出现了多次，优先级变得看不懂');
});

test('别名互不冲突：任何别名只归一家（顺序一改结果就变的那些）', () => {
  const owner = new Map();
  for (const rule of PROVIDER_ICON_RULES) {
    for (const alias of rule.aliases) {
      const previous = owner.get(alias);
      assert.equal(previous, undefined, `别名 ${alias} 同时属于 ${previous} 和 ${rule.slug}`);
      owner.set(alias, rule.slug);
    }
  }
});
