/**
 * 验收用的启动种子（仅开发构建）。
 *
 * ## 为什么需要它
 *
 * 验收要求"能在不登录的情况下跑"，但有些行为**只有连着真服务端才能验**——比如
 * 流式消息真的在屏幕上长出来。模拟器没有可脚本化的点击能力（`simctl` 没有 tap），
 * 靠键盘自动化去填表单既慢又脆。
 *
 * 所以走这条路：验收脚本往 App 的 Documents 里放一个 JSON，App 启动时读它，
 * 自动登录并执行一段固定的动作。被验证的是**真实路径**——真实网络、真实协议、
 * 真实的 reducer 与渲染——省掉的只有"手指点屏幕"这一段。
 *
 * ## 边界
 *
 * - **只在 `__DEV__` 下生效**。生产构建里 `loadVerifySeed()` 直接返回 null，
 *   这段代码的存在不影响任何用户。
 * - 种子文件只在 Documents 目录里，验收脚本用完即删。
 * - 种子里会有密码。它来自本机的 `~/.config/memoh-ios/dev.env`，写进模拟器的
 *   沙箱目录；不进仓库、不进日志、不上传。
 */
import { File, Paths } from 'expo-file-system';

const SEED_FILENAME = 'memoh-verify-seed.json';

export interface VerifySeed {
  /** 要连的服务器。 */
  baseUrl: string;
  username: string;
  password: string;
  /**
   * 登录后自动执行的动作。省略则只登录、停在首页。
   *
   *   - `chat`：用已有的第一个会话发一条消息（没有就新建）。走真实网络与协议。
   *   - `scene`：打开指定场景，用真实组件渲染固定帧序列。
   *     **不需要登录、也不连服务端**——这是设计迭代与视觉验收的入口。
   *   - `route`：直接打开某个路由（`path` 指定）。用来给**真实页面**留截图——
   *     首页、设置页这些页面从 store 取数，只能靠真实网络喂数据。
   */
  scenario?: 'chat' | 'scene' | 'route';
  /** `scenario: 'chat'` 时要发送的文本。 */
  message?: string;
  /** `scenario: 'scene'` 时要打开的场景 id（见 features/verify/scenes.ts）。 */
  scene?: string;
  /** `scenario: 'route'` 时要打开的路由，如 `/settings`。 */
  path?: string;
  /**
   * `scenario: 'chat'` 时要进的会话 id。省略则用最近的一个（没有就新建）。
   *
   * 加它是为了能**挑一个已经有内容的会话**去验会话信息面板：空会话的统计全是 0，
   * 而"显示 0"和"读不到所以显示 0"在屏幕上长得一样——那样的断言证明不了什么。
   */
  sessionId?: string;
  /**
   * `scenario: 'chat'` 时，发完消息后把**会话信息面板**打开。
   *
   * 面板是点标题才出现的，而模拟器没有点击能力（见文件头）。用这个开关走的是
   * 产品里那条真实路径——`openInfo` 同一个处理函数、真实 store 拉 `/status`、
   * 真实渲染——省掉的只是"手指点标题"。要验证的恰恰是"数字是真的"，
   * 所以这一段必须连真服务端，不能在场景台里用固定值替代。
   */
  openSessionInfo?: boolean;
}

/**
 * 验收脚本可以在 App 运行期间改种子文件来切换画面。
 *
 * 返回下一个要显示的东西：`scene:<id>` 或 `route:<path>`，没有变化时返回 null。
 *
 * ## 为什么读文件而不是 deep link
 *
 * `simctl openurl` 在 iOS 26 上会弹 "Open in Memoh?" 的系统确认框，而模拟器没法点它
 * （这个项目没有点击能力），于是 deep link 那条路是堵死的。改文件、App 轮询，
 * 不需要点击也不需要冷启动——一次启动能走完全部画面。见
 * `docs/research/verified-behaviour.md` 第 9b 条。
 */
export function watchVerifyNavigation(
  initial: VerifySeed,
  onChange: (target: string) => void,
): () => void {
  if (!__DEV__) return () => {};
  /** 把种子里的导航意图描述成一个可比较的字符串（`scene:<id>` / `route:<path>`）。 */
  const describe = (seed: VerifySeed): string => {
    if (seed.scenario === 'scene' && typeof seed.scene === 'string') return `scene:${seed.scene}`;
    if (seed.scenario === 'route' && typeof seed.path === 'string') return `route:${seed.path}`;
    return '';
  };
  let last = describe(initial);

  const timer = setInterval(() => {
    let parsed: VerifySeed | null = null;
    try {
      const file = new File(Paths.document, SEED_FILENAME);
      if (!file.exists) return;
      const value: unknown = JSON.parse(file.textSync());
      if (isSeed(value)) parsed = value;
    } catch {
      return; // 读到半截的 JSON 很正常（脚本正在写），下一轮再看。
    }
    if (parsed === null) return;
    const next = describe(parsed);
    if (next === '' || next === last) return;
    last = next;
    onChange(next);
  }, 600);

  return () => clearInterval(timer);
}

function isSeed(value: unknown): value is VerifySeed {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.username === 'string' &&
    typeof candidate.password === 'string'
  );
}

/**
 * 读启动种子。没有、读不了、或不是生产允许的形状——一律返回 null。
 *
 * 这个函数**不抛异常**：验收基建出问题不该让 App 崩，那会把"基建坏了"伪装成
 * "App 坏了"。
 */
export function loadVerifySeed(): VerifySeed | null {
  // 生产构建里这段代码不执行。`__DEV__` 是 RN 在打包时注入的常量。
  if (!__DEV__) return null;

  try {
    const file = new File(Paths.document, SEED_FILENAME);
    if (!file.exists) return null;
    const parsed: unknown = JSON.parse(file.textSync());
    return isSeed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 验收脚本应该在 App 启动前调用；这只是在 App 侧也能清掉。 */
export function clearVerifySeed(): void {
  if (!__DEV__) return;
  try {
    const file = new File(Paths.document, SEED_FILENAME);
    if (file.exists) file.delete();
  } catch {
    // 删不掉也不影响：下次启动还是同一份种子，验收等价。
  }
}
