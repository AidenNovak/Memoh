/**
 * 厂商图标：`provider` 的名字 → 图标资源名（纯逻辑，不碰 React、不碰原生）。
 *
 * ## 为什么按**名字**认厂商，不按 `client_type`
 *
 * `GET /providers` 里有个 `client_type`（`openai-completions` / `anthropic-messages` …），
 * 看起来像是"这是哪家"。它不是：那是**协议**，不是**厂商**。Kimi、DeepSeek、SiliconFlow、
 * 自建网关全都填 `openai-completions`——照它画图标，十家里有九家会被画成 OpenAI。
 * 所以这里只认用户/模板给这个名字本身，认不出就返回 `null`（界面给中性兜底 glyph）。
 *
 * ## 为什么是单色图标
 *
 * lobehub 的图标集里，**OpenAI / Anthropic / Claude / xAI(Grok) / Groq / Ollama 这些根本没有
 * 彩色版**（只有 `-color` 后缀存在的那部分厂商才有）。而它们恰好是最常见的几家。混着来会
 * 变成"有的彩色有的黑白"，比统一单色更难看，所以统一用单色（`light` 那套 PNG）+ `tintColor`
 * 染成和分组标题同色，跟系统图标摆在一排时重量才对得上（AGENTS.md 的 UI 基线）。
 *
 * ## 认不出的怎么办
 *
 * Memoh 是自托管的：用户接任何厂商、任何网关，甚至自己的中转。认不出**不是错误**，
 * 所以这里返回 `null` 而不是抛错，界面（`ui/ProviderIcon.tsx`）给一个中性 glyph——
 * 空白会让分组标题看起来像少画了一块。
 *
 * ## 匹配规则
 *
 * 名字先归一化（小写、丢掉空格/连字符/点这类分隔符、**保留中日韩字符**），然后按下面的
 * `PROVIDER_ICON_RULES` **顺序**逐条试，第一条命中的赢。命中判据两种：
 *
 * 1. 整个名字等于别名（忽略大小写与分隔符）：`"Google Cloud"` → `googlecloud`；
 * 2. 别名是名字里的一个完整词：`"Kimi (Moonshot)"` → 词 `kimi` 命中。
 *
 * 别名是**中文**时用"包含"判（`"通义千问"` 里有 `"千问"`）：中文没有词边界，整串是
 * 一个 token，按整词判永远匹配不上。这条只对含中文的别名生效，拉丁别名仍是整词匹配
 * ——`"Metamath"` 不该被认成 `Meta`。
 *
 * 顺序即优先级，两条经验规则：**具体产品排在它所属的大厂前面**（`Azure OpenAI` 要画
 * Azure，不是 OpenAI）、**网关排在它代理的厂商前面**（`new-api` 是中转站自己的标识）。
 */
/**
 规则表：`slug` 是图标资源名（= `assets/images/providers/<slug>.png`），`aliases` 是认得出的名字。

 **顺序有意义**（见文件头）。

 放进来的是"自托管用户真会接的那些"：主流云 + 主流开源/推理服务 + 国内几家 + 几个常见的
 本地/自建网关。没进来的走中性兜底——加一家的成本是：这里加一行 + 按
 `scripts/vendor-provider-icons.mjs` 把图补进 `assets/images/providers/`，两步必须同时完成。

 `as const` 是刻意的：`ProviderIconSlug` 这个联合类型直接从这张表推出来——**表就是资产清单**，
 不可能出现"类型里有一个名字但没人用"的死项。
 */
export const PROVIDER_ICON_RULES = [
  // ---- 先认"某大厂托管的某厂商"与"网关自己" ----
  { slug: 'azureai', aliases: ['azure', 'azureai', 'azureopenai', 'azureopenaiservice'] },
  { slug: 'bedrock', aliases: ['bedrock', 'awsbedrock', 'amazonbedrock', 'aws'] },
  { slug: 'googlecloud', aliases: ['googlecloud', 'gcp', 'gcloud'] },
  { slug: 'vertexai', aliases: ['vertexai', 'vertex'] },
  { slug: 'cloudflare', aliases: ['cloudflare', 'workersai', 'cfworkers'] },
  { slug: 'newapi', aliases: ['newapi', 'oneapi'] },
  { slug: 'openwebui', aliases: ['openwebui'] },
  { slug: 'dify', aliases: ['dify'] },
  { slug: 'fastgpt', aliases: ['fastgpt'] },

  // ---- 大厂 ----
  { slug: 'openai', aliases: ['openai', 'chatgpt', 'gpt'] },
  { slug: 'anthropic', aliases: ['anthropic'] },
  { slug: 'claude', aliases: ['claude', 'claudeai', 'claudecode'] },
  { slug: 'google', aliases: ['google', 'googleai', 'googlegemini'] },
  { slug: 'gemini', aliases: ['gemini'] },
  { slug: 'xai', aliases: ['xai', 'grok'] },
  { slug: 'meta', aliases: ['meta', 'metaai', 'llama'] },
  { slug: 'mistral', aliases: ['mistral', 'mistralai', 'codestral'] },
  { slug: 'cohere', aliases: ['cohere'] },
  { slug: 'nvidia', aliases: ['nvidia', 'nim'] },

  // ---- 推理服务 / 开源托管 ----
  { slug: 'groq', aliases: ['groq'] },
  { slug: 'together', aliases: ['together', 'togetherai'] },
  { slug: 'fireworks', aliases: ['fireworks', 'fireworksai'] },
  { slug: 'cerebras', aliases: ['cerebras'] },
  { slug: 'deepinfra', aliases: ['deepinfra'] },
  { slug: 'replicate', aliases: ['replicate'] },
  { slug: 'huggingface', aliases: ['huggingface', 'hf'] },
  { slug: 'openrouter', aliases: ['openrouter'] },
  { slug: 'perplexity', aliases: ['perplexity', 'sonar'] },

  // ---- 本地/自建推理 ----
  { slug: 'ollama', aliases: ['ollama'] },
  { slug: 'lmstudio', aliases: ['lmstudio'] },
  { slug: 'vllm', aliases: ['vllm'] },
  { slug: 'xinference', aliases: ['xinference'] },

  // ---- 国内 ----
  { slug: 'deepseek', aliases: ['deepseek'] },
  { slug: 'kimi', aliases: ['kimi'] },
  { slug: 'moonshot', aliases: ['moonshot', 'moonshotai', '月之暗面'] },
  {
    slug: 'qwen',
    aliases: ['qwen', 'tongyi', 'dashscope', 'alibaba', 'aliyun', '通义', '千问', '阿里'],
  },
  { slug: 'zhipu', aliases: ['zhipu', 'glm', 'chatglm', 'bigmodel', 'zai', '智谱'] },
  { slug: 'minimax', aliases: ['minimax', 'minimaxai'] },
  { slug: 'siliconcloud', aliases: ['siliconflow', 'siliconcloud', '硅基流动', '硅基'] },
  { slug: 'doubao', aliases: ['doubao', '豆包'] },
  { slug: 'volcengine', aliases: ['volcengine', 'ark', '火山'] },
  { slug: 'hunyuan', aliases: ['hunyuan', '混元'] },
  { slug: 'tencent', aliases: ['tencent', 'tencentcloud', '腾讯'] },
  { slug: 'baidu', aliases: ['baidu', 'ernie', 'qianfan', 'wenxin', '百度', '文心'] },
  { slug: 'spark', aliases: ['spark', 'xinghuo', 'iflytek', '星火', '讯飞'] },
  { slug: 'stepfun', aliases: ['stepfun', '阶跃'] },
  { slug: 'yi', aliases: ['yi', 'zeroone', '01ai', '零一'] },
  { slug: 'baichuan', aliases: ['baichuan', '百川'] },
] as const;

/** 图标资源名（= `assets/images/providers/<slug>.png`）。 */
export type ProviderIconSlug = (typeof PROVIDER_ICON_RULES)[number]['slug'];

/** 表里出现过的全部 slug（去重，保持首次出现的顺序）。资源清单以它为准。 */
export const PROVIDER_ICON_SLUGS: readonly ProviderIconSlug[] = [
  ...new Set<ProviderIconSlug>(PROVIDER_ICON_RULES.map((rule) => rule.slug)),
];

/** 归一化结果：`tokens` 是词，`compact` 是把词连起来（用来忽略分隔符做整名比较）。 */
export interface NormalizedName {
  readonly tokens: readonly string[];
  readonly compact: string;
}

/** 中日韩统一表意文字起点的粗略下界（含假名/谚文：它们都在这之上）。 */
const CJK_START = 0x2e80;

function isNameCharacter(character: string): boolean {
  if (character >= 'a' && character <= 'z') return true;
  if (character >= '0' && character <= '9') return true;
  // 中文名（"智谱"、"本地 Ollama"）必须能匹配，所以不按 ASCII 把非拉丁字符当分隔符丢掉。
  return (character.codePointAt(0) ?? 0) >= CJK_START;
}

/** 小写 → 丢掉分隔符 → 切词。`"Kimi (Moonshot-AI)"` → `['kimi','moonshot','ai']`。 */
export function normalizeProviderName(name: string): NormalizedName {
  const tokens: string[] = [];
  let current = '';
  for (const character of name.toLowerCase()) {
    if (isNameCharacter(character)) {
      current += character;
      continue;
    }
    if (current !== '') tokens.push(current);
    current = '';
  }
  if (current !== '') tokens.push(current);
  return { tokens, compact: tokens.join('') };
}

function containsCjk(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) >= CJK_START) return true;
  }
  return false;
}

interface CompiledAlias extends NormalizedName {
  readonly slug: ProviderIconSlug;
  readonly cjk: boolean;
}

/** 别名只在加载时归一化一次：每次渲染都重算是白算（一张列表里每个分组都要问一次）。 */
const COMPILED_ALIASES: readonly CompiledAlias[] = PROVIDER_ICON_RULES.flatMap((rule) =>
  rule.aliases.map((alias) => {
    const normalized = normalizeProviderName(alias);
    return { slug: rule.slug, cjk: containsCjk(normalized.compact), ...normalized };
  }),
);

/**
 provider 名字 → 图标 slug；认不出返回 `null`（界面兜底，不是错误）。

 空名字（服务端没给名字）也返回 `null`：那种情况界面根本不该画分组标题。
 */
export function providerIconSlug(name: string | null | undefined): ProviderIconSlug | null {
  if (name === null || name === undefined) return null;
  const { tokens, compact } = normalizeProviderName(name);
  if (compact === '') return null;
  for (const alias of COMPILED_ALIASES) {
    // 中文别名按"包含"判（没有词边界）；拉丁别名按整名/整词判（避免 Metamath → Meta）。
    if (alias.cjk) {
      if (compact.includes(alias.compact)) return alias.slug;
      continue;
    }
    if (alias.compact === compact) return alias.slug;
    if (alias.tokens.length === 1 && tokens.includes(alias.compact)) return alias.slug;
  }
  return null;
}
