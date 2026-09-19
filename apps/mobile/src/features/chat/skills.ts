/**
 * 技能清单（`GET /bots/{bot_id}/skills/catalog`）的取数与**失败**。
 *
 * ## 为什么从 `ui/SlashMenu.tsx` 挪到这里
 *
 * 以前它住在那个组件里，而且拉不到时 `.catch(() => [])`——**失败和"这台 bot 没有技能"
 * 在界面上变成同一件事**。斜杠菜单里只剩内置动作，用户看到的是"我装的技能不见了"，
 * 而真正的原因（没网 / 5xx / 没权限）一个字都没说。这正是本项目已经交过学费的那条：
 * 拉取失败时显示"还没有内容"是撒谎（`docs/research/ios-error-and-feedback.md` R41）。
 *
 * 现在它返回 `{ skills, failure }`：**有没有技能**和**拉不拉得到**是两件事，界面上也就
 * 分得开。判断"要不要给重试"仍然只有一处（`features/errors/present.ts`），所以这里
 * 存的也是呈现对象而不是一句话。
 *
 * 纯逻辑、不 import 任何 `.tsx`，所以能直接单测（`tests/chat-skills.test.mjs`）。
 */
import type { SkillSummary } from '../../api/types.ts';
import { presentError, type ErrorPresentation } from '../errors/present.ts';

export interface SkillCatalog {
  /** 拿到的技能。拉失败时是空数组——但那时 `failure` 不是 null，界面不许把它当"没有技能"。 */
  skills: SkillSummary[];
  /** 拉不到的原因与动作。拿得到就是 `null`。 */
  failure: ErrorPresentation | null;
}

/** 取数用的最小 client 形状（只为让这个模块能拿假 client 直测）。 */
export interface SkillCatalogClient {
  listSkills(botId: string): Promise<{ skills?: SkillSummary[] }>;
}

const EMPTY: SkillCatalog = { skills: [], failure: null };

/** 按 bot 缓存**成功**的结果：清单来自容器的文件树，短时间不会变。 */
const cache = new Map<string, Promise<SkillCatalog>>();

/**
 * 取技能清单。
 *
 * 失败**不进缓存**（`cache.delete`）：下一次打开会话还能再试一次，而不是把这台 bot 的
 * 技能永久判死。这与本项目"不把一次失败记成永久状态"的做法一致。
 */
export function loadSkills(
  client: SkillCatalogClient | null,
  botId: string | null,
): Promise<SkillCatalog> {
  if (client === null || botId === null) return Promise.resolve(EMPTY);
  const cached = cache.get(botId);
  if (cached !== undefined) return cached;
  const promise = client
    .listSkills(botId)
    .then((payload) => ({ skills: usableSkills(payload.skills), failure: null }))
    .catch((caught) => {
      cache.delete(botId);
      return { skills: [], failure: presentError(caught) };
    });
  cache.set(botId, promise);
  return promise;
}

/** 换 bot / 退出登录时清掉（不同 bot 的技能清单不是一回事）。 */
export function resetSkillCache(): void {
  cache.clear();
}

/**
 * 服务端给的那一串里，哪些能进菜单。
 *
 * 只做一件事：**丢掉没有名字的条目**。菜单项的主文案就是 `/名字`，没有名字的条目在界面上
 * 是一个空白的 `/`，点了也发不出任何东西。其余字段（`display_name` / `description`）缺失
 * 是正常的，`features/chat/slash.ts` 已经会退化成只显示名字。
 */
function usableSkills(raw: unknown): SkillSummary[] {
  if (!Array.isArray(raw)) return [];
  const usable: SkillSummary[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim() === '') continue;
    usable.push(item as SkillSummary);
  }
  return usable;
}
