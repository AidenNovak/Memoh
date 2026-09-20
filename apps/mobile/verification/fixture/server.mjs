#!/usr/bin/env node
/**
 * 验收用的固定数据服务端（fixture server）。
 *
 * ## 为什么需要它
 *
 * 场景台最初只能渲染**消息列表**——因为那份数据是本地帧回放，不经过网络。但"会话
 * 列表""设置页""待审批横幅"这些页面是从真实 store 取数的（还要开 WebSocket），
 * 没法靠本地回放呈现。
 *
 * 两条路可以走：
 *
 * 1. 在生产代码里加"场景模式"分支，直接塞假数据 —— 被否决。假数据一旦绕开
 *    store/网络，截出来的图就不代表真实路径；而且生产代码里会长出验收专用的分支。
 * 2. **起一个说真协议的服务端** —— 采用。App 完全不知道自己在跟谁说话：真实的
 *    HTTP 客户端、真实的 WebSocket、真实的 store、真实的页面。零生产代码改动。
 *
 * 代价是要把协议实现一遍。但那份活儿只有一次，而它换来的是：
 *
 * - 每个页面、每个状态都能**确定性地**截图（不依赖线上数据，不依赖隧道）；
 * - CI 里不需要任何服务端就能跑完整 UI 验收；
 * - 它是"协议长什么样"的又一份可执行文档——`docs/research/verified-behaviour.md`
 *   里的每条结论都能在这里对着看。
 *
 * ## 数据从哪来
 *
 * 聊天数据**直接复用 `src/features/verify/scenes.ts`**（Node 的类型剥离能直接
 * import 那个 .ts）：同一份帧序列，一路是本地回放给场景台用，一路是走真实 WS 发给
 * App。两边写的必须是同一件事，所以只维护一份。
 *
 * 用法：
 *     node verification/fixture/server.mjs [--port 18099] [--scenario chat-tools]
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const { SCENES } = await import(join(ROOT, 'src/features/verify/scenes.ts'));

const arguments_ = process.argv.slice(2);
function flag(name, fallback) {
  const index = arguments_.indexOf(`--${name}`);
  return index === -1 ? fallback : arguments_[index + 1];
}

const PORT = Number(flag('port', '18099'));
/** 固定时点：截图里的时间、相对时间都要可复现。 */
const NOW = new Date('2026-09-13T20:00:00Z');
const ISO = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

// ------------------------------------------------------------------ 固定数据

const BOT = {
  id: 'fixture-bot',
  name: 'assistant',
  display_name: 'Assistant',
  avatar_url: '',
  owner_user_id: 'fixture-user',
  status: 'ready',
  timezone: 'Asia/Shanghai',
  is_active: true,
  check_state: 'ok',
  check_issue_count: 0,
  created_at: ISO(60 * 24 * 30),
  updated_at: ISO(5),
  metadata: {},
  // workspace_exec 是"能不能连 WebSocket"的门槛（见 types.ts 的 canOpenRealtime）。
  // workspace_read 是文件视图（fs/*）的门槛；workspace_exec 是实时通道的门槛。
  current_user_permissions: ['chat', 'workspace_read', 'workspace_exec', 'manage'],
};

/**
 bot 的响应。**时区是按场景给的**，见 `tz-pacific`：列表行的"下次执行"是客户端
 按 bot 时区算出来的（`src/features/schedule/describe.ts`），一直给 Asia/Shanghai
 就永远分不清"算对了时区"和"把服务器本地时区当成了 bot 时区"——两者在截图里
 都可能看着合理。

 `fs-no-permission` 拿掉 `workspace_read`；`chat-only` 只给 `chat`。文件 / 定时 / 实时入口
 都由 `current_user_permissions` 决定，没有能力就不该画一个点下去必然 403 的入口。
 */
/**
 `bots-many` 用的四个 bot：覆盖切换器列表要画出的四种样子。
 每个都是**真实会出现的形状**（`internal/bots/types.go`：status 只有 creating/ready/deleting；
 "有毛病"看的是 check_state）：
   - Assistant        ready + 无头像（首字母兜底）
   - 研究工作台        ready + 有 avatar_url（走图）
   - 周报机器人        ready 但 check_state=issue（那一行要置灰）
   - 新助手           creating（正在建，可以点但会看到它在准备）
 */
function manyBots() {
  const base = activeBot();
  return [
    base,
    {
      ...base,
      id: 'fixture-bot-research',
      name: 'research-desk',
      display_name: '研究工作台',
      avatar_url: 'https://example.com/avatar.png',
    },
    {
      ...base,
      id: 'fixture-bot-report',
      name: 'weekly-report',
      display_name: '周报机器人',
      check_state: 'issue',
      check_issue_count: 2,
    },
    {
      ...base,
      id: 'fixture-bot-fresh',
      name: 'fresh-agent',
      display_name: '新助手',
      status: 'creating',
    },
  ];
}

/** 把 `avatar_url` 这个 key **整个删掉**（服务端 omitempty 的那个形状）。 */
function withoutAvatarUrl(bot) {
  const shaped = { ...bot };
  delete shaped.avatar_url;
  return shaped;
}

/**
 `bots-avatar-missing` 用的两条 bot：**真服务端的"没有头像"形状**。

 ## 为什么单开这条场景

 这里以前一律给 `''`，而服务端 `internal/bots/types.go` 写的是
 `AvatarURL string \`json:"avatar_url,omitempty"\``——**没有头像时整个 key 不出现**。
 固定服务端给 `''`、真服务端给"没有这个 key"，于是客户端里"把 `avatar_url` 当必然存在"
 的写法（`.trim()`）在验收里全绿、在 dev 栈上一进会话列表就红屏
 （`Cannot read property 'trim' of undefined`，2026-09-16 实测）。

 两条覆盖两种同形状的坏值：
   - `assistant`    ：**没有 `avatar_url` 这个 key**（dev 栈实测的形状）；
   - `null-avatar`  ：显式 `null`（另一个客户端/更早的部署可能发它）。

 其余字段照真服务端给全（id / display_name / check_state / status / 权限……），
 这条场景验的是"字段缺失"这一个变量，别顺带改别的。

 ⚠️ 默认场景**不变**（仍然给空串）：这条是"能造出真形状"，不是把默认形状改掉。
 */
function avatarShapeBots() {
  const base = activeBot();
  return [
    withoutAvatarUrl(base),
    {
      ...base,
      id: 'fixture-bot-null-avatar',
      name: 'null-avatar',
      display_name: 'Null Avatar',
      avatar_url: null,
    },
  ];
}

/**
 新建 bot 的场景状态。
 `POST /bots` 建出来的记录放在这里，`GET /bots/{id}` 前两次问给 `creating`、之后给 `ready`
 ——这样界面那条"先创建再轮询"的路能被真跑一遍，而不必在 dev 栈上真拉一个容器。
 */
let createdBots = [];
let createdPolls = new Map();
/** 被 `PUT /bots/{id}` 改过的 bot（按 id）。GET 单条/列表时优先用它。 */
let updatedBots = new Map();

/** 名字可用性：保留字照服务端清单，另外把两个名字当作"被占用"。 */
const TAKEN_BOT_NAMES = new Set(['assistant', 'weekly-report']);
const RESERVED_BOT_NAMES = new Set([
  'new',
  'edit',
  'settings',
  'admin',
  'bots',
  'bot',
  'chat',
  'team',
  'teams',
  'api',
  'home',
  'login',
  'logout',
  'me',
  'system',
]);

function nameAvailability(name) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) return { available: false, reason: 'invalid' };
  if (RESERVED_BOT_NAMES.has(name)) return { available: false, reason: 'reserved' };
  if (TAKEN_BOT_NAMES.has(name)) return { available: false, reason: 'taken' };
  return { available: true, reason: 'available' };
}

/**
 模型目录（`GET /models`）与 provider（`GET /providers`）。

 为什么固定服务端要有这两样：模型选择器是**真读目录**的界面（分组、搜索、思考档位全都
 来自这两个响应）。没有它们就只能靠"假数据注入"，那样验不到"服务端说这个模型关不掉思考"
 时界面是不是真的不给 off。

 数据刻意覆盖四种形状：
   - `k3`：支持思考、**关不掉**（`can_disable:false`）→ 不该出现 off
   - `deepseek-v4-flash`：支持思考、**可以关**（`can_disable:true`）→ 该有 off
   - `plain-fast`：不支持思考 → 强度那一段整段不出现
   - 一个 embedding 与一个 `enable:false` → 都**不该**出现在列表里
   - `internal-chat`（第三家 provider `Internal Gateway`）：**名字认不出来的那种**。分组标题
     旁边要落到中性兜底图标，而不是空白——自托管用户接自己的中转就是这一态；它的
     `client_type` 还是 `openai-completions`，所以顺带证明"厂商看名字、不看协议"。
 */
function manyModels() {
  return [
    {
      id: 'fixture-model-k3',
      model_id: 'k3',
      name: 'Kimi K3',
      provider_id: 'fixture-provider-kimi',
      type: 'chat',
      enable: true,
      config: { compatibilities: ['reasoning', 'tool-call'] },
      reasoning: {
        supported: true,
        can_disable: false,
        efforts: ['low', 'medium', 'high'],
        default_effort: 'medium',
      },
    },
    {
      id: 'fixture-model-deepseek',
      model_id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      provider_id: 'fixture-provider-deepseek',
      type: 'chat',
      enable: true,
      config: { compatibilities: ['reasoning', 'tool-call'] },
      reasoning: {
        supported: true,
        can_disable: true,
        efforts: ['low', 'high'],
        default_effort: 'low',
      },
    },
    {
      id: 'fixture-model-plain',
      model_id: 'plain-fast',
      name: 'Plain Fast',
      provider_id: 'fixture-provider-deepseek',
      type: 'chat',
      enable: true,
      config: { compatibilities: ['tool-call'] },
      reasoning: { supported: false },
    },
    {
      id: 'fixture-model-internal',
      model_id: 'internal-chat',
      name: 'Internal Chat',
      provider_id: 'fixture-provider-internal',
      type: 'chat',
      enable: true,
      config: { compatibilities: ['tool-call'] },
      reasoning: { supported: false },
    },
    {
      id: 'fixture-model-embed',
      model_id: 'embed-1',
      name: 'Embedding One',
      provider_id: 'fixture-provider-deepseek',
      type: 'embedding',
      enable: true,
    },
    {
      id: 'fixture-model-off',
      model_id: 'retired-model',
      name: 'Retired Model',
      provider_id: 'fixture-provider-kimi',
      type: 'chat',
      enable: false,
    },
  ];
}

function activeBot() {
  let permissions = BOT.current_user_permissions;
  if (currentScenario === 'fs-no-permission') {
    permissions = permissions.filter((item) => item !== 'workspace_read');
  }
  if (currentScenario === 'chat-only') permissions = ['chat'];
  return {
    ...BOT,
    timezone: currentScenario === 'tz-pacific' ? 'America/Los_Angeles' : BOT.timezone,
    current_user_permissions: permissions,
  };
}

/** 会话列表。刻意涵盖首页要区分的几种形态。 */
const SESSIONS = [
  {
    id: 'fixture-session-active',
    title: '把报告的图表重新生成',
    type: 'chat',
    channel_type: 'web',
    created_at: ISO(60 * 24 * 2),
    updated_at: ISO(3),
    created_by_user_id: 'fixture-user',
    parent_session_id: '',
    preferred_chat_model_id: 'deepseek-v4-flash',
    preferred_external_model_id: '',
    preferred_reasoning_effort: '',
    model_preference_revision: '1',
    runtime_type: 'native',
    runtime_metadata: {},
    metadata: {},
    bot_agent_id: '',
    owner_user_id: 'fixture-user',
    last_message_at: ISO(3),
    message_count: 12,
  },
  {
    id: 'fixture-session-long-title',
    title: '为什么昨天那个部署脚本在 CI 上会超时，我一直没想明白，帮我看看是不是轮询间隔的问题',
    type: 'chat',
    channel_type: 'web',
    created_at: ISO(60 * 24),
    updated_at: ISO(45),
    created_by_user_id: 'fixture-user',
    parent_session_id: '',
    preferred_chat_model_id: 'deepseek-v4-flash',
    preferred_external_model_id: '',
    preferred_reasoning_effort: '',
    model_preference_revision: '1',
    runtime_type: 'native',
    runtime_metadata: {},
    metadata: {},
    bot_agent_id: '',
    owner_user_id: 'fixture-user',
    last_message_at: ISO(45),
    message_count: 4,
  },
  {
    id: 'fixture-session-untitled',
    title: '',
    type: 'chat',
    channel_type: 'telegram',
    created_at: ISO(60 * 5),
    updated_at: ISO(60 * 3),
    created_by_user_id: 'fixture-user',
    parent_session_id: '',
    preferred_chat_model_id: '',
    preferred_external_model_id: '',
    preferred_reasoning_effort: '',
    model_preference_revision: '1',
    runtime_type: 'native',
    runtime_metadata: {},
    metadata: {},
    bot_agent_id: '',
    owner_user_id: 'fixture-user',
    last_message_at: ISO(60 * 3),
    message_count: 2,
  },
  {
    id: 'fixture-session-old',
    title: '整理一下这个月的账单',
    type: 'chat',
    channel_type: 'web',
    created_at: ISO(60 * 24 * 20),
    updated_at: ISO(60 * 24 * 18),
    created_by_user_id: 'fixture-user',
    parent_session_id: '',
    preferred_chat_model_id: '',
    preferred_external_model_id: '',
    preferred_reasoning_effort: '',
    model_preference_revision: '1',
    runtime_type: 'native',
    runtime_metadata: {},
    metadata: {},
    bot_agent_id: '',
    owner_user_id: 'fixture-user',
    last_message_at: ISO(60 * 24 * 18),
    message_count: 30,
  },
  {
    /**
     流式时序专用：这一轮**正在跑**（`chat-tool-stream`）。
     单开一条会话而不是复用 `fixture-session-active`，是因为"跑着的一轮"与"已完成的一轮"
     是两种不同的数据形状（前者没有 REST 历史），混在一条会话里会让两种形状互相污染。
     */
    id: 'fixture-session-stream',
    title: '跑一遍测试再更新报告',
    type: 'chat',
    channel_type: 'web',
    created_at: ISO(60),
    updated_at: ISO(1),
    created_by_user_id: 'fixture-user',
    parent_session_id: '',
    preferred_chat_model_id: 'deepseek-v4-flash',
    preferred_external_model_id: '',
    preferred_reasoning_effort: '',
    model_preference_revision: '1',
    runtime_type: 'native',
    runtime_metadata: {},
    metadata: {},
    bot_agent_id: '',
    owner_user_id: 'fixture-user',
    last_message_at: ISO(1),
    message_count: 5,
  },
];

/**
 `sessions-many`：300 条会话，名字带序号、`updated_at` **递减**（越靠后越旧）。

 为什么要专门造这一批：长列表的问题（滚动掉帧、内存、分组标题错位）只有在
 条目足够多的时候才现形，而默认那 4 条永远滚不到底。序号让"滚到第几屏"在截图里
 可读，`updated_at` 递减则顺带验证客户端的排序/分组没有把顺序搞乱。
 */
function manySessions() {
  const items = [];
  for (let index = 1; index <= 300; index += 1) {
    items.push({
      ...SESSIONS[0],
      id: `fixture-session-bulk-${index}`,
      title: `批量会话 ${index}：第 ${index} 轮整理`,
      // 两种渠道轮着来：行上的渠道标记不是只有一种样子。
      channel_type: index % 5 === 0 ? 'telegram' : 'web',
      created_at: ISO(index * 7 + 600),
      updated_at: ISO(index * 7),
      last_message_at: ISO(index * 7),
      message_count: index % 17,
    });
  }
  return items;
}

/**
 `sessions-paged` / `sessions-more-error`：**真的有下一页**的会话。

 为什么要专门造这一批：这个固定服务端以前在**所有**场景里都回 `next_cursor: ''`
 （= 到底），于是列表尾部那两个状态——"加载更早的会话 / 当前显示最近 N 个"
 （`home.sessions.more` / `home.sessions.window`）与失败后的"没能拉到更早的会话"
 （`home.sessions.more.failed`）——在界面上**永远不可能出现**。看不见的东西会一直坏
 （2026-09-17 视觉评审抓到的正是这一类）：它们只有类型与单测证据，验收里一帧都没有。
 `next_cursor` 是链接到界面的那根线，这里把线接上。

 三页 50/50/20，与服务端的默认页大小（客户端 `SESSION_PAGE_LIMIT=50`）一致：
 「点一次还有下一页」和「点到到底」两种终态都能验。序号写在标题里，截图里能读出
 到底是哪一页接上来了。

 `sessions-paged-short` / `sessions-more-error-short` 是同一档的**短页**版本
 （第一页 3 条）：`verification/ui` 那一层只有 `xcrun simctl`（截图 + Vision 文字），
 **没有滑动**——50 条的列表底下那行不滚就看不见，短页让它落在首屏里。
 */
const PAGED_PAGE_SIZES = [50, 50, 20];
const PAGED_SHORT_PAGE_SIZES = [3, 3];
const PAGED_CURSOR_PREFIX = 'fixture-paged-';

/** 哪几档场景要按游标出数据（其余场景照旧无视 `cursor`，行为一个字不改）。 */
const PAGED_PAGE_SIZES_BY_SCENARIO = {
  'sessions-paged': PAGED_PAGE_SIZES,
  'sessions-more-error': PAGED_PAGE_SIZES,
  'sessions-paged-short': PAGED_SHORT_PAGE_SIZES,
  'sessions-more-error-short': PAGED_SHORT_PAGE_SIZES,
};

/** 这一档场景的页大小；不是分页档就返回 null。 */
function pagedPageSizes(scenario) {
  return PAGED_PAGE_SIZES_BY_SCENARIO[scenario] ?? null;
}

function pagedSessionItems(pageIndex, sizes) {
  const items = [];
  const size = sizes[pageIndex] ?? 0;
  // 前面几页的条数累加，序号才是全局递增的（截图里"第 51 条"必须真的是第 51 条）。
  const before = sizes.slice(0, pageIndex).reduce((sum, count) => sum + count, 0);
  for (let index = 1; index <= size; index += 1) {
    const ordinal = before + index;
    items.push({
      ...SESSIONS[0],
      id: `fixture-session-paged-${ordinal}`,
      title: `分页会话 ${ordinal}：第 ${ordinal} 轮整理`,
      channel_type: ordinal % 5 === 0 ? 'telegram' : 'web',
      created_at: ISO(ordinal * 7 + 600),
      updated_at: ISO(ordinal * 7),
      last_message_at: ISO(ordinal * 7),
      message_count: ordinal % 17,
    });
  }
  return items;
}

/** 游标 → 页号。空串 = 第一页；不认识的游标返回 null（回空页，别装作还有内容）。 */
function pagedPageIndex(cursor, sizes) {
  if (cursor === '') return 0;
  if (!cursor.startsWith(PAGED_CURSOR_PREFIX)) return null;
  const parsed = Number.parseInt(cursor.slice(PAGED_CURSOR_PREFIX.length), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed >= sizes.length) return null;
  return parsed;
}

/**
 一页 + 它的 `next_cursor`。**空串 = 这是最后一页**（服务端语义：
 "clients should stop paging on an empty cursor"）——客户端据此让尾部那行消失。
 */
function pagedSessionPage(cursor, sizes) {
  const pageIndex = pagedPageIndex(cursor, sizes);
  if (pageIndex === null) return { items: [], nextCursor: '' };
  const nextIndex = pageIndex + 1;
  const hasNext = nextIndex < sizes.length;
  return {
    items: pagedSessionItems(pageIndex, sizes),
    nextCursor: hasNext ? `${PAGED_CURSOR_PREFIX}${nextIndex}` : '',
  };
}

/** 这一档的场景要按游标出数据（其余场景照旧无视 `cursor`，行为一个字不改）。 */
function isPagedScenario(scenario) {
  return pagedPageSizes(scenario) !== null;
}

/**
 `sessions-sparse`：**缺字段 / `null` 的会话形状**。

 这不是编出来的形状，是这台部署服务端的实测：会话条目**一个都不带 `channel_type`**
 （41/41 缺失，见 `features/session/sourceLabel.ts` 的记录），标题也允许为空
 （新会话、从 IM 频道建的会话）。固定服务端以前每条字段都齐，于是"缺字段时界面画成
 什么样"只有单测能碰，验收里看不见——正是"看不见的东西会一直坏"。

 三条各演一种：
   - 标题空串（真实：新会话）→ 行标题落到本地化兜底（`home.untitled`）；
   - `channel_type` 与 `type` 都缺 → 副标题**整行不渲染**，而不是渲染成" · chat"那种
     开头一个空段的样子（那个 bug 修过一次，这里把它的形状固定下来）；
   - `title: null`（JSON 显式 null）→ 与缺字段同等对待，**不许崩**（崩溃是渲染层的事，
     这条同时钉住"服务端给了个坏值"的兜底）。
 */
function sparseSessions() {
  /**
   三条都**不带 `channel_type`**——那是这台部署的常态（41/41 缺失）。都缺才让
   "整份列表里不该出现多余的分隔符"（`' · '`）成为一条能断的判据；只让其中一条缺，
   另外两条的 `web · chat` 会让那条断言永远为真。
   */
  return [
    { ...SESSIONS[0], id: 'fixture-session-sparse-untitled', title: '', channel_type: undefined },
    {
      ...SESSIONS[0],
      id: 'fixture-session-sparse-bare',
      title: '没有来源字段的会话',
      channel_type: undefined,
      type: undefined,
    },
    {
      ...SESSIONS[0],
      id: 'fixture-session-sparse-null-title',
      title: null,
      channel_type: undefined,
    },
  ];
}

/**
 当前场景下的会话列表。

 出错/空/长列表/分页/缺字段几档会改这一份数据，所以集中在一处决定：`home-empty` 空列表、
 `sessions-many` 300 条、`sessions-paged` 与 `sessions-more-error` 第一页、
 `sessions-sparse` 三条缺字段的、`home-error` 走失败分支（在请求处理里），
 其余用默认那 4 条。

 分页那两档这里只给**第一页**：这条函数是"详情/点开"用的（`oneSession` 的查找），
 分页本身在 GET 处理里按游标出数据。
 */
function activeSessions() {
  let sessions;
  if (currentScenario === 'home-empty') sessions = [];
  else if (currentScenario === 'sessions-many') sessions = manySessions();
  if (isPagedScenario(currentScenario)) {
    sessions = [...createdSessions, ...pagedSessionItems(0, pagedPageSizes(currentScenario))];
  } else if (isOlderHistoryScenario(currentScenario)) {
    sessions = [...createdSessions, olderHistorySession(), ...SESSIONS];
  } else if (currentScenario === 'sessions-sparse') {
    sessions = [...createdSessions, ...sparseSessions()];
  } else if (sessions === undefined) {
    sessions = [...createdSessions, ...SESSIONS];
  }
  // PATCH 后列表与单条查询都必须读到新标题。只空回 200 会让重命名 sheet 看似成功，
  // 回到列表却仍是旧名——那种 fixture 反而替产品 bug 打掩护。
  return sessions.map((session) => updatedSessions.get(session.id) ?? session);
}

/**
 `chat-older-error` / `chat-older-ok`：往前翻页那一条路（`before_message_id`）。

 判据的来历：往前翻页失败时游标必须**留着**、并且界面要说一句"没能拉到更早的消息"
 （`chat-older-failed`）——"没拉到"和"已经到第 1 轮了"在屏幕上长得一模一样，
 静默失败会被读成"没有更早的了"（评审 A2）。这一档以前造不出来：`/messages` 无视
 `before_message_id`、永远回同一页，所以那个失败条在界面上永远不会出现。

 历史必须**够长**（`OLDER_HISTORY_TURNS`）：`onReachTop` 只在真的滚动时上报
 （`NativeMessageList.scrollViewDidScroll` 里 isDragging/isDecelerating/isTracking 那三
 个条件），一屏放得下的历史永远滚不动，这条路也就验不到。

 两档共用同一份第一页，只有"往前那一跳"不同：`chat-older-error` 回 500（失败条），
 `chat-older-ok` 回真正更老的一页（点"重试"之后要真的接上内容）。
 */
const OLDER_HISTORY_TURNS = 40;
const OLDER_HISTORY_PAGE_SIZE = 20;
const OLDER_HISTORY_SESSION_ID = 'fixture-session-older';

/** 长会话的摘要（只在这些场景的列表里出现；它要能被点开，所以得在列表里）。 */
function olderHistorySession() {
  return {
    ...SESSIONS[0],
    id: OLDER_HISTORY_SESSION_ID,
    title: '长会话：往前翻页',
    updated_at: ISO(3),
    last_message_at: ISO(3),
    message_count: OLDER_HISTORY_TURNS * 2,
  };
}

/**
 一页历史的**线上形状**（`UITurn[]`）。

 ⚠️ 这一份必须与 `turnsFor` 一样保持线上 `UITurn` 形状，不能退回客户端内部的渲染形状
 （`{key, position, user:{…}}`）。两个原因，都是验收撞出来的：

 1. 往前翻页的游标是 `turn.id`（`historyPage.olderCursorOf`），渲染形状里没有这个字段，
    于是客户端会认为"没有游标、别发请求"——那个失败条**永远不可能出现**；
 2. REST 历史进的是 `renderTurns`（吃 `turn_id` / `role` / `text` / `messages`），
    形状不对就是一片空白（既有的聊天页之所以没露馅，是因为内容其实来自 WS 帧回放）。

 `id` 用 `older-row-N`：游标就是拿它再往前要的，所以它必须逐轮不同。
 */
function olderHistoryPageWire(start, end) {
  const turns = [];
  for (let index = start; index <= end; index += 1) {
    turns.push({
      turn_id: `older-user-${index}`,
      turn_position: index * 2 - 1,
      role: 'user',
      text: `第 ${index} 个问题：这里还能再简化吗？`,
      id: `older-row-${index}`,
    });
    turns.push({
      turn_id: `older-assistant-${index}`,
      turn_position: index * 2,
      role: 'assistant',
      messages: [
        {
          id: index,
          type: 'text',
          content: `第 ${index} 轮的结论：可以，把重复的校验合并成一个。`,
        },
      ],
    });
  }
  return turns;
}

/** 这一档场景要走"往前翻页"的分支（含会话列表里的那条长会话）。 */
function isOlderHistoryScenario(scenario) {
  return scenario === 'chat-older-error' || scenario === 'chat-older-ok';
}

function sceneById(id) {
  return SCENES.find((scene) => scene.id === id) ?? null;
}

/**
 把场景的帧序列翻成 REST 历史（真正的 `UITurn[]`，不是客户端渲染后的 `RenderTurn[]`）。

 场景帧只有消息 id，没有显式的 assistant turn id，所以按协议时序归属：一条消息第一次出现时
 归到最近的 user turn；同一帧恰好有 N 个 user turn + N 条 message 时一一对应（性能场景的批量
 历史就是这个形状）。后续 append 继续按 message id 找原 owner。这样默认聊天、错误块和多轮历史
 都能走客户端真正的 REST 解析路径，`forkTarget()` 也能拿到真实的 assistant `turn_id`。
 */
function turnsFor(sceneId) {
  const scene = sceneById(sceneId);
  if (scene === null) return [];
  /**
   标记了 `restHistory: 'none'` 的场景**没有历史**：它是"这一轮还在跑"的切面，而服务端
   要在轮次屏障上才把这一轮落盘。合成一份历史会让界面同时拿到"已完成的一轮"和
   "正在跑的一轮"两份，把要验的东西盖住（见 `src/features/verify/scenes.ts`）。
  */
  if (scene.restHistory === 'none') return [];
  const pairs = [];
  const pairByUserTurn = new Map();
  const ownerByMessage = new Map();
  let currentPair = null;

  for (const frame of scene.frames) {
    if (frame.kind !== 'delta') continue;
    const delta = frame.delta;
    const framePairs = [];
    for (const userTurn of delta.user_turn_upserts ?? []) {
      let pair = pairByUserTurn.get(userTurn.turn_id);
      if (pair === undefined) {
        pair = { user: { ...userTurn, role: 'user' }, messages: new Map() };
        pairByUserTurn.set(userTurn.turn_id, pair);
        pairs.push(pair);
      } else {
        pair.user = { ...pair.user, ...userTurn, role: 'user' };
      }
      currentPair = pair;
      framePairs.push(pair);
    }

    const upserts = [...(delta.message_upserts ?? []), ...(delta.current_run_view?.messages ?? [])];
    for (const [index, message] of upserts.entries()) {
      const key = String(message.id);
      let owner = ownerByMessage.get(key);
      if (owner === undefined) {
        owner = framePairs.length === upserts.length ? framePairs[index] : currentPair;
        if (owner === undefined || owner === null) continue;
        ownerByMessage.set(key, owner);
      }
      owner.messages.set(key, { ...(owner.messages.get(key) ?? {}), ...message });
    }

    for (const append of delta.message_appends ?? []) {
      const key = String(append.id);
      let owner = ownerByMessage.get(key);
      if (owner === undefined) {
        owner = currentPair;
        if (owner === undefined || owner === null) continue;
        ownerByMessage.set(key, owner);
      }
      const existing = owner.messages.get(key);
      owner.messages.set(key, {
        ...(existing ?? { id: append.id, type: append.type }),
        content: `${existing?.content ?? ''}${append.content}`,
      });
    }
  }

  const turns = [];
  for (const pair of pairs) {
    turns.push(pair.user);
    if (pair.messages.size === 0) continue;
    turns.push({
      turn_id: `${pair.user.turn_id}-assistant`,
      turn_position:
        typeof pair.user.turn_position === 'number' ? pair.user.turn_position + 1 : undefined,
      role: 'assistant',
      messages: [...pair.messages.values()],
    });
  }
  return turns;
}

/** 每个会话对应哪个场景。默认用第一个聊天场景。 */
function sceneForSession(sessionId) {
  // 分叉会话的内容来自复制后的 REST 历史，不该再伪造一个正在跑的 WS 场景。
  if (forkedSessionSources.has(sessionId)) return 'forked-history-only';
  if (sessionId === 'fixture-session-active') return 'chat-tools';
  if (sessionId === 'fixture-session-stream') return 'chat-tool-stream';
  if (sessionId.startsWith('fixture-session-created')) return 'chat-tool-stream';
  if (sessionId === 'fixture-session-long-title') return 'chat-reasoning';
  if (sessionId === 'fixture-session-untitled') return 'approval-no-options';
  if (sessionId === 'fixture-session-old') return 'chat-long';
  /**
   消息流里的错误块（`errors` / `chat-errors` 那一组用）。这两条**不在** SESSIONS 里——
   它们只是"进哪一屏"的入口，加进列表会改动别人截图里的会话清单。
   */
  if (sessionId === 'fixture-session-error') return 'chat-error';
  if (sessionId === 'fixture-session-timeout') return 'chat-error-timeout';
  /**
   往前翻页那条长会话**不要**帧回放（返回一个不存在的场景名，`sendScene` 会直接返回）。

   为什么：这条路要验的是 **REST 历史**（第一页 + 往前接一页）。场景回放会把另一份内容
   也塞进同一个会话里（订阅成功就放帧），屏幕上就同时有两份东西，谁先谁后说不清——
   而"往前翻页接上没有"这件事本来就不该由实时帧掺和。真会话在没有新帧时就是这个样子。
   */
  if (sessionId === OLDER_HISTORY_SESSION_ID) return 'fixture-no-scene';
  return 'chat-tools';
}

/** 普通会话读自己的场景；分叉会话读源会话被复制过来的那份历史。 */
function historyForSession(sessionId) {
  const sourceId = forkedSessionSources.get(sessionId) ?? sessionId;
  return turnsFor(sceneForSession(sourceId));
}

// ------------------------------------------------------------------ HTTP

const TOKEN = 'fixture-token';

/** 当前场景。验收脚本通过 `/__scenario` 切换，REST 与 WS 都按它出数据。 */
let currentScenario = 'chat-tools';

/**
 待发队列的固定数据。
 
 只有 `queue` 场景才有条目——其余场景返回空队列，这样静态截图之间可比，
 也顺带验证"没有待发项时队列条整块不出现"。
 
 `status` 用真实枚举值：`accepted`/`claimed` 会显示，`applied` 是终态、不该出现
 （这里故意放一条，验证客户端确实会把它滤掉）。
 */
const QUEUE_ITEMS = {
  follow_up: [
    {
      item_id: 'f1',
      text: '顺便把 README 里的安装步骤也更新一下',
      position: 1,
      status: 'accepted',
    },
    // 终态：不该出现在界面上。
    { item_id: 'f0', text: '这条已经执行完了', position: 0, status: 'applied' },
  ],
  steer: [{ item_id: 's1', text: '先别改前端，只看后端', position: 1, status: 'claimed' }],
  steer_supported: true,
};

/** bot 的运行时配置。形状照 `PUT /bots/{id}/settings` 的实测要求（多字段会被整条拒）。 */
const SETTINGS = {
  model: 'deepseek-v4-flash',
  tool_approval_config: { exec: { force_review_commands: false } },
};

// ------------------------------------------------------------------ 定时任务

/**
 定时任务的固定数据与**写语义**。

 ## 为什么这一组端点必须真的会"改"

 定时服务端最刺眼的坑是**三个动词三套形状**（`docs/schedule.md`）：读=平铺、
 建=平铺、改用嵌套的 `execution` 且**整块替换**。这个坑的失败方式是
 "改个名字把模型覆盖和推理强度一起清空了，服务端还回 200"——一个只会说
 "success" 的假端点恰好把这条 bug 藏起来。所以这里的 POST/PUT/DELETE 都**真的在
 内存里改**，界面验"只改一个字段没把别的弄丢"才有意义。

 ## 空值一律不输出

 `omitempty` 的字段（`max_calls`、`target_session_id`、`runtime_type`、`bot_agent_id`、
 `model_id`、`reasoning_effort`、`workdir_id`，以及 Go 那边同样 omitempty 的
 `acp_agent_id`/`acp_model_id`）**空就不出现在响应里**。客户端把"缺失"读成空串，
 而"存在且为空"是另一回事；输出一个空值等于替服务端发明了一个约定。

 ## 状态什么时候重置

 每次切场景都**按场景重建**（`applyScenario`）。否则「先看 schedule-default、
  PUT 一条、再看 schedule-empty、回到 schedule-default」会把上一条场景留下的修改
 带回来，第二次截图不再等于第一次，"可复现"这个前提就没了。
 */

/** `execution` 的九项。PUT 是整块替换，所以九项必须一个不少地存在内存里。 */
const EXECUTION_KEYS = [
  'run_target',
  'target_session_id',
  'runtime_type',
  'bot_agent_id',
  'acp_agent_id',
  'model_id',
  'acp_model_id',
  'reasoning_effort',
  'workdir_id',
];

/** 执行块：**缺失即零值**（Go 里整块赋值就是这个语义）。 */
function executionOf(raw) {
  const source = raw ?? {};
  const out = {};
  for (const key of EXECUTION_KEYS) {
    out[key] = typeof source[key] === 'string' ? source[key] : '';
  }
  return out;
}

/** 一条任务的内部记录。多余的键（客户端发来的）直接丢掉，不回声。 */
function newSchedule(input) {
  return {
    id: input.id,
    name: input.name,
    description: input.description ?? '',
    pattern: input.pattern ?? '',
    enabled: input.enabled === true,
    command: input.command ?? '',
    bot_id: input.botId ?? BOT.id,
    current_calls: input.currentCalls ?? 0,
    /** `null` = 不限；有数字才是"设了上限"。 */
    max_calls: typeof input.maxCalls === 'number' ? input.maxCalls : null,
    created_at: ISO(input.createdMinutesAgo ?? 60 * 24),
    updated_at: ISO(input.updatedMinutesAgo ?? 60),
    execution: executionOf(input.execution),
  };
}

/**
 单条的线上形状：**平铺**（Go 的 `Schedule` 内嵌 `ExecutionConfig`，不是嵌套对象）。

 键的顺序照 `docs/schedule.md` 那张表写，纯粹为了和真响应并排看时更好读。
 */
function wireSchedule(record) {
  const out = {
    id: record.id,
    name: record.name,
    description: record.description,
    pattern: record.pattern,
    current_calls: record.current_calls,
    created_at: record.created_at,
    updated_at: record.updated_at,
    enabled: record.enabled,
    command: record.command,
    bot_id: record.bot_id,
    run_target: record.execution.run_target,
  };
  // 有上限才输出这个键（omitempty 的指针：没设上限时键根本不在响应里）。
  if (record.max_calls !== null) out.max_calls = record.max_calls;
  for (const key of EXECUTION_KEYS) {
    if (key === 'run_target') continue;
    if (record.execution[key] !== '') out[key] = record.execution[key];
  }
  return out;
}

/** 一条执行日志的内部记录。 */
function newLog(input) {
  return {
    id: input.id,
    schedule_id: input.scheduleId,
    bot_id: input.botId ?? BOT.id,
    session_id: input.sessionId ?? '',
    status: input.status,
    result_text: input.resultText ?? '',
    error_message: input.errorMessage ?? '',
    started_at: ISO(input.startedMinutesAgo),
    /** 运行中就没有结束时间——`completed_at` 是 omitempty 的。 */
    completed_at:
      input.durationMinutes === undefined
        ? ''
        : ISO(input.startedMinutesAgo - input.durationMinutes),
  };
}

/** 日志的线上形状。`result_text` / `error_message` 是普通字符串（总能出现，可为空）。 */
function wireLog(record) {
  const out = {
    id: record.id,
    schedule_id: record.schedule_id,
    bot_id: record.bot_id,
    status: record.status,
    result_text: record.result_text,
    error_message: record.error_message,
    started_at: record.started_at,
  };
  if (record.session_id !== '') out.session_id = record.session_id;
  if (record.completed_at !== '') out.completed_at = record.completed_at;
  return out;
}

/**
 `schedule-default` 的三条：覆盖界面上三种"最近一次"的样子。

 ① 启用 + 每天九点 + 最近一次 `ok`
 ② 停用 + 每十五分钟 + 最近一次 `error`
 ③ 启用 + 每小时 + 最近一次**正在跑**（`status='ok'` + 没有 `completed_at`，见下面那条日志）

 三条都是**不同的图案**，因为"下次执行"那一栏是客户端算的：同一个 pattern 出现三次
 就分不清哪一行算错了。
 */
function defaultScheduleSeed() {
  const items = [
    newSchedule({
      id: 'fixture-schedule-morning',
      name: '生成每日早报',
      description: '每天九点把昨天的进展整理成一条消息',
      pattern: '0 9 * * *',
      enabled: true,
      command: '整理昨天的进展，写成一条简报',
      currentCalls: 12,
      createdMinutesAgo: 60 * 24 * 30,
      updatedMinutesAgo: 60 * 5,
      // 改了模型与推理强度：这两项正是"改名字时最容易被清空"的字段。
      execution: {
        run_target: 'new_session',
        model_id: 'deepseek-v4-flash',
        reasoning_effort: 'medium',
      },
    }),
    newSchedule({
      id: 'fixture-schedule-quarter',
      name: '汇总销售日报',
      description: '每十五分钟抓一次昨天的订单表',
      pattern: '*/15 * * * *',
      enabled: false,
      command: '汇总昨天的订单，输出一张表',
      currentCalls: 340,
      createdMinutesAgo: 60 * 24 * 12,
      updatedMinutesAgo: 60 * 26,
      // `run_target: 'session'` 必须和 `target_session_id` 成对出现：只给前者，
      // 界面会显示"复用某个会话"却指不出是哪一个——那种半配置状态不该由固定数据制造。
      execution: {
        run_target: 'session',
        target_session_id: 'fixture-session-active',
        runtime_type: 'native',
        workdir_id: 'fixture-workdir-home',
      },
    }),
    newSchedule({
      id: 'fixture-schedule-hourly',
      name: '每小时巡检',
      description: '服务健康状态，出问题才说话',
      pattern: '0 * * * *',
      enabled: true,
      command: '检查服务健康状态，异常时把问题列出来',
      currentCalls: 5,
      createdMinutesAgo: 60 * 24 * 3,
      updatedMinutesAgo: 2,
      execution: { run_target: 'new_session' },
    }),
  ];

  // 日志与任务一一对应（`schedule_id` 各一条）：列表行的"最近一次"是从这里归并出来的，
  // 多给几条旧日志不会让画面更真，只会让"哪条是最近一次"变成需要推理的事。
  const logs = [
    newLog({
      id: 'fixture-log-morning',
      scheduleId: 'fixture-schedule-morning',
      status: 'ok',
      resultText: '已生成早报：3 条进展、1 条阻塞',
      sessionId: 'fixture-schedule-run-morning',
      startedMinutesAgo: 60 * 5,
      durationMinutes: 2,
    }),
    newLog({
      id: 'fixture-log-quarter',
      scheduleId: 'fixture-schedule-quarter',
      status: 'error',
      errorMessage: '工作目录不存在：/workspace/reports',
      startedMinutesAgo: 20,
      durationMinutes: 1,
    }),
    newLog({
      id: 'fixture-log-hourly',
      scheduleId: 'fixture-schedule-hourly',
      /**
       正在跑的那一次。⚠️ 形状照**真服务端**：`status='ok'` 且**没有** `completed_at`。
       服务端从不发 `status: 'running'`——`schedule_logs.status` 的 CHECK 只允许
       ('ok','error')，插入时不写 status 就默认成 'ok'（见
       `docs/research/schedule-server-behaviour.md` §5，dev 实例上抓到过这样一行）。
       所以"正在跑"在协议里是**两个字段合起来**才成立的状态，客户端也照这个判
       （`model.ts` 的 `lastRunState(status, completedAt)`）。这里要是图省事写一个
       `status: 'running'`，固定数据就编出了一个真服务端永远不会给的值，
       顺带把"把正在跑显示成成功"那条 bug（正是这条数据要防的）从验收里放走了。
       */
      status: 'ok',
      startedMinutesAgo: 2,
    }),
  ];

  return { items, logs };
}

/** 长列表用的图案，几种轮换（全是客户端算得出"下次执行"的形态）。 */
const MANY_PATTERNS = ['*/5 * * * *', '0 9 * * *', '0 */2 * * *', '30 2 * * 1', '15 8 * * 1-5'];

/**
 `schedule-many`：40 条，名字带序号、图案轮换，日志只给其中一部分。

 日志故意**不是每条都有**：界面必须能同时渲染"最近一次成功了"和"还没跑过"两种行，
 而只给全量日志的话第二种样子永远不会出现在截图里。
 */
function manyScheduleSeed() {
  const items = [];
  const logs = [];
  for (let index = 1; index <= 40; index += 1) {
    const reused = index % 5 === 0;
    items.push(
      newSchedule({
        id: `fixture-schedule-bulk-${index}`,
        name: `批量任务 ${index}：${MANY_PATTERNS[index % MANY_PATTERNS.length]}`,
        description: `第 ${index} 条，用来撑开长列表`,
        pattern: MANY_PATTERNS[index % MANY_PATTERNS.length],
        enabled: index % 3 !== 0,
        command: `执行第 ${index} 项巡检并把结果发给我`,
        currentCalls: index,
        createdMinutesAgo: 60 * 24 * (index + 2),
        updatedMinutesAgo: index * 90,
        execution: {
          run_target: reused ? 'session' : 'new_session',
          target_session_id: reused ? 'fixture-session-active' : '',
          model_id: index % 4 === 0 ? 'kimi-k3' : '',
        },
      }),
    );
    if (index % 3 === 0) {
      const failed = index % 6 === 0;
      logs.push(
        newLog({
          id: `fixture-log-bulk-${index}`,
          scheduleId: `fixture-schedule-bulk-${index}`,
          status: failed ? 'error' : 'ok',
          resultText: failed ? '' : `第 ${index} 项完成`,
          errorMessage: failed ? '上游返回 502' : '',
          startedMinutesAgo: index * 90 - 5,
          // **跑完的每一次都要有 completed_at**：客户端把"没有 completed_at"
          // 判成"还在跑"（真服务端也是这么表达的）。一条失败的日志缺了它，
          // 界面上会显示成"正在运行"——固定数据不该制造这种自相矛盾的行。
          durationMinutes: failed ? 1 : 3,
        }),
      );
    }
  }
  return { items, logs };
}

/** 按场景给一份任务与日志。非 `schedule-*` 场景用默认那三条（定时视图随时能看）。 */
function scheduleSeedFor(scenario) {
  if (scenario === 'schedule-empty') return { items: [], logs: [] };
  if (scenario === 'schedule-many') return manyScheduleSeed();
  // `schedule-error` 也用默认那三条：失败是**传输层**的状态，不是"数据被删了"。
  // 这样切回来（重试）时看到的是同一份数据，而不是一片空白。
  return defaultScheduleSeed();
}

/** 当前场景下的任务与日志。会随 POST/PUT/DELETE 变化，所以是 `let`。 */
let SCHEDULES = [];
let SCHEDULE_LOGS = [];
/** 新建任务时的序号：id 只要在进程内唯一就够（客户端拿它做 key）。 */
let scheduleSerial = 0;

/**
 切场景：**重建**定时任务数据与文件树覆盖层。

 ⚠️ 重建而不是"就地改回去"是刻意的：`schedule-*` 之间来回切的时候，上一条场景里
 POST 出来的任务、PUT 改过的字段都不能跟过来，否则同一个场景名在不同轮次截出来的
 图不一样，基线就没法比。
 */
/** 客户端最近发来的一条消息帧（`GET /__last-client-message` 读它）。 */
let lastClientMessage = null;

/**
 bot 设置的当前值（`GET/POST /bots/{id}/settings` 读写它）。

 初始值 = 老的那些固定字段（`SETTINGS`，之前几轮就在用）+ 这一轮 bot 设置页要读写的三个。
 合并成一份是为了**只有一个真源**：分成两份的话，"客户端读了 A、写进 B"这种错会看不出来。
 */
let currentBotSettings = {
  ...SETTINGS,
  chat_model_id: '',
  reasoning_effort: '',
  // 对话语言：服务端读回来的默认值就是字符串 `"auto"`（实测部署实例）。
  language: 'auto',
  display_enabled: true,
};

/** 客户端最近一次回应审批的帧（`GET /__last-approval-response` 读它）。 */
let lastApprovalResponse = null;

/** 客户端最近一次写定时任务（`GET /__last-schedule-write` 读它）。 */
let lastScheduleWrite = null;

/**
 定时任务的**整条写史**（`GET /__schedule-log` 读它）。

 `__last-schedule-write` 只留最后一条，而端到端旅程要验的是一串有前后依赖的动作：
 新建写了什么、编辑那次**只**改了什么、删除删掉的是不是刚刚建出来的那一条。
 只留最后一条时，"删的是哪一条"根本无从回答。
 */
let scheduleWrites = [];
let scheduleDeletes = [];

/** 手动压缩被调用了几次（`GET /__compactions` 读它）。 */
let compactCalls = 0;

/**
 会话列表端点被问了几次、最后一次回的是什么状态（`GET /__scenario` 读它）。

 为什么要这两个数：**"界面没变"至少有三种完全不同的原因**——请求压根没发、发了但拿到
 200（那本来就不该有错误）、或者发了拿到 500 而界面没渲染。光看截图分不出是哪一种，
 于是容易去改错的地方（本轮为"点了重试界面看上去像好了"查了几轮，靠这两个数才定位）。
 */
let sessionsListHits = 0;
let lastSessionsStatus = 0;

/**
 分页那两次"往前/往后拿一页"的请求流水（`GET /__page-log` 读它）。

 为什么值得记：这几条断言的核心是**游标留着没有**——失败之后重试，必须拿**同一个游标**
 再问一次（拿失败当"到底"的话，用户就再也翻不到旧内容了）。界面只能证明"重试之后好了"，
 证明不了它用的是哪个游标；而屏幕上的差别在这里只是一行数字。所以流水里存
 `{cursor, status}`，由验收脚本对照。
 */
let sessionPageRequests = [];
let olderHistoryRequests = [];

/** 客户端最近一次设置补丁（`GET /__last-settings-patch` 读它，验收断言"只发改过的字段"）。 */
let lastSettingsPatch = null;

/** 客户端最近一次 bot 本体更新（`PUT /bots/{id}`）。 */
let lastBotPatch = null;

/**
 端到端旅程要的三个人造状态。

 它们和 `wsFaultMode` 是同一类东西（"让服务端演一个坏情况"），但作用在**写**这一侧：

 - `loginFault`：登录必被拒（首次使用要验失败那一条）。可以给 `times`——**只拒前 N 次**，
   这样"先失败一次、再成功一次"能在**同一条 flow 里**走完（做不到的话就得在流程中途
   从外面改服务端，那种依赖会让你再也跑不动单条 flow）；
 - `writeFault`：bot 的两种写（`PUT /bots/{id}`、`POST /bots/{id}/settings`）必失败——
   设置页的"保存失败"必须真的被走到，否则那句错误文案是死代码；同样支持 `times`，
   于是"保存失败 → 再点一次 → 成功"是一条真实路径；
 - `gapOnce`：**只制造一次** seq 空洞。修好之后客户端重订阅，第二次就要给一份正常的
   快照（否则会验成"永远好不了"，那不是自愈）。
 */
let loginFault = { mode: 'normal', remaining: 0 };
let writeFault = { mode: 'normal', remaining: 0 };

/** `times` 省略 = 一直拒/一直败；给了数字 = 只算前几次，之后自动恢复正常。 */
function faultFrom(body) {
  const active = body.mode === 'reject' || body.mode === 'fail';
  const times = typeof body.times === 'number' && body.times > 0 ? body.times : Infinity;
  return { mode: active ? body.mode : 'normal', remaining: active ? times : 0 };
}

/** 取一次故障额度：还有额度就消耗一个并返回 true。 */
function takeFault(fault) {
  if (fault.mode === 'normal') return false;
  if (fault.remaining <= 0) return false;
  if (Number.isFinite(fault.remaining)) fault.remaining -= 1;
  return true;
}
let gapOnceSent = false;
/** 旅程里新建出来的会话（`POST /bots/{id}/sessions`）。 */
let createdSessions = [];
/** 分叉出来的新 id → 源会话 id；REST 克隆源历史，WS 保持空闲。 */
let forkedSessionSources = new Map();
/** 重命名后的会话（按 id）；列表与单条查询共用。 */
let updatedSessions = new Map();
/** 会话写操作的请求账：UI 文案证明不了 body/锚点是否真的对。 */
let sessionActionPatches = [];
let sessionActionForks = [];

/**
 每个会话回显过几句用户消息（`runtime_delta.user_turn_upserts`）。

 回显的 `seq` 必须接在客户端当前游标之后，否则客户端判成空洞、去重订阅；而那个游标
 就是"场景回放发过多少帧"，所以每一句回显都要比上一句多一。
 声明必须在 `applyScenario` 之前（它在模块初始化时就会被调用一次）。
 */
const echoSeqs = new Map();

/**
 每个会话"这一轮要回显的用户文本"。

 为什么要单独存：新建会话的第一句是**先建会话、再由客户端订阅**才回放的
 （`session_created` → store 里的 `openSession` → 订阅）。订阅那一步服务端并不知道
 用户刚说了什么，只有把文本记在这里，回放的才是**我发的那一句**；否则屏幕上会冒出
 场景里写死的那句（"跑一遍测试，然后把结果写进报告"），看起来像串了会话。
 */
const pendingEcho = new Map();

/** 已经订阅过的会话（给"客户端没订阅时兜底回放"用，避免同一轮放两遍）。 */
const subscribedSessions = new Set();

/**
 切场景。

 ⚠️ 这里不只是"记下名字"：**按场景重建**所有会在场景内被改动的状态。否则「先看 schedule-default、
 再切 schedule-error」时，上一条场景改过的数据会跟着进下一张截图，看起来像无缘无故的回归。

 错误/失败类场景（本文件里搜场景名就能找到它们各自的分支）：
 `home-error` / `home-denied` / `sessions-timeout` / `home-empty` / `bots-error` / `bot-error` /
 `fs-error` / `fs-missing` / `models-error` / `schedule-error` / `schedule-save-error` /
 `skills-error` / `compact-unavailable` / `login-rejected` / `login-error`。
 分页与缺字段那几档（2026-09-17 加，都是"以前造不出来的形状"）：
 `sessions-paged`（真有下一页）/ `sessions-more-error`（第二页 500）/ `sessions-sparse`
 （会话缺字段与 `null` 标题）/ `chat-older-error`（往前翻页 500）/ `chat-older-ok`
 （往前翻页成功，验"重试真的有用"）。
 */
function applyScenario(name) {
  currentScenario = name;
  echoSeqs.clear();
  pendingEcho.clear();
  subscribedSessions.clear();
  const seed = scheduleSeedFor(name);
  SCHEDULES = seed.items;
  SCHEDULE_LOGS = seed.logs;
  FS_OVERLAY = name === 'fs-many' ? fsManyNodes() : new Map();
  // 新建/删除 bot 是**场景内的**副作用，和定时任务同一个道理：不重建就会让
  // 「先跑创建流程、再看别的场景」把建出来的 bot 带进下一张截图。
  createdBots = [];
  createdPolls = new Map();
  updatedBots = new Map();
  currentBotSettings = {
    ...SETTINGS,
    chat_model_id: '',
    reasoning_effort: '',
    language: 'auto',
    display_enabled: true,
  };
  lastSettingsPatch = null;
  lastBotPatch = null;
  lastApprovalResponse = null;
  lastScheduleWrite = null;
  scheduleWrites = [];
  scheduleDeletes = [];
  compactCalls = 0;
  sessionsListHits = 0;
  lastSessionsStatus = 0;
  // 分页流水也属于场景状态：切场景必须归零，否则"这一次重试用的是哪个游标"会被上一次
  // 场景的记录搅混（那是**审计**记录，脏了就没法当证据）。
  sessionPageRequests = [];
  olderHistoryRequests = [];
  lastClientMessage = null;
  // 弱网故障也属于"场景内的状态"：切场景必须回到该场景该有的形状，
  // 否则上一次跑出来的 `flap` 会跟着进下一条场景，看起来像"无缘无故一直断"。
  wsFaultMode = faultForScenario(name);
  tokenRejected = false;
  // 三个"人造状态"也属于场景内的状态：切场景必须回到正常，否则上一条旅程打开的
  // 故障会跟过来（表现是"下一条旅程莫名其妙登录不上"，最难查的那一类）。
  loginFault = { mode: 'normal', remaining: 0 };
  writeFault = { mode: 'normal', remaining: 0 };
  gapOnceSent = false;
  createdSessions = [];
  forkedSessionSources = new Map();
  updatedSessions = new Map();
  sessionActionPatches = [];
  sessionActionForks = [];
  resetWsLog();
}

/**
 容器文件树的固定数据。

 ## 为什么列表**故意不排序**

 dirs-first + 自然序（`file2` 在 `file10` 前）是**客户端**行为
 （`src/features/files/entries.ts`）。固定服务端如果替客户端排好序，那条断言就等于被删掉了：
 截图里看不出客户端到底做了没做。所以这里的顺序是刻意打乱的。

 ## 时间为什么要相对"现在"算

 会话与设置的固定时点（`NOW`）是为了截图可比；而文件行的"2 小时前 / 昨天 / 3 天前"是
 相对时间的分档显示，写死一个绝对时间只会让每一行都显示成"x 天前"，看不出分档。

 ## 内容

 `text` 给 `fs/read`，`bytes` 给 `fs/download`（嗅探首字节走 Range 请求）。两者都可以省略。
 */
const FS_MINUTES = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function fsFile(path, options) {
  const text = options.text ?? '';
  return {
    path,
    isDir: false,
    size: options.size ?? Buffer.byteLength(text, 'utf8'),
    modTime: FS_MINUTES(options.minutes ?? 60),
    mode: options.mode ?? '-rw-r--r--',
    text: options.text,
    bytes: options.bytes,
  };
}

function fsDir(path, children, minutes) {
  return { path, isDir: true, size: 0, modTime: FS_MINUTES(minutes), children };
}

/** 大目录：用来验证 500 行截断与「显示更多」。名字不补零，顺手证明自然序。 */
function fsMany() {
  const children = [];
  for (let index = 1; index <= 520; index += 1) {
    children.push(`data/many/file-${index}.log`);
  }
  return children;
}

const FS_NODES = new Map();
for (const node of [
  fsDir(
    'data',
    [
      'data/README.md',
      'data/bundle.tar.gz',
      'data/docs',
      'data/app.config.ts',
      'data/icon.png',
      'data/LICENSE',
      'data/many',
      'data/notes.txt',
      'data/pnpm-workspace.yaml',
      'data/huge.log',
      'data/blob',
      'data/apps',
      'data/wide.txt',
    ],
    30,
  ),
  fsDir('data/docs', ['data/docs/spec.md', 'data/docs/guide.md'], 60 * 24 * 2),
  fsDir('data/apps', ['data/apps/server', 'data/apps/dev.sh', 'data/apps/mobile'], 60 * 6),
  // 空目录：验证空态那一句文案（不是插图，也不是错误行）。
  fsDir('data/apps/mobile', [], 60 * 6),
  fsDir('data/apps/server', ['data/apps/server/main.go'], 60 * 6),
  fsDir('data/many', fsMany(), 60 * 12),
  fsFile('data/README.md', {
    minutes: 120,
    size: 4300,
    text: '# Memoh iOS\n\n独立维护的 **Memoh** 原生 iOS 客户端。\n\n- 上游：https://github.com/felinics/Memoh\n- 本仓库：AidenNovak/memoh-ios\n',
  }),
  fsFile('data/pnpm-workspace.yaml', { minutes: 60 * 26, text: "packages:\n  - 'apps/*'\n" }),
  fsFile('data/app.config.ts', {
    minutes: 60 * 30,
    text: "export default { name: 'Memoh', scheme: 'memoh' };\n",
  }),
  // 图片与压缩包：扩展名就足够判二进制，永远不会走 fs/read。
  /**
   ⚠️ 这里给的是**真的能解出来的 PNG**（16x16，135 字节），不是"8 字节的文件头"。

   以前只放 PNG 的魔数就够了——那时验的是"客户端有没有按首字节判类型"。但只要有人
   去验**图片预览这一支**，假的字节就会让界面落到"这张图加载不了"那条错误分支上：
   屏幕上照样有话说，验收却以为验过了图片预览（2026-09-16 端到端旅程就是这么红起来的）。
   `size` 仍然报一个像真图的尺寸（192 KB），界面上的尺寸说明才有东西可显示。
   */
  fsFile('data/icon.png', {
    minutes: 60 * 24 * 3,
    size: 196608,
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAATklEQVR42qXEoRWCAAAA0RuHaDQSjUYeyWgkEolEI5Fx2Apvhwv/M8zXXfCwgqcVjFbwsoK3FUxW8LGCrxUsVrBawWYFuxX8rOCwgtOKPyy+hR8fYUpfAAAAAElFTkSuQmCC',
      'base64',
    ),
  }),
  fsFile('data/bundle.tar.gz', {
    minutes: 60 * 24 * 5,
    size: 50331648,
    bytes: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
  }),
  // 超过 512 KiB 的文本：只给下载（"太大"是一等结果）。
  fsFile('data/huge.log', {
    minutes: 45,
    text: 'x'.repeat(4096),
    size: 1228800,
  }),
  fsFile('data/notes.txt', { minutes: 8, text: '出门前记得把手机充电器带上\n' }),
  // 没有扩展名：扩展名不可信 → 嗅探首字节 → 是文本。
  fsFile('data/LICENSE', {
    minutes: 60 * 48,
    text: 'MIT License\n\nCopyright (c) 2026 Aiden Novak\n',
  }),
  // 没有扩展名且真的含 NUL：嗅探成二进制。
  fsFile('data/blob', {
    minutes: 60 * 4,
    bytes: Buffer.concat([
      Buffer.from('BLOB'),
      Buffer.alloc(64),
      Buffer.from('\u0000\u0001\u0002', 'binary'),
    ]),
  }),
  // 单行 300 字符：验证长行横向滚动、不折行。
  fsFile('data/wide.txt', {
    minutes: 60,
    text: `一行很长的文本：${'0123456789'.repeat(30)}\n第二行短一些\n`,
  }),
  fsFile('data/docs/guide.md', { minutes: 20, text: '# 使用说明\n\n先从会话页进文件视图。\n' }),
  fsFile('data/docs/spec.md', { minutes: 60 * 24 * 2, text: '# 规格\n\n一页一目录。\n' }),
  fsFile('data/apps/dev.sh', { minutes: 60 * 3, text: '#!/bin/sh\npnpm start\n' }),
  fsFile('data/apps/server/main.go', { minutes: 60 * 5, text: 'package main\n\nfunc main() {}\n' }),
]) {
  FS_NODES.set(node.path, node);
}

/**
 场景专属的文件树覆盖层（当前只有 `fs-many` 用）。

 为什么是"覆盖"而不是重建整棵树：默认场景里的 `data/many` 有 520 个文件，
 顶着"500 行截断 + 显示更多"那条断言——多了一个长列表场景不能把它挤掉。
 覆盖层只在这个场景生效，其余场景是空 Map，等于不存在。
 */
let FS_OVERLAY = new Map();

/**
 `fs-many`：让 `data/` 下有 **300 项**（目录与文件混合、大小与时间各不相同）。

 两项刻意设计：

 - **顺序不打乱**：四分之一是目录，天然和文件交错。dirs-first 是客户端行为
   （`src/features/files/entries.ts`），这里替它排好序就等于把那条断言删了。
 - **时间与大小都不同**：相对时间的分档（"8 分钟前 / 昨天 / 3 天前"）与大小列
   都要在滚动的过程中有变化，否则看不出某一行是不是渲染错了。
 */
function fsManyNodes() {
  const nodes = new Map();
  const children = [];
  for (let index = 1; index <= 300; index += 1) {
    if (index % 4 === 0) {
      const dirPath = `data/batch-${index}`;
      const innerPath = `${dirPath}/summary.md`;
      nodes.set(dirPath, fsDir(dirPath, [innerPath], index * 90));
      nodes.set(
        innerPath,
        fsFile(innerPath, { minutes: index * 90 - 10, text: `# 第 ${index} 批\n` }),
      );
      children.push(dirPath);
      continue;
    }
    const filePath = `data/report-${index}.log`;
    nodes.set(
      filePath,
      // 45 分钟一档：滚到后面就是"1 天前 / 5 天前 / 9 天前"，相对时间的分档看得见。
      fsFile(filePath, { minutes: index * 45, size: 120 * index, text: `第 ${index} 号报告\n` }),
    );
    children.push(filePath);
  }
  nodes.set('data', fsDir('data', children, 30));
  return nodes;
}

/** 取一个节点：场景覆盖层优先，然后是默认树。 */
function fsNode(path) {
  const overlaid = FS_OVERLAY.get(path);
  return overlaid === undefined ? FS_NODES.get(path) : overlaid;
}

/** 目录项的形状：**camelCase**，`isDir` / `modTime`（全仓库唯一例外）。 */
function fsEntry(node) {
  const name = node.path.slice(node.path.lastIndexOf('/') + 1);
  return {
    name,
    path: `/${node.path}`,
    isDir: node.isDir === true,
    size: node.isDir === true ? 0 : node.size,
    modTime: node.modTime,
    mode: node.isDir === true ? 'drwxr-xr-x' : node.mode,
  };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = request.method ?? 'GET';

  // 记一行请求。这不是调试残留：验收失败时最先要问的就是"客户端到底请求了什么"，
  // 而失败信息里只有"屏幕上没出现某段文字"。有了这行就能立刻分辨
  // "客户端没请求" / "请求了但响应形状不对" / "响应对了但没渲染"。
  console.log(`${method} ${path}${url.search}`);

  /**
   凭据被服务端拒掉的那个开关。
   
   真服务器上"token 失效"是**同时**发生在 REST 与 WS 上的；这里把它做成一个开关是
   为了能把两种现象分开验：只看 WS 的话，客户端只看到"一次没升成 101 的失败"，
   和断网长得一模一样——那正是要验的那条边界。
   */
  if (tokenRejected && typeof request.headers.authorization === 'string') {
    return json(response, 401, { message: 'token expired', code: 'unauthorized' });
  }

  /**
    场景切换（POST）与场景读取（GET）。

    `GET` 顺带回 `sessionsListHits` / `lastSessionsStatus`：断言"界面没说话"时，
    先分清是**没发请求**还是**发了但拿到了 200**——两者要改的地方完全不同。
    （以前这里不分方法，`GET` 也会去读 body；现在读只读。）
   */
  if (path === '/__scenario') {
    const body = await readBody(request);
    // 走 `applyScenario` 而不是直接赋值：切场景要把定时任务的数据**重建**回该场景
    // 该有的样子（见那边的注释），否则上一条场景里 POST/PUT 出来的东西会跟过来。
    if (method === 'POST' && typeof body.scenario === 'string') applyScenario(body.scenario);
    return json(response, 200, { scenario: currentScenario, sessionsListHits, lastSessionsStatus });
  }

  /**
   分页流水（`{cursor, status}` 逐条记）：验收断言"失败之后重试拿的是**同一个游标**"。
   界面只能证明"重试之后好了"，证明不了它用的是哪个游标。
   */
  if (path === '/__page-log' && method === 'GET') {
    return json(response, 200, { sessions: sessionPageRequests, older: olderHistoryRequests });
  }

  /**
   WS 观测台与运行时故障开关。
   
   `POST /__ws-fault {"mode":"flap"}`：跑着的时候把坏网络打开（或 `"normal"` 关掉）。
   `POST /__ws-drop`：把所有活着的连接掐掉（模拟"走着走着网断了"）。
   `GET  /__ws-log`：连接数、客户端帧的顺序、每个会话被订阅了几次。
   */
  if (path === '/__ws-fault' && method === 'POST') {
    const body = await readBody(request);
    wsFaultMode = typeof body.mode === 'string' ? body.mode : 'normal';
    // `tokenRejected`：REST 一侧也回 401（真服务端上这两件事是一起发生的）。
    if (typeof body.tokenRejected === 'boolean') tokenRejected = body.tokenRejected;
    if (typeof body.cycleMs === 'number') cycleMs = body.cycleMs;
    // `dropConnections`：把当前活着的连接全掐掉（等价于 /__ws-drop，少一次往返）。
    if (body.dropConnections === true) {
      for (const socket of liveSockets) socket.destroy();
      liveSockets.clear();
    }
    // `reset`：观测台归零。实验台每跑一个场景都要归零，否则计数是**累积**的
    // （踩过：上一个场景的 6 次连接被算进了下一个场景，看起来像"它在猛连"）。
    if (body.reset === true) resetWsLog();
    return json(response, 200, { mode: wsFaultMode, tokenRejected });
  }
  if (path === '/__ws-log' && method === 'GET') {
    return json(response, 200, wsLog);
  }

  /**
   * 自部署登录前的身份探测。真客户端不会先把口令发给一个未知地址：只有 `/ping`
   * 明确回答 `status: "ok"`，并且空载荷 `/auth/login` 证明登录路由存在后，才会提交
   * 用户名与密码。fixture 必须保留这道边界，不能只靠 verification seed 绕过去。
   */
  if (path === '/ping' && method === 'GET') {
    return json(response, 200, { status: 'ok' });
  }

  /**
   写侧的两个故障开关（端到端旅程用）。

   `POST /__auth-fault {"mode":"reject"|"normal"}`：登录回 401。
   `POST /__write-fault {"mode":"fail"|"normal"}`：bot 的两种写回 500。
   分开两个端点而不是塞进 `/__ws-fault`：WS 故障与写故障是两件事，
   名字里说清楚就不会有人以为"打开弱网会把保存也弄坏"。
   */
  if (path === '/__auth-fault' && method === 'POST') {
    const body = await readBody(request);
    loginFault = faultFrom(body);
    return json(response, 200, { mode: loginFault.mode, remaining: loginFault.remaining });
  }
  if (path === '/__write-fault' && method === 'POST') {
    const body = await readBody(request);
    writeFault = faultFrom(body);
    return json(response, 200, { mode: writeFault.mode, remaining: writeFault.remaining });
  }
  if (path === '/__ws-drop' && method === 'POST') {
    // 只掐**当前活着**的连接：客户端会重连，重连后的新连接不受影响。
    const dropped = liveSockets.size;
    for (const socket of liveSockets) socket.destroy();
    liveSockets.clear();
    return json(response, 200, { dropped });
  }

  if (path === '/auth/login' && method === 'POST') {
    const body = await readBody(request);
    // 空载荷是客户端的安全探针，不是真登录，不能消耗一次性登录故障额度。
    if (
      typeof body.username !== 'string' ||
      body.username.trim() === '' ||
      typeof body.password !== 'string' ||
      body.password === ''
    ) {
      return json(response, 400, { message: 'username and password are required' });
    }
    // 凭据被拒：真服务端的形状是 401 + `message`，客户端据此说"用户名或密码不对"。
    // 由 `POST /__auth-fault {"mode":"reject"}` 打开（E2E 的首次使用路径要**先走一遍失败**：
    // 只验成功那条路，"登录失败时界面说了什么"就永远没人看过）。
    if (takeFault(loginFault) || currentScenario === 'login-rejected') {
      return json(response, 401, { message: 'invalid credentials' });
    }
    /**
      `login-error`：**服务端自己坏了**（500）。

      响应体刻意写成"给开发者看的样子"（Postgres 的报错），而且**不带 `code`**：
      客户端必须只说我们自己的那句，不能把这串数据库错误倒到登录页上
      （`features/errors/present.ts` 的判据：没有类型化错误码就不透出原文）。
      E2E 断言里会**断言这串字看不见**——"不该出现的东西不出现"也是一种断言。
     */
    if (currentScenario === 'login-error') {
      return json(response, 500, {
        error: 'pq: relation "users" does not exist (fixture scenario)',
      });
    }
    return json(response, 200, {
      access_token: TOKEN,
      token_type: 'Bearer',
      expires_at: new Date(NOW.getTime() + 168 * 3600_000).toISOString(),
      user_id: 'fixture-user',
      role: 'admin',
      display_name: 'Fixture User',
      username: 'fixture',
      timezone: 'Asia/Shanghai',
    });
  }
  if (path === '/auth/refresh' && method === 'POST') {
    return json(response, 200, {
      access_token: TOKEN,
      token_type: 'Bearer',
      expires_at: new Date(NOW.getTime() + 168 * 3600_000).toISOString(),
    });
  }
  if (path === '/users/me') {
    return json(response, 200, {
      user_id: 'fixture-user',
      username: 'fixture',
      display_name: 'Fixture User',
      role: 'admin',
      timezone: 'Asia/Shanghai',
    });
  }

  if (path === '/bots' && method === 'GET') {
    /**
      `bots-error`：**第一个失败的其实是 /bots**，而会话列表在拿不到 bot 时根本不发请求
      （没有 botId），于是界面会停在"还没有会话"上——那是假话。所以这条场景要能造出来：
      离线/服务端坏掉时，屏幕上必须是"没拉到"，不是"你还没有会话"。
     */
    if (currentScenario === 'bots-error') {
      return json(response, 500, { error: 'bots unavailable (fixture scenario)' });
    }
    if (currentScenario === 'bots-many') {
      // 新建出来的那些也进列表：这样"建完回到列表能看到它"这件事在验收里也能验。
      return json(response, 200, { items: [...manyBots(), ...createdBots] });
    }
    /**
      `bots-avatar-missing`：`avatar_url` 这个 key 整个不存在 / 是 `null`（见 `avatarShapeBots`）。
      以前固定服务端只会给 `''`，于是"客户端把这个字段当必然存在"的写法验不出来。
     */
    if (currentScenario === 'bots-avatar-missing') {
      return json(response, 200, { items: [...avatarShapeBots(), ...createdBots] });
    }
    return json(response, 200, { items: [activeBot(), ...createdBots] });
  }

  // 名字可用性：400ms 防抖的那条路。四种 reason 都要有，界面才会四条分支都走到。
  if (path === '/bots/name-availability' && method === 'GET') {
    return json(response, 200, nameAvailability(url.searchParams.get('name') ?? ''));
  }

  if (path === '/bots' && method === 'POST') {
    const body = await readBody(request);
    const availability = nameAvailability(String(body.name ?? ''));
    if (!availability.available) {
      return json(response, availability.reason === 'taken' ? 409 : 400, {
        message: availability.reason,
        field: 'name',
      });
    }
    const created = {
      ...activeBot(),
      id: `fixture-bot-${createdBots.length + 1}`,
      name: String(body.name ?? ''),
      display_name: String(body.display_name ?? ''),
      avatar_url: String(body.avatar_url ?? ''),
      timezone: String(body.timezone ?? BOT.timezone),
      status: 'creating',
    };
    createdBots = [...createdBots, created];
    createdPolls = new Map(createdPolls).set(created.id, 0);
    return json(response, 201, created);
  }

  const oneBot = path.match(/^\/bots\/([^/]+)$/);
  if (oneBot !== null && method === 'GET') {
    /**
      `bot-error`：单个 bot 读不到 → **bot 设置页**整页没有内容可显示。

      验证的是"取不到时不要画成一个空表单"：空表单会被读成"这个 bot 什么设置都没有"，
      而真相是"我们没读到"。所以那一屏要给错误块（含原因与能不能重试），不是空字段。
     */
    if (currentScenario === 'bot-error') {
      return json(response, 500, { error: 'bot unavailable (fixture scenario)' });
    }
    const id = oneBot[1];
    const created = createdBots.find((bot) => bot.id === id);
    if (created === undefined) {
      /**
        `bots-avatar-missing` 下按 id 取也要给同一个形状：界面会"先列表、再按当前 bot 取一次"
        （会话页头用的就是取回来那条）。只改列表的话，同一个 bug 在这条路上还是照旧红屏。
       */
      if (currentScenario === 'bots-avatar-missing') {
        const shaped = avatarShapeBots().find((bot) => bot.id === id);
        if (shaped !== undefined) return json(response, 200, shaped);
      }
      return id === BOT.id
        ? json(response, 200, activeBot())
        : json(response, 404, { message: 'not found' });
    }
    // 前两次问说"还在建"，之后说"就绪"：轮询状态机（creating → ready）必须被真走到。
    const polls = createdPolls.get(id) ?? 0;
    createdPolls = new Map(createdPolls).set(id, polls + 1);
    const status = polls < 2 ? 'creating' : 'ready';
    createdBots = createdBots.map((bot) => (bot.id === id ? { ...bot, status } : bot));
    return json(response, 200, { ...created, status });
  }

  if (oneBot !== null && method === 'PUT') {
    const body = await readBody(request);
    if (takeFault(writeFault)) {
      return json(response, 500, { message: 'update failed (fixture fault)' });
    }
    lastBotPatch = body;
    // 指针语义：只覆盖传了的键。
    const updated = { ...activeBot(), ...body, id: oneBot[1] };
    updatedBots = new Map(updatedBots).set(oneBot[1], updated);
    return json(response, 200, updated);
  }

  if (oneBot !== null && method === 'DELETE') {
    createdBots = createdBots.filter((bot) => bot.id !== oneBot[1]);
    return json(response, 204, {});
  }

  const sessionsMatch = path.match(/^\/bots\/([^/]+)\/sessions$/);
  if (sessionsMatch && method === 'GET') {
    // 计数在**所有分支之前**：它要回答的是"这个端点被问了几次"（包括被拒的那些），
    // 而不是"成功了几次"——诊断"界面没变"时这两种读法会得出相反的结论。
    sessionsListHits += 1;
    // 失败态：`home-error` 让会话列表 500。它和 `home-empty` 是**两种不同的画面**
    // ——"还没有会话"和"没拉到会话"用同一屏会撒谎（前者说的是事实，后者说的是猜测）。
    if (currentScenario === 'home-error') {
      lastSessionsStatus = 500;
      return json(response, 500, { error: 'sessions unavailable (fixture scenario)' });
    }
    /**
      `home-denied`：403。

      这一档存在的意义**不是**"多了个错误"，而是它**不可重试**：同一个请求再发一百次
      都是 403（要改的是权限，不是网络）。所以界面在这条场景里必须**不给重试按钮**
      ——给了就是在让用户做一件我们已经知道不会成的事（见
      `docs/research/ios-error-and-feedback.md` §3）。
     */
    if (currentScenario === 'home-denied') {
      lastSessionsStatus = 403;
      return json(response, 403, { error: 'forbidden (fixture scenario)' });
    }
    /**
      `sessions-timeout`：**挂了 20 秒不回应**。

      客户端的 REST 超时是 15s，所以这条路会走到 `code: 'timeout'`。
      它和"连不上"在界面上必须是**两句不同的话**：一个要换网络/看服务端，一个要等
      （`api/client.ts` 的注释里记着这条分档的理由）。
     */
    if (currentScenario === 'sessions-timeout') {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      lastSessionsStatus = 200;
      return json(response, 200, { items: activeSessions(), next_cursor: '' });
    }
    /**
     `sessions-paged` / `sessions-more-error`：**按游标出数据**。

     以前这里是"无视 cursor、永远回同一页 + `next_cursor: ''`"，于是列表尾部那两个状态
     （"还有更早的会话"、"没能拉到更早的会话"）在界面上永远不可能出现——验收里没有一帧
     能看见它们（见 `pagedSessionPage` 的注释）。

     `sessions-more-error` 只让**第二页**回 500：这样"第一页正常 + 尾部说'还有更早的'
     + 点下去失败"这条链是真的，而不是一开局就整页报错。
     */
    if (isPagedScenario(currentScenario)) {
      const cursor = url.searchParams.get('cursor') ?? '';
      const sizes = pagedPageSizes(currentScenario);
      const failsSecondPage =
        (currentScenario === 'sessions-more-error' ||
          currentScenario === 'sessions-more-error-short') &&
        cursor !== '';
      if (failsSecondPage) {
        lastSessionsStatus = 500;
        sessionPageRequests.push({ cursor, status: 500 });
        return json(response, 500, { error: 'sessions page unavailable (fixture scenario)' });
      }
      const page = pagedSessionPage(cursor, sizes);
      lastSessionsStatus = 200;
      sessionPageRequests.push({ cursor, status: 200 });
      return json(response, 200, { items: page.items, next_cursor: page.nextCursor });
    }
    // `next_cursor` 必须给：真实服务端用它表示"还有下一页"，**空串 = 到底**
    // （`ListSessionsResponse`）。固定服务端不返回这个字段时，客户端的
    // "再拉一批"会以为自己永远没到底（本轮就踩过：会话选择器的分页逻辑因此失真）。
    lastSessionsStatus = 200;
    return json(response, 200, { items: activeSessions(), next_cursor: '' });
  }
  /**
   `POST /bots/{id}/sessions` —— 新建一个会话（端到端旅程"新建会话 → 发消息"的起点）。

   真服务端返回的是新建出来的会话对象；这里照做，并把它放进列表与单条查询里，
   否则"新建之后回到列表能看到它"这条**依赖关系**就没法验（那正是旅程与单页 flow 的区别）。

   新建出来的会话**没有历史**（`turnsFor` 走 `chat-tool-stream` 的 `restHistory: 'none'`）：
   刚开的会话本来就该是空的，先塞一份历史会让"发送之后回的那一段"混进旧内容里。
   */
  if (sessionsMatch && method === 'POST') {
    const body = await readBody(request);
    const created = {
      ...SESSIONS[0],
      id: `fixture-session-created-${createdSessions.length + 1}`,
      title: typeof body.title === 'string' ? body.title : '',
      created_at: ISO(0),
      updated_at: ISO(0),
      last_message_at: '',
      message_count: 0,
    };
    createdSessions = [...createdSessions, created];
    return json(response, 201, created);
  }

  const oneSession = path.match(/^\/bots\/([^/]+)\/sessions\/([^/]+)$/);
  if (oneSession && method === 'GET') {
    // 在**当前场景**的列表里找：`sessions-many` 那 300 条也要能被点开，
    // 否则"长列表里点一行"这条路径会得到一个 404 而不是会话页。
    const found = activeSessions().find((session) => session.id === oneSession[2]);
    if (found === undefined) return json(response, 404, { error: 'not found' });
    return json(response, 200, found);
  }
  if (oneSession && method === 'PATCH') {
    const found = activeSessions().find((session) => session.id === oneSession[2]);
    if (found === undefined) return json(response, 404, { error: 'not found' });
    const body = await readBody(request);
    const updated = {
      ...found,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      id: found.id,
      updated_at: ISO(0),
    };
    updatedSessions = new Map(updatedSessions).set(found.id, updated);
    sessionActionPatches.push({ session_id: found.id, body });
    return json(response, 200, updated);
  }
  if (oneSession && method === 'DELETE') {
    return json(response, 204, {});
  }

  /**
   从最后一条助手回复分叉。

   这条不能用“随便回个 201”糊过去：产品动作随后会刷新列表、打开返回的 id，并读取那条
   新会话；fixture 必须把它真正放进内存列表，才能证明 UI → POST body → 刷新 → 跳转
   是一条闭环。非 chat 与空锚点照真实服务端分别回 409 / 400。
   */
  const forkPath = path.match(/^\/bots\/([^/]+)\/sessions\/([^/]+)\/fork$/);
  if (forkPath && method === 'POST') {
    const source = activeSessions().find((session) => session.id === forkPath[2]);
    if (source === undefined) return json(response, 404, { error: 'not found' });
    if (source.type !== 'chat') {
      return json(response, 409, { error: 'only chat sessions can be forked' });
    }
    const body = await readBody(request);
    if (typeof body.turn_id !== 'string' || body.turn_id.trim() === '') {
      return json(response, 400, { error: 'turn_id is required' });
    }
    const assistantTurnExists = historyForSession(source.id).some(
      (turn) => turn.role === 'assistant' && turn.turn_id === body.turn_id,
    );
    if (!assistantTurnExists) {
      return json(response, 400, { error: 'assistant turn not found' });
    }
    const created = {
      ...source,
      id: `fixture-session-created-${createdSessions.length + 1}`,
      title:
        typeof body.title === 'string' && body.title.trim() !== ''
          ? body.title
          : `${source.title} fork`,
      created_at: ISO(0),
      updated_at: ISO(0),
      last_message_at: ISO(0),
    };
    createdSessions = [created, ...createdSessions];
    forkedSessionSources = new Map(forkedSessionSources).set(created.id, source.id);
    sessionActionForks.push({
      source_session_id: source.id,
      body,
      created_session_id: created.id,
    });
    return json(response, 201, created);
  }

  // 会话队列：两条队列一起拿（与上游 GET /queue 同形）。
  const queuePath = path.match(/^\/bots\/([^/]+)\/sessions\/([^/]+)\/queue$/);
  if (queuePath && method === 'GET') {
    if (currentScenario !== 'queue') {
      return json(response, 200, { follow_up: [], steer: [], steer_supported: true });
    }
    return json(response, 200, QUEUE_ITEMS);
  }

  // 入队/删除/提级：验收只需要它们**能成功**（真正验证的是客户端发的请求形状，
  // 那部分在 tests/client.test.mjs 里断言）。
  if (/^\/bots\/[^/]+\/sessions\/[^/]+\/(follow-up|steer)-queue/.test(path)) {
    if (method === 'POST') {
      return json(response, 200, {
        item_id: 'queued-1',
        text: '',
        position: 1,
        status: 'accepted',
      });
    }
    if (method === 'DELETE') return json(response, 200, { ok: true });
  }

  const messages = path.match(/^\/bots\/([^/]+)\/messages$/);
  if (messages && method === 'GET') {
    const sessionId = url.searchParams.get('session_id') ?? '';
    /**
     往前翻页那一档（见 `OLDER_HISTORY_TURNS` 的注释）：第一页够长，`before_message_id`
     那一跳要么失败（`chat-older-error`，界面上必须出现"没能拉到更早的消息"），
     要么真的给更老的一页（`chat-older-ok`，点"重试"之后要真的接上内容）。

     ⚠️ 这一档除了是线上 `UITurn` 形状，还必须显式带每轮第一条记录的 `id`
     （`olderHistoryPageWire`）：它是向前翻页游标；普通 `turnsFor` 不需要合成这个字段。
     */
    if (isOlderHistoryScenario(currentScenario)) {
      const before = url.searchParams.get('before_message_id') ?? '';
      if (before === '') {
        return json(response, 200, {
          items: olderHistoryPageWire(
            1 + OLDER_HISTORY_TURNS - OLDER_HISTORY_PAGE_SIZE,
            OLDER_HISTORY_TURNS,
          ),
        });
      }
      if (currentScenario === 'chat-older-error') {
        olderHistoryRequests.push({ cursor: before, status: 500 });
        return json(response, 500, { error: 'older history unavailable (fixture scenario)' });
      }
      olderHistoryRequests.push({ cursor: before, status: 200 });
      /**
       更老的一页。`chat-older-ok` 里无论游标是什么都回同一页：这一档要验的是
       "点重试之后内容真的接上来了"，游标推进的算术不是它的题目（那也是纯函数
       `olderCursorOf` 的单测范围）。
       */
      return json(response, 200, {
        items: olderHistoryPageWire(
          Math.max(1, OLDER_HISTORY_TURNS - OLDER_HISTORY_PAGE_SIZE * 2 + 1),
          OLDER_HISTORY_TURNS - OLDER_HISTORY_PAGE_SIZE,
        ),
      });
    }
    return json(response, 200, { items: historyForSession(sessionId) });
  }

  /**
   bot 设置（`GET/POST /bots/{id}/settings`）。

   **指针语义**：`POST` 只覆盖传了的键（不传 = 保持、空串 = 清空）。固定服务端必须真的
   按这个语义实现，否则验收证明不了"只发改过的字段"——全量覆盖的假实现会让一条错的客户端
   也看起来是对的。
   */
  if (/^\/bots\/[^/]+\/settings$/.test(path)) {
    if (method === 'GET') return json(response, 200, currentBotSettings);
    const body = await readBody(request);
    if (takeFault(writeFault)) {
      return json(response, 500, { message: 'settings update failed (fixture fault)' });
    }
    lastSettingsPatch = body;
    /**
     语言这一个字段**不是**指针语义：真实服务端把空串归一化成 `"auto"`（`settings/service.go`
     的 `req.Language` 分支）。固定服务端照着做，否则"改回跟随"这条路在这里会被读成空串，
     客户端下次打开看到的就与真服务端不同（一个不会在真机上出现的形状）。
     */
    const merged = { ...currentBotSettings, ...body };
    if (merged.language === '') merged.language = 'auto';
    currentBotSettings = merged;
    return json(response, 200, currentBotSettings);
  }
  if (/^\/bots\/[^/]+\/checks$/.test(path)) {
    // 一条通过 + 一条**没通过**：切换器上那句"N 项未通过"要有对应的原文可看。
    return json(response, 200, {
      items: [
        {
          id: 'check-workspace',
          type: 'workspace',
          title_key: 'bots.checks.workspace',
          status: 'ok',
          summary: 'Workspace is running',
        },
        {
          id: 'check-model',
          type: 'model',
          title_key: 'bots.checks.model',
          status: 'failed',
          summary: 'No default model configured',
          detail: 'Pick a model in Chat, or set one for this bot.',
        },
      ],
    });
  }

  /**
   定时任务。三个动词三套形状（`docs/schedule.md` 对着 Go 源码核过）：

   - `GET`（列表/单条）→ **平铺**，`run_target` / `model_id` 这些直接在顶层；
   - `POST`（新建）    → **平铺**，返回 201 与建好的整条；
   - `PUT`（修改）     → `execution` **嵌套且整块替换**，其余字段是 patch（省略=不改）；
   - `DELETE`          → 204。

   ⚠️ 顺序上 `logs` 必须先匹配：它和 `/{id}` 是同一个前缀，先匹配 `/{id}` 的话
   `/schedule/logs` 会被当成"id 叫 logs 的任务"，得到一个 404。
   */
  const scheduleLogsRoute = path.match(/^\/bots\/([^/]+)\/schedule\/logs$/);
  if (scheduleLogsRoute !== null) {
    if (currentScenario === 'chat-only') {
      return json(response, 403, { error: 'bot access denied' });
    }
    if (method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const sorted = [...SCHEDULE_LOGS].sort(
        (left, right) => Date.parse(right.started_at) - Date.parse(left.started_at),
      );
      const page = sorted.slice(
        Number.isFinite(offset) ? Math.max(offset, 0) : 0,
        (Number.isFinite(offset) ? Math.max(offset, 0) : 0) + (Number.isFinite(limit) ? limit : 50),
      );
      // `total_count` 是**分页前**的总数：界面要靠它区分"就这么多"和"还有更多"。
      return json(response, 200, { items: page.map(wireLog), total_count: sorted.length });
    }
  }

  const scheduleCollection = path.match(/^\/bots\/([^/]+)\/schedule$/);
  if (scheduleCollection !== null) {
    if (currentScenario === 'chat-only') {
      return json(response, 403, { error: 'bot access denied' });
    }
    if (method === 'GET') {
      if (currentScenario === 'schedule-error') {
        return json(response, 500, { error: 'schedule unavailable (fixture scenario)' });
      }
      return json(response, 200, { items: SCHEDULES.map(wireSchedule) });
    }
    if (method === 'POST') {
      const body = await readBody(request);
      lastScheduleWrite = body;
      scheduleWrites.push({ method: 'POST', id: null, body });
      /**
        `schedule-save-error`：保存失败。

        保存是**写**，失败后用户手上就有那个 Save 按钮——所以界面该说的是"没保存上 + 为什么"，
        不该再挂一个"重试"（同一个动作说两遍）。这条场景就是用来钉住那句话真的会出现。
        这里**带 `code`**：写失败的服务端原文是"原因本身就是信息"的那一类。
       */
      if (currentScenario === 'schedule-save-error') {
        return json(response, 500, {
          code: 'schedule_write_conflict',
          message: 'another client changed this schedule',
        });
      }
      // 四个字段**一起**校验，而且返回 **500 而不是 400**（Go 那边是绑定失败，
      // 被统一错误中间件当成内部错误）。这条必须照抄，不能"顺手改合理"：
      // 界面靠它验"本地先拦，别让用户吃一个服务器错误"。
      //
      // 空字符串也算缺：Go 的 `binding:"required"` 判的是零值，界面也确实会在
      // 本地拦住空 name / description / command（见 ScheduleEditScreen 的保存前检查）。
      for (const field of ['name', 'description', 'pattern', 'command']) {
        if (typeof body[field] !== 'string' || body[field] === '') {
          return json(response, 500, {
            message: 'name, description, pattern, command are required',
          });
        }
      }
      scheduleSerial += 1;
      const created = newSchedule({
        id: `fixture-schedule-created-${scheduleSerial}`,
        botId: scheduleCollection[1],
        name: body.name,
        description: body.description,
        pattern: body.pattern,
        command: body.command,
        // `enabled` 缺省按 Go 的零值走（false）。客户端新建时总会显式给值，
        // 这里不替它决定"默认开着"。
        enabled: body.enabled === true,
        maxCalls: body.max_calls,
        currentCalls: 0,
        createdMinutesAgo: 0,
        updatedMinutesAgo: 0,
        // 新建是**平铺**：九个执行字段直接从顶层收（不是 `body.execution`）。
        execution: body,
      });
      SCHEDULES.push(created);
      return json(response, 201, wireSchedule(created));
    }
  }

  const scheduleOne = path.match(/^\/bots\/([^/]+)\/schedule\/([^/]+)$/);
  if (scheduleOne !== null) {
    if (currentScenario === 'chat-only') {
      return json(response, 403, { error: 'bot access denied' });
    }
    const index = SCHEDULES.findIndex((item) => item.id === scheduleOne[2]);
    if (method === 'GET') {
      if (currentScenario === 'schedule-error') {
        return json(response, 500, { error: 'schedule unavailable (fixture scenario)' });
      }
      if (index === -1) return json(response, 404, { error: 'schedule not found' });
      return json(response, 200, wireSchedule(SCHEDULES[index]));
    }
    if (method === 'PUT') {
      if (index === -1) return json(response, 404, { error: 'schedule not found' });
      const body = await readBody(request);
      lastScheduleWrite = body;
      scheduleWrites.push({ method: 'PUT', id: scheduleOne[2], body });
      /**
       ⚠️ 编辑已有任务是 **PUT**，不是 POST——`schedule-save-error` 必须两条路都覆盖。

       2026-09-16 实测踩到：只在 POST 分支挡了一下，于是"保存失败"那条验收实际验的是
       **保存成功**（界面照常退回列表、行名都改了），断言在错误块上失败，看起来像回归。
       客户端走哪条路由不能靠猜：`ScheduleEditScreen` 对已有任务是 PUT。
       */
      if (currentScenario === 'schedule-save-error') {
        return json(response, 500, {
          code: 'schedule_write_conflict',
          message: 'another client changed this schedule',
        });
      }
      const record = SCHEDULES[index];
      // **patch**：只覆盖请求里真的出现的键。省略 `name` 而把别的字段搞丢，
      // 正是这条端点最典型的错法，所以这里逐个 `in` 判断，不做整体替换。
      for (const field of ['name', 'description', 'pattern', 'command']) {
        if (field in body) record[field] = typeof body[field] === 'string' ? body[field] : '';
      }
      if ('enabled' in body) record.enabled = body.enabled === true;
      // `max_calls` 的三态：**省略=不改，`null`=取消上限**，数字=设上限。
      // 把 `null` 当成"不改"是这组端点最贵的一个错（用户以为取消了上限，其实还在）。
      if ('max_calls' in body) {
        record.max_calls = typeof body.max_calls === 'number' ? body.max_calls : null;
      }
      // `execution` 反过来是**整块替换**：块里字段之间有交叉约束，服务端只接受
      // 完整状态。没给的键按零值算（`executionOf` 就是这么做的）——只改 `model_id`
      // 却忘了带 `reasoning_effort`，那个字段就该被清掉，而不是"保持不变"。
      if ('execution' in body && typeof body.execution === 'object' && body.execution !== null) {
        record.execution = executionOf(body.execution);
      }
      // 改过就是"刚改过"：界面靠 updated_at 判断这一条是不是新的。
      record.updated_at = ISO(0);
      return json(response, 200, wireSchedule(record));
    }
    if (method === 'DELETE') {
      if (index === -1) return json(response, 404, { error: 'schedule not found' });
      const removed = SCHEDULES.splice(index, 1)[0];
      scheduleDeletes.push(removed.id);
      // 日志跟着任务一起消失：`schedule_logs.schedule_id` 的外键是 **ON DELETE CASCADE**
      // （`docs/research/schedule-server-behaviour.md` §2），任务行没了，它的日志行也留不住。
      // 界面上那句"历史日志留在服务端"其实和库里发生的事对不上——固定服务端要照**库**
      // 来，不能照文案来，否则"删掉任务后日志还在"这条差异永远不会被验收发现。
      SCHEDULE_LOGS = SCHEDULE_LOGS.filter((log) => log.schedule_id !== removed.id);
      response.writeHead(204);
      response.end();
      return;
    }
  }

  /**
   模型目录（`GET /models`）与 provider（`GET /providers`）。

   以前这里只有两条"有 id 有名字"的假模型。模型选择器是真读目录的界面（分组、搜索、
   思考档位全来自这两个响应），所以固定数据必须覆盖**四种形状**，否则验不到那些分支：
   `k3` 支持思考但关不掉、`deepseek-v4-flash` 可以关、`plain-fast` 不支持思考、
   另有一个 embedding 与一个停用模型（两者都不该出现在列表里）。
   第三家 provider `Internal Gateway` 是**名字认不出来**的那一态：分组标题旁边要落到中性
   兜底图标（不是空白）。见 `manyModels()`。
   */
  // 验收用：客户端最近发来的一条消息帧（含 model_id / reasoning_effort）。只读。
  if (path === '/__last-client-message') return json(response, 200, lastClientMessage);
  // 验收用：最近一次设置补丁 / bot 本体更新（证明"只发改过的字段"）。
  if (path === '/__compactions') return json(response, 200, { calls: compactCalls });
  // 整条写史（旅程用）：新建写了什么、编辑只改了什么、删的是哪一条。
  if (path === '/__schedule-log') {
    return json(response, 200, { writes: scheduleWrites, deletes: scheduleDeletes });
  }
  if (path === '/__last-schedule-write') return json(response, 200, lastScheduleWrite);
  if (path === '/__last-settings-patch') return json(response, 200, lastSettingsPatch);
  if (path === '/__session-action-log') {
    return json(response, 200, {
      patches: sessionActionPatches,
      forks: sessionActionForks,
    });
  }
  // 验收用：最近一次**回应审批**的帧（证明拒绝时那句理由真的随帧发出去了）。
  if (path === '/__last-approval-response') return json(response, 200, lastApprovalResponse);
  if (path === '/__last-bot-patch') return json(response, 200, lastBotPatch);

  /**
    `models-error`：模型目录拉不到。

    选择器是一页"只能靠列表"的界面——列表为空就等于这一页没有内容。所以失败要能造出来，
    而且它**该给重试**（列表请求是幂等的，服务端抖一下就会好），这与"这台部署没有模型"
    是两件事。
   */
  if (path === '/models') {
    if (currentScenario === 'models-error') {
      return json(response, 500, { error: 'models unavailable (fixture scenario)' });
    }
    return json(response, 200, manyModels());
  }

  /**
   技能清单（`GET /bots/{bot_id}/skills/catalog`）。形状照服务端的 `SafeCatalogItem`：
   `state` 是 `effective` 之类，只有运行时**可用**的才会在这里出现。
   斜杠菜单的技能组读它——所以固定数据里必须有两条真的技能，否则菜单只剩内置动作，
   "技能能被选中并发出去"这件事就验不到。
   */
  /**
   容器状态 / 用量 / 桌面能力（「机器」浮窗读这三个）。

   数据刻意让**两件事分开**：容器在跑，但这一轮任务闲着（`task_running:false`）——这正是
   桌面端两种不同的信号，界面把它们说成一句就错了。
   桌面能力给的是"开了、装了、没在推"（`running:false`）这一态：最能验出"不要把没在推
   说成不可用"。
   */
  if (/^\/bots\/[^/]+\/container$/.test(path)) {
    return json(response, 200, {
      container_id: 'workspace-fixture-bot',
      image: 'docker.io/memohai/workspace:debian-latest',
      status: 'running',
      task_running: false,
      namespace: 'default',
      container_path: '/data',
    });
  }
  if (/^\/bots\/[^/]+\/container\/metrics$/.test(path)) {
    return json(response, 200, {
      supported: true,
      backend: 'containerd',
      metrics: {
        cpu: { usage_percent: 0.23 },
        memory: { usage_bytes: 256708608 },
        storage: { used_bytes: 3560960002 },
      },
      resource_limits: {
        cpu: { limit: 4 },
        memory: { limit_bytes: 2 * 1024 ** 3 },
        storage: { limit_bytes: 10 * 1024 ** 3 },
      },
    });
  }
  if (/^\/bots\/[^/]+\/container\/display$/.test(path)) {
    return json(response, 200, {
      enabled: true,
      available: true,
      running: false,
      transport: 'webrtc',
      encoder: 'gstreamer',
      encoder_available: true,
      desktop_available: true,
      browser_available: true,
      toolkit_available: false,
      a11y_available: true,
      prepare_supported: true,
      prepare_system: 'debian',
    });
  }

  /**
   手动压缩（`POST /bots/{id}/sessions/{sid}/compact`）。

   两种回答都要能演：`compact` 场景给成功（带条数），`compact-unavailable` 场景给
   **类型化错误码**——"压不了"和"失败了"在界面上是两句不同的话，只有真给出那个码才验得到
   分档有没有做对。同时记下调用次数（`GET /__compactions`），证明按钮真的打到了这条路上。
   */
  if (/^\/bots\/[^/]+\/sessions\/[^/]+\/compact$/.test(path) && method === 'POST') {
    compactCalls += 1;
    if (currentScenario === 'compact-unavailable') {
      return json(response, 400, {
        code: 'compaction_model_unavailable',
        message: 'no compaction model configured',
      });
    }
    return json(response, 200, {
      status: 'ok',
      summary: 'Earlier turns summarized.',
      message_count: 7,
    });
  }

  if (/^\/bots\/[^/]+\/skills\/catalog$/.test(path)) {
    // `skills-error`：清单**拉不到**。它与"这台 bot 没有技能"是两件事：后者是 200 + 空数组，
    // 前者是 5xx。界面必须分得开，否则用户会以为自己的技能被删了
    // （`docs/research/ios-error-and-feedback.md` R41）。
    if (currentScenario === 'skills-error') {
      return json(response, 500, { error: 'skills catalog unavailable (fixture scenario)' });
    }
    return json(response, 200, {
      skills: [
        {
          name: 'skill-creator',
          display_name: 'skill-creator',
          description: 'Create a new skill from scratch',
          source_kind: 'managed',
          state: 'effective',
        },
        {
          name: 'hooks-setup',
          display_name: 'hooks-setup',
          description: 'Set up git hooks for this workspace',
          source_kind: 'managed',
          state: 'effective',
        },
      ],
    });
  }
  if (path === '/providers') {
    return json(response, 200, {
      providers: [
        {
          id: 'fixture-provider-kimi',
          name: 'Kimi',
          client_type: 'openai-completions',
          enable: true,
        },
        {
          id: 'fixture-provider-deepseek',
          name: 'DeepSeek',
          client_type: 'openai-completions',
          enable: true,
        },
        // 名字认不出来的一家（客户端该给它中性兜底图标）。**它的 `client_type` 是
        // `openai-completions`**：认厂商若按协议走，这里就会被画成 OpenAI。
        {
          id: 'fixture-provider-internal',
          name: 'Internal Gateway',
          client_type: 'openai-completions',
          enable: true,
        },
      ],
      total: 3,
    });
  }
  /**
   会话状态（`GET /bots/{id}/sessions/{sid}/status`）。

   刻意**只给 `message_count` 与 `skills`**：这台部署的 `/status` 确实不给 `context_window`
   （会话信息面板因此不显示百分比，见 `docs/environment.md`），固定服务端也不该凭空给一个，
   否则那条"没有分母就不许算百分比"的规则在验收里就失效了。

   `skills` 两态都演：默认场景**用过技能**（列表要列得出来），`compact-unavailable`
   场景**没用过**（要出现"此会话没有用过技能"那句）。同一条面板的两种形状各有一条 flow 断言。
   */
  if (path.endsWith('/status')) {
    const skills = currentScenario === 'compact-unavailable' ? [] : ['skill-creator', 'pdf'];
    return json(response, 200, { message_count: 12, skills });
  }

  /**
   fs/*：工作区文件的只读端点。

   - `fs`                → stat（**404 是"这个路径不存在"的唯一信号**）
   - `fs/list`           → `{ path, entries }`，`entries` 是 camelCase，且**不排序**
   - `fs/read`           → `{ content, size, revision }`
   - `fs/download`       → 原始字节，支持 `Range`（客户端嗅探首字节时只取头部 8 KiB）

   场景：`fs-error` 让这一组端点整体 500（验证"列目录失败 + 重试"，不是空目录）；
   `fs-many` 把 `data/` 换成 300 项（长列表）；`fs-no-permission` 让 bot 没有
   `workspace_read`（验证入口不出现）。
   */
  const fsRoute = path.match(/^\/bots\/([^/]+)\/container\/fs(?:\/(list|read|download))?$/);
  if (fsRoute !== null) {
    if (currentScenario === 'chat-only') {
      return json(response, 403, { error: 'bot access denied' });
    }
    if (currentScenario === 'fs-error') {
      return json(response, 500, { error: 'list failed (fixture scenario)' });
    }
    /**
      `fs-missing`：进了目录之后它**在服务端没了**（被删或被改名）→ 404。

      这一档的动作**不是重试**：重试一百次那个目录也不会回来。有用的一步是"回到上一层"
      （那里通常还在）。所以这条场景验的是"界面有没有给对的那个按钮"，
      以及有没有把 404 说成"列目录失败 + 重试"。
     */
    /**
      ⚠️ 只让**子目录**失败，根目录照常：否则"回到上一层"会把用户送进第二个错误，
      那个动作就等于没用——场景要比要验的行为更接近真实。
     */
    const listPath = (url.searchParams.get('path') ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    const listIsRoot = listPath === '' || listPath === 'data';
    if (currentScenario === 'fs-missing' && fsRoute[2] === 'list' && !listIsRoot) {
      return json(response, 404, { error: 'not found (fixture scenario)' });
    }
    const requested =
      (url.searchParams.get('path') ?? '').replace(/^\//, '').replace(/\/$/, '') || 'data';
    // `fsNode` 而不是直接查 `FS_NODES`：`fs-many` 用覆盖层换掉 `data/` 下的 300 项。
    const node = fsNode(requested);
    if (node === undefined) return json(response, 404, { error: 'not found' });
    // ⚠️ `match[1]` 是 bot id（第一个括号），verb 在 `match[2]`。写成 `[1]` 会让
    // list/read 永远匹配不上、整组请求掉进 download 分支——App 拿到 200 空体，
    // 页面显示"列目录失败，重试"。这个 bug 在真机上花了一轮才看出来。
    const verb = fsRoute[2] ?? 'stat';

    if (verb === 'stat') {
      return json(response, 200, fsEntry(node));
    }
    if (verb === 'list') {
      if (node.isDir !== true) return json(response, 400, { error: 'not a directory' });
      const entries = (node.children ?? []).map((child) => {
        const found = fsNode(child);
        return found === undefined ? null : fsEntry(found);
      });
      return json(response, 200, {
        path: `/${requested}`,
        entries: entries.filter((item) => item !== null),
      });
    }
    if (verb === 'read') {
      const content = node.text ?? '';
      return json(response, 200, {
        content,
        size: node.size,
        revision: createHash('sha256').update(content).digest('hex'),
      });
    }
    // download：原始字节。按 Range 切，模拟 Go 的 http.ServeContent。
    const body = node.bytes ?? Buffer.from(node.text ?? '', 'utf8');
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    if (range !== null) {
      const start = Number(range[1]);
      const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
      const slice = body.subarray(start, end + 1);
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': slice.length,
      });
      response.end(slice);
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
    });
    response.end(body);
    return;
  }

  return json(response, 404, { error: `未实现的固定端点：${method} ${path}` });
});

// ------------------------------------------------------------------ WebSocket

/**
 * 极简 WebSocket 服务端（RFC 6455 的 server→client 方向就够用）。
 *
 * 不引第三方库：我们只需要"接受升级 + 发文本帧 + 收文本帧"，那点工作量比拉一个
 * 依赖（还要考虑它跟 Node 版本的兼容）小。
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

/** 按 RFC 6455 编码一个文本帧（服务端发出，不需要掩码）。 */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 解出客户端帧的文本内容（客户端帧一定带掩码）。 */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== null) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    offset = cursor + length;
    if (opcode === 0x8) {
      messages.push({ op: 'close' });
    } else if (opcode === 0x1) {
      messages.push({ op: 'text', text: payload.toString('utf8') });
    }
  }
  return messages;
}

/**
 弱网故障注入。
 
 ## 为什么由**服务端**扮演坏网络
 
 客户端的重连节奏、空洞判定、"界面有没有说清状态"只有在对面真的不按套路出牌时才
 看得出对错。在客户端里加一个"模拟断线"的分支等于验自己写的模拟器：那条分支和生产
 路径可能只共享一个 if。
 
 所以在固定服务端这边注入——客户端完全不知道自己连的是谁，走的是真实路径：
  - `flap`：握手成功就立刻断（代理/网关接受后又掐掉，最容易骗出"无退避重连风暴"）；
  - `unauthorized`：直接回 401 不升级（token 失效）；
  - `partial`：发 snapshot + 两帧就断（run 跑到一半网没了）；
  - `gap`：seq 跳号（中间那段永久丢了，服务端明确**不做补齐**）；
  - `epoch`：换 epoch 后 seq 从 0 重来；
  - `silent`：接受握手但**永不出声**——NAT/运营商黑洞，没有任何 TCP close。
 
 两个入口：`/__scenario` 的场景名（见 `faultForScenario`）与运行时的 `POST /__ws-fault`
 （跑着的时候把故障打开，"断线 → 重连 → 恢复"这条时序要这样验）。
 */
let wsFaultMode = 'normal';

/** REST 一侧是否也回 401（凭据失效的开关，见请求处理里的注释）。 */
let tokenRejected = false;

/** `cycle` 故障：连上之后多久把这条连接断掉（默认 2s）。 */
let cycleMs = 2_000;

/**
 WS 观测台。
 
 验收要回答的两个问题只能从这里拿答案：① 一连上就被断时，客户端**多久重连一次**；
 ② 掉线期间发出去的那句话，重连后是**先订阅还是先发消息**（协议要求先订阅）。
 */
let wsLog = { connections: 0, closes: 0, frames: [], subscribes: {}, attempts: [] };

/** 当前活着的 socket（`POST /__ws-drop` 要挨个掐掉）。 */
const liveSockets = new Set();

function resetWsLog() {
  wsLog = { connections: 0, closes: 0, frames: [], subscribes: {}, attempts: [] };
}

/** 记一条客户端帧（顺序就是这个数组的顺序）。 */
function noteFrame(frame, connection, bot) {
  wsLog.frames.push({
    conn: connection,
    // 这条帧**走在哪个 bot 的连接上**。旅程"切了 agent 之后发的那句话真的发到新 agent 了吗"
    // 只有这个字段能回答：界面上的头部名字变了不算数。
    bot,
    type: typeof frame.type === 'string' ? frame.type : '?',
    session_id: typeof frame.session_id === 'string' ? frame.session_id : undefined,
    invocation_id: typeof frame.invocation_id === 'string' ? frame.invocation_id : undefined,
    at: Date.now(),
  });
  if (wsLog.frames.length > 400) wsLog.frames.splice(0, wsLog.frames.length - 400);
  if (frame.type === 'runtime_subscribe') {
    const key = `${frame.session_id}`;
    wsLog.subscribes[key] = (wsLog.subscribes[key] ?? 0) + 1;
  }
}

/** 场景名 → 故障模式。除这些场景外，WS 必须是一条**正常的流**。 */
function faultForScenario(name) {
  const modes = [
    'flap',
    'refuse',
    'unauthorized',
    'partial',
    'gap',
    // `gap-once`：只造一次 seq 空洞（第一次订阅时）。修好之后客户端会重订阅，
    // 第二次必须给它一份**正常**的流——否则验出来的是"永远好不了"，那不是自愈。
    // 它和 `gap`（每次都跳号）的区别就是"能不能验到恢复"。
    'gap-once',
    'epoch',
    'silent',
    'cycle',
  ];
  return modes.includes(name) ? name : 'normal';
}

server.on('upgrade', (request, socket) => {
  if (!request.url.includes('/web/ws')) {
    socket.destroy();
    return;
  }
  wsLog.connections += 1;
  // 这一条连接是**哪个 bot** 的：`/bots/{bot_id}/web/ws`。旅程里"切换 agent 之后
  // 那句话到底发给谁了"只能靠它回答（界面上的头部名字不算证据）。
  const botId = (request.url.match(/\/bots\/([^/]+)\/web\/ws/) ?? [])[1] ?? '';
  // 每一次**升级尝试**的时刻都记下来：验"有没有退避"看的是这个数组的间隔，
  // 而不是客户端自己的状态回调（那要经过 JS 事件循环，测不准）。
  const connection = wsLog.connections;
  wsLog.attempts.push(Date.now());

  if (currentScenario === 'chat-only') {
    socket.write('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    socket.end();
    return;
  }

  // token 失效：不升级，直接回 401。真实的 Memoh 也是在这个位置挡人
  // （`canOpenLocalWebSocket` 之外还有一层 Bearer 校验）。
  if (wsFaultMode === 'unauthorized') {
    socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    socket.end();
    return;
  }

  // 连都连不上：不升级、也不给任何 HTTP 回复，直接把连接掐了。
  // 生产里的形状是"网关 502 / TLS 失败 / 端口后面没人"——失败原因里**没有** 4xx，
  // 所以客户端应当一直重试（这和 401 是两件事）。界面上的状态也一直停在"正在重连"。
  if (wsFaultMode === 'refuse') {
    wsLog.closes += 1;
    socket.destroy();
    return;
  }

  const key = request.headers['sec-websocket-key'];
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );

  // 握上手就断：这种现象在生产里由网关/代理造出来，客户端看起来"能连上"，
  // 但一帧都收不到。
  if (wsFaultMode === 'flap') {
    wsLog.closes += 1;
    setTimeout(() => socket.destroy(), 5);
    return;
  }

  /**
   `cycle`：正常连、正常发，然后**过一会儿断掉**，如此往复。
   
   这是"地铁里刷着刷着网没了"的形状。要它是因为时序验收的锚点只能是**界面**：验收
   脚本没法在流程跑到一半时去 curl 一下把网掐掉，所以让服务端按自己的时钟断，流程
   去看"断开时界面说了什么、恢复后会不会自己回来"。
   */
  if (wsFaultMode === 'cycle') {
    setTimeout(() => {
      wsLog.closes += 1;
      socket.destroy();
    }, cycleMs);
  }

  let buffer = Buffer.alloc(0);
  /** 已订阅的会话 → 该发哪些帧。 */
  const subscriptions = new Map();
  liveSockets.add(socket);
  socket.on('close', () => liveSockets.delete(socket));

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = decodeFrames(buffer);
    // 简化：解析成功后整块丢弃（帧边界恰好落在结尾就够了，验收数据量很小）。
    if (parsed.length > 0) buffer = Buffer.alloc(0);

    for (const message of parsed) {
      if (message.op === 'close') {
        socket.end();
        return;
      }
      if (message.op !== 'text') continue;
      let frame;
      try {
        frame = JSON.parse(message.text);
      } catch {
        continue;
      }
      noteFrame(frame, connection, botId);
      if (frame.type === 'runtime_subscribe') {
        const sceneId = sceneForSession(frame.session_id ?? '');
        subscriptions.set(frame.session_id, sceneId);
        // 立刻发 snapshot：客户端要靠它确定 epoch 与当前 run。
        if (wsFaultMode === 'partial' || wsFaultMode === 'gap' || wsFaultMode === 'epoch') {
          sendFaultStream(socket, frame.session_id, wsFaultMode);
        } else if (wsFaultMode === 'gap-once' && gapOnceSent === false) {
          // 只跳这一次：之后（客户端重订阅）走正常的 `sendScene`，那条"空洞 → 重订阅 → 补全"
          // 的链路才有终点。
          gapOnceSent = true;
          sendFaultStream(socket, frame.session_id, 'gap');
        } else if (wsFaultMode === 'silent') {
          // 黑洞：收下、不回。任何真连接都会这样"活着但死了"。
        } else {
          // 回放时带上"这一轮该回显的用户文本"（没有就是 undefined，原样放场景）。
          subscribedSessions.add(frame.session_id);
          sendScene(
            socket,
            frame.session_id,
            sceneId,
            subscriptions,
            pendingEcho.get(frame.session_id),
          );
        }
      }
      if (frame.type === 'runtime_unsubscribe') subscriptions.delete(frame.session_id);
      /**
       记下客户端发来的消息帧（不止 type，整帧都留）。

       为什么值得记：模型/思考强度是"随消息带"的（协议就是这么设计的），所以"选择真的
       生效了吗"这件事**只有看线上发了什么**才能证明。界面上的胶囊变了只说明状态改了。
       `GET /__last-client-message` 把它交出来，验收脚本据此断言。
       */
      if (frame.type === 'message' || frame.type === 'retry_message') {
        lastClientMessage = frame;
        const target = typeof frame.session_id === 'string' ? frame.session_id : '';
        const sent = typeof frame.text === 'string' ? frame.text : '';
        /**
         新建出来的会话：**收到消息才开始回**。

         订阅时就把整段流放完，验的是"打开会话能看到帧"；而用户旅程要验的是
         "我发了一句，它开始回答"——后者才包含"订阅先于发送"这条协议要求被满足。
         触发条件挂在会话 id 上（`fixture-session-created-*` 只会在旅程里被建出来），
         所以它不会渗进其它 flow。回显的那一句用**客户端真的发的文本**（`withEcho`）。
         */
        if (target === '') {
          /**
           **没有 session_id 的消息**：这是"新建会话页发的第一句"。

           协议就是这么设计的（`docs/research/memoh-api.md` §3.1 / `local_channel.go`）：
           服务端建好会话，用 `session_created` 把 id 告知客户端，之后这一轮的内容都挂
           在那个 id 上。固定服务端不实现它的话，"新建会话 → 发第一句"这条**真实入口**
           就永远验不到（客户端发出去的帧没有 id，回不来任何东西）。
           */
          const created = {
            ...SESSIONS[0],
            id: `fixture-session-created-${createdSessions.length + 1}`,
            title: '',
            created_at: ISO(0),
            updated_at: ISO(0),
            last_message_at: '',
            message_count: 0,
          };
          createdSessions = [...createdSessions, created];
          // 记下这一轮要回显的文本：客户端收到 `session_created` 之后会订阅这条会话，
          // **回放发生在订阅那一刻**（`sendScene` 用这份文本）。刻意不在这里也放一遍：
          // 同一轮放两遍会让两次回放的 delta 交错，客户端按 seq 判定成空洞 → 反复重订阅
          // （2026-09-16 真的踩过：屏幕上看得到的内容变成场景里那句写死的话，
          // 顶上还挂着"Refreshing…"）。
          pendingEcho.set(created.id, sent);
          subscriptions.set(created.id, sceneForSession(created.id));
          socket.write(
            encodeText(JSON.stringify({ type: 'session_created', session_id: created.id })),
          );
          // 兜底：客户端万一对 `session_created` 不订阅（协议变更之类），400ms 后自己放一遍。
          setTimeout(() => {
            if (!subscribedSessions.has(created.id)) {
              sendScene(socket, created.id, sceneForSession(created.id), subscriptions, sent);
            }
          }, 400);
        } else if (target.startsWith('fixture-session-created')) {
          sendScene(socket, target, sceneForSession(target), subscriptions, sent);
        } else if (target !== '' && sent !== '' && subscriptions.has(target)) {
          /*
           回显用户这一轮（`runtime_delta.user_turn_upserts`）。

           ⚠️ 不回显会让"我刚发的那句话从屏幕上消失"：客户端的显示优先级是
           **服务端权威的当前轮 > 本地乐观回显**（`turnsForDisplay`）。会话里已经有一轮
           快照（跑完的或正在跑的）时，本地那条乐观消息会被权威那份顶掉，而服务端又
           什么都没说——于是"发出去了但看不见"。真服务端会把你这一轮广播回来，
           固定服务端不该比真服务端更弱。

           seq 必须**接在当前游标之后**（否则客户端判成空洞、去重订阅）：回放过的
           场景 delta 数是 1..N，所以第一句回显从 N+1 起，之后依次加一。
          */
          const sceneId = sceneForSession(target);
          const base = (sceneById(sceneId)?.frames ?? []).filter(
            (item) => item.kind === 'delta',
          ).length;
          const echoed = (echoSeqs.get(target) ?? 0) + 1;
          echoSeqs.set(target, echoed);
          const snapshot = sceneById(sceneId)?.frames.find((item) => item.kind === 'snapshot');
          socket.write(
            encodeText(
              JSON.stringify({
                type: 'runtime_delta',
                session_id: target,
                epoch: snapshot?.payload?.epoch ?? 'fixture-epoch',
                seq: base + echoed,
                delta: {
                  user_turn_upserts: [
                    {
                      turn_id: `fixture-echo-${echoed}`,
                      role: 'user',
                      text: sent,
                      turn_position: 1,
                    },
                  ],
                },
              }),
            ),
          );
        }
      }
      /**
       回应审批的帧也留一份。

       与消息帧同一个道理：拒绝时那句理由的落点**只在线上**——界面多一个输入框只说明
       "我画上去了"。而且这一条还要钉住一个反例：**没写理由时不许出现 `reason` 字段**
       （空理由会被服务端当成"一条空理由"记进上下文）。
       */
      if (frame.type === 'tool_approval_response') lastApprovalResponse = frame;
    }
  });

  // 服务端这一侧的断开也要记账：验收要区分"客户端主动放弃"和"对面断的"。
  socket.on('close', () => {
    wsLog.closes += 1;
  });

  socket.on('error', () => socket.destroy());
});

/**
 故障流的帧脚本。
 
 与 `sendScene` 的区别：这里发的**不是**场景数据的完整回放，而是"对面不老实"的那几种
 形状。三种模式都从同一个 snapshot 起手，客户端看到的开头是一样的，差别只在中途：
 
 - `partial`：两帧之后 socket 直接销毁（没有 close 帧、没有理由），对应"网没了"；
 - `gap`：seq 跳号（1 之后直接 5）——服务端不做增量补齐，客户端只能重新订阅；
 - `epoch`：中途换 epoch，seq 从 0 重来，客户端必须**不要**把两个 epoch 的 seq 连着算。
 */
function sendFaultStream(socket, sessionId, mode) {
  const scene = sceneById(sceneForSession(sessionId));
  const snapshotFrame = scene?.frames.find((frame) => frame.kind === 'snapshot');
  const payload = snapshotFrame?.payload ?? null;
  const epoch = payload?.epoch ?? 'fixture-epoch';
  const deltas = (scene?.frames ?? []).filter((frame) => frame.kind === 'delta');

  const write = (frame) => {
    if (socket.destroyed) return;
    try {
      socket.write(encodeText(JSON.stringify(frame)));
    } catch {
      // 对面已经关了。
    }
  };
  const delta = (index, seq, ownEpoch) =>
    write({
      type: 'runtime_delta',
      session_id: sessionId,
      epoch: ownEpoch,
      seq,
      delta: deltas[index]?.delta ?? {},
    });

  write({ type: 'runtime_snapshot', session_id: sessionId, epoch, seq: 0, snapshot: payload });

  if (mode === 'partial') {
    setTimeout(() => delta(0, 1, epoch), 60);
    setTimeout(() => delta(1, 2, epoch), 120);
    setTimeout(() => socket.destroy(), 200);
    return;
  }
  if (mode === 'gap') {
    setTimeout(() => delta(0, 1, epoch), 60);
    // 1 → 5：中间三帧永久丢失。服务端不会补，客户端只能重新订阅换 snapshot。
    setTimeout(() => delta(1, 5, epoch), 120);
    return;
  }
  // epoch：换了一套投影，seq 从 0 重来。本地那些用旧 epoch 攒下的游标全部作废。
  setTimeout(() => delta(0, 1, epoch), 60);
  setTimeout(
    () =>
      write({
        type: 'runtime_snapshot',
        session_id: sessionId,
        epoch: `${epoch}-2`,
        seq: 0,
        snapshot: payload,
      }),
    120,
  );
  setTimeout(() => delta(0, 1, `${epoch}-2`), 180);
}

/**
 * 发一个会话的帧序列。
 *
 * 顺序照协议：先 snapshot（含当前 run 视图与已有消息），再按 seq 依次 delta。
 *
 * ## 两个踩过的坑，写在这里免得再犯
 *
 * **1. `epoch` / `seq` 必须在帧的顶层，不能只藏在 `snapshot` 里。**
 *
 * 客户端从**帧顶层**读这两个字段（`realtime.ts` 的 `handleSnapshot`：`frame.epoch`
 * / `frame.seq`），拿到之后才更新游标。只放在 `snapshot` 对象里的话，客户端认为
 * 自己"还没收到过 snapshot"，于是收到第一个 delta 时判定 `delta before snapshot`
 * → 重新订阅 → 页面永远停在 "Refreshing…"。
 *
 * 这一点有上游自己的测试佐证：
 * `internal/agent/runtime/session/acceptance/suite_test.go` 里就是
 * `eventEpoch(snapshot)` / `eventSeq(snapshot)`——从事件顶层取。
 *
 * **2. `seq` 必须连续，而且由服务端重新编号。**
 *
 * 一开始直接发场景帧里写死的 seq（那些值是为本地回放写的，内部还有跳号），
 * 客户端的光标校验（`cursor.ts`：`seq !== current.seq + 1` → 重新拿 snapshot）
 * 判定"视图过期"。**本地回放那条路看不出问题**——reducer 不校验连续性，
 * 只有走真实实时通道才会暴露。
 *
 * 换句话说：seq 是**服务端对每条订阅流自己编号**的东西，不是数据自带的属性。
 * 这里默认每 120ms 发一帧，让流式在录屏里看得见；**验时序的场景可以把间隔压到几十
 * 毫秒**（`scene.intervalMs`），复现"同一块被连着整块替换、输出还在长"的突发。
 * 验收截图会等到终态。
 */
function sendScene(socket, sessionId, sceneId, subscriptions, echoText) {
  const scene = sceneById(sceneId);
  if (scene === null) return;
  const intervalMs = scene.intervalMs ?? 120;
  const snapshotFrame = scene.frames.find((frame) => frame.kind === 'snapshot');
  const payload = snapshotFrame === undefined ? null : snapshotFrame.payload;

  socket.write(
    encodeText(
      JSON.stringify({
        type: 'runtime_snapshot',
        session_id: sessionId,
        // 顶层：客户端从这里取游标（见上面第 1 条）。
        epoch: payload?.epoch ?? 'fixture-epoch',
        seq: payload?.seq ?? 0,
        snapshot: payload,
      }),
    ),
  );
  const deltas = scene.frames.filter((frame) => frame.kind === 'delta');
  deltas.forEach((frame, index) => {
    setTimeout(
      () => {
        if (!subscriptions.has(sessionId)) return;
        socket.write(
          encodeText(
            JSON.stringify({
              type: 'runtime_delta',
              session_id: sessionId,
              epoch: frame.epoch,
              // 连续编号：snapshot 的 seq 是 0，第一个 delta 就是 1。
              seq: index + 1,
              delta: withEcho(frame.delta, echoText),
            }),
          ),
        );
      },
      intervalMs * (index + 1),
    );
  });
}

/**
 把这一轮的用户轮次换成**客户端真的发的**那句话。

 场景里写死的用户文案是给"打开就有内容"那种验收用的；而旅程要验的是"我发了一句，
 它回的是对这一句的回答"。服务端回显用户轮次本来就是真实协议的一部分，而客户端在
 有权威轮次时**优先用它、丢掉本地乐观那条**（`turnsForDisplay`），所以换掉文案之后
 屏幕上仍然只有一条用户消息，而且文案是我刚打的那一句。

 `echoText` 为空时（不是旅程触发的回放）原样返回，场景数据一个字不动。
 */
function withEcho(delta, echoText) {
  if (typeof echoText !== 'string' || echoText === '') return delta;
  if (!Array.isArray(delta?.user_turn_upserts)) return delta;
  return {
    ...delta,
    user_turn_upserts: delta.user_turn_upserts.map((turn) => ({ ...turn, text: echoText })),
  };
}

// 初始场景的数据要在监听之前建好：第一个请求进来时 `SCHEDULES` 必须已经是
// `chat-tools` 该有的样子，而不是空数组（那会让"默认场景下定时视图是空的"）。
applyScenario(currentScenario);

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fixed fixture server on http://127.0.0.1:${PORT}\n`);
});
