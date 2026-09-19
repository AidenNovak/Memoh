/**
 * 新建 bot 的**纯逻辑**：slug、请求体、能不能提交、以及"轮询到就绪"的状态机。
 *
 * ## 为什么单独一层
 *
 * 桌面端（`apps/web/src/pages/bots/new.vue` + `store/bot-create-progress.ts`）的这三件事
 * 都有明确规则，而且每一条都能写错得不明显：
 *
 * - **slug 规则**要与服务端一致（`internal/bots/name.go`：`^[a-z0-9][a-z0-9-]{1,62}$`，
 *   48 位截断，保留字清单）。写宽了会 400，写窄了会把用户能用的名字挡在门外。
 * - **名字可用性有四个状态**（可用 / 被占用 / 非法 / 保留字），不是一个布尔——
 *   "被占用"和"保留字"给用户的下一步动作完全不同。
 * - **创建是"先建记录再等就绪"**：`POST /bots`（不带 `wait_for_ready`）回来的是
 *   `status: 'creating'`，要轮询 `GET /bots/{id}` 到 `ready`。**建成了但后续设置失败
 *   不算创建失败**——那是两件事，混在一起会让用户以为 bot 没建出来。
 *
 * 这些都放在这里、用 `node --test` 钉住，而不是散在界面里。
 */
import type { BotCreateRequest } from '../../api/types.ts';

/** 服务端允许的 URL 名：2–63 位小写字母数字与连字符，首字符是字母数字。 */
export const BOT_NAME_SHAPE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** 服务端保留字（`internal/bots/name.go`）。照抄，别自己加。 */
export const RESERVED_BOT_NAMES: readonly string[] = [
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
];

/** 名字可用性的四态。**别压成布尔**：四种状态该说的话不一样。 */
export type NameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'reserved';

/**
 * 从显示名生成 URL 名。
 *
 * 规则与服务端 `slugify` 一致：小写、非字母数字压成连字符、去掉首尾连字符、截 48 位。
 * 用户一改 URL 名就**停止联动**（桌面端同样：`nameTouched`）——否则手改会被覆盖。
 */
export function slugifyBotName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** 本地先判一次（省一次请求）：形状不符或保留字就不必问服务端。 */
export function localNameProblem(name: string): NameStatus | null {
  if (name === '') return null;
  if (RESERVED_BOT_NAMES.includes(name)) return 'reserved';
  if (!BOT_NAME_SHAPE.test(name)) return 'invalid';
  return null;
}

/** 把服务端的 `reason` 收成四态；认不出来时给 `invalid`（宁可让用户改，也别放行）。 */
export function nameStatusFromReason(available: boolean, reason: string): NameStatus {
  if (available && reason === 'available') return 'available';
  if (reason === 'taken') return 'taken';
  if (reason === 'reserved') return 'reserved';
  return 'invalid';
}

export interface BotFormState {
  displayName: string;
  name: string;
  avatarUrl: string;
  timezone: string;
  aclPreset: string;
  /** 名字可用性（由界面在 400ms 防抖后填进来）。 */
  nameStatus: NameStatus;
  /** 正在提交。 */
  submitting: boolean;
}

/** 默认访问档位：桌面端也是这个（`allow_all`）。 */
export const DEFAULT_ACL_PRESET = 'allow_all';

export function emptyBotForm(): BotFormState {
  return {
    displayName: '',
    name: '',
    avatarUrl: '',
    timezone: '',
    aclPreset: DEFAULT_ACL_PRESET,
    nameStatus: 'idle',
    submitting: false,
  };
}

/**
 * 能不能提交。
 *
 * 桌面端还要求"名字校验必须通过"（`nameStatus === 'available'`）——这条要保留：
 * 一个没校验或校验失败的名字提交上去，用户等 5 秒才拿到 409，而错误还落在进度页上。
 */
export function canSubmit(form: BotFormState): boolean {
  if (form.submitting) return false;
  if (form.displayName.trim() === '') return false;
  if (form.name.trim() === '') return false;
  if (form.nameStatus !== 'available') return false;
  if (form.aclPreset === '') return false;
  return true;
}

/**
 * 拼请求体。
 *
 * 空字符串的**不发送**（`avatar_url` / `timezone` 是可选项，发空串等于要求服务端把
 * 它设成空值；桌面端也是只发填了的）。
 */
export function buildCreatePayload(form: BotFormState): BotCreateRequest {
  const payload: BotCreateRequest = {
    name: form.name.trim(),
    display_name: form.displayName.trim(),
    is_active: true,
    acl_preset: form.aclPreset,
  };
  if (form.avatarUrl.trim() !== '') payload.avatar_url = form.avatarUrl.trim();
  if (form.timezone.trim() !== '') payload.timezone = form.timezone.trim();
  return payload;
}

// ---------------------------------------------------------------- 创建进度

export type CreatePhase =
  { phase: 'creating'; polls: number } | { phase: 'ready' } | { phase: 'failed'; reason: string };

/** bot 的 `status` 只有三个值（`internal/bots/types.go`）：creating / ready / deleting。 */
export function phaseFor(status: string, polls: number): CreatePhase {
  if (status === 'ready') return { phase: 'ready' };
  if (status === 'deleting') return { phase: 'failed', reason: 'deleting' };
  return { phase: 'creating', polls };
}

/**
 * 轮询节奏：前几次快、之后放慢。
 *
 * 为什么不是固定间隔：容器生命周期里"拉镜像"可能几十秒不动（进度没有可读的数字），
 * 固定 1s 会白跑几十个请求；而刚创建完那两秒又是用户最想看到变化的时刻。
 */
export const POLL_DELAYS_MS = [800, 1200, 2000, 3000, 5000];

export function pollDelayMs(pollIndex: number): number {
  // 负数也要夹住：越界读数组会拿到 undefined，而"等 5 秒"和"等 0.8 秒"在调试时
  // 是两种完全不同的现象，别让一个坏索引变成一次神秘的长时间等待。
  const index = Math.min(Math.max(pollIndex, 0), POLL_DELAYS_MS.length - 1);
  return POLL_DELAYS_MS[index] ?? 5000;
}

/**
 * 多久算超时。
 *
 * 5 分钟与**服务端流式那条路的超时**一致（`users.go` 的 5 分钟）——比它短会误报失败，
 * 比它长只是让用户多等。
 */
export const CREATE_TIMEOUT_MS = 5 * 60 * 1000;

export function createTimedOut(elapsedMs: number): boolean {
  return elapsedMs >= CREATE_TIMEOUT_MS;
}

/** 进度页上的阶段行：轮询版（不追 SSE 的层字节百分比）。 */
export type CreateStageKey = 'record' | 'workspace' | 'ready';

export function stageFor(status: string): CreateStageKey {
  if (status === 'ready') return 'ready';
  return 'workspace';
}
