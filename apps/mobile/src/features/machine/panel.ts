/**
 * "bot 的那台机器"面板的纯逻辑。
 *
 * 这一屏要回答三个问题，而每个都容易答错：
 *
 * 1. **机器在跑吗**：`status`（容器）与 `task_running`（这一轮任务）是两件事。
 *    说成一句"运行中"会让"容器活着但任务没在跑"和"任务在跑"看起来一样。
 * 2. **桌面能看吗**：能力探针有四个字段（`enabled` / `available` / `running` /
 *    `unavailable_reason`），含义各不相同。"桌面不可用"可能是"这个 bot 没开桌面"，
 *    也可能是"容器里没有桌面环境"——用户能做的事完全不同（开开关 vs 换镜像）。
 * 3. **用量是多少**：能拿到就显示具体数字，后端说 `supported: false` 或字段缺失时
 *    显示"读不到"，**绝不当成 0**（0% CPU 是一条结论，"读不到"是另一条）。
 *
 * ## 关于"看画面"
 *
 * 桌面端的实时画面是 WebRTC（H.264/VP8），服务端**只发 host candidate、没有 STUN/TURN**，
 * 媒体走 UDP。本客户端没有接原生 WebRTC，所以这一屏**不给"连接桌面"的按钮**——
 * 给一个必然失败的按钮比不给更坏。它能做的是：
 *
 * - 说清桌面现在处于哪个状态（上面第 2 点）；
 * - 指向**真能看到屏幕的那条路**：agent 用 GUI 工具截的图会落在工作区的
 *   `.memoh/screenshots/`，用已有的文件视图就能看（含图片预览）。
 */
import type { ContainerMetrics, ContainerStatus, DisplayCapability } from '../../api/types.ts';

export interface Row {
  label: string;
  value: string;
  /**
   * `value` 是**文案 key**（渲染时必须过 `t()`）还是服务端给的**原文**。
   *
   * 这一层是防「中文界面上出现『任务 | running』」的：协议里的枚举值一个都不许直接当
   * 显示值用，必须先映射成 key。行值原本只有 `label`/`value` 两个字段，看不出这个区别，
   * 所以这里显式标出值的来源，避免漏掉 `t()`。
   */
  valueKind: 'key' | 'text';
}

/** 字节数说成人话。读不到（undefined）返回空串，让调用方决定显示什么。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 个位数保留一位小数（3.5 GB），三位数以上不需要（512 MB）——位数多了反而读不出量级。
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** 百分比。**读不到不是 0**：`undefined` → 空串。 */
export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return `${Math.round(value * 10) / 10}%`;
}

/** 「用量 / 上限」，任一侧读不到就只给能读到的那侧。 */
export function usageWithLimit(used: number | undefined, limit: number | undefined): string {
  const usedText = formatBytes(used);
  const limitText = formatBytes(limit);
  if (usedText === '' && limitText === '') return '';
  if (limitText === '') return usedText;
  if (usedText === '') return `/ ${limitText}`;
  return `${usedText} / ${limitText}`;
}

/** 容器状态 → 文案 key。映射不到就**不猜**：说"未知"，不把协议原值透给用户。 */
const CONTAINER_STATUS_KEY: Record<string, string> = {
  running: 'machine.row.status.running',
  stopped: 'machine.row.status.stopped',
};

/** 机器这一组。`null` = 还没拉到（界面显示加载中，不显示"已停止"这种默认结论）。 */
export function machineRows(container: ContainerStatus | null): Row[] {
  if (container === null) return [];
  const status = container.status ?? '';
  // 显式标注：字面量数组再过 `.filter()` 就拿不到上下文类型，`valueKind` 会被推成 `string`。
  const rows: Row[] = [
    {
      label: 'machine.row.status',
      value: status === '' ? '' : (CONTAINER_STATUS_KEY[status] ?? 'common.unknown'),
      valueKind: 'key',
    },
    {
      label: 'machine.row.task',
      // 这一行只说自己知道的那部分：容器在跑、任务没跑，是"活着但闲着"。
      value:
        container.task_running === true ? 'machine.row.status.running' : 'machine.row.task.idle',
      valueKind: 'key',
    },
    { label: 'machine.row.image', value: container.image ?? '', valueKind: 'text' },
    { label: 'machine.row.namespace', value: container.namespace ?? '', valueKind: 'text' },
  ];
  return rows.filter((row) => row.value !== '');
}

/**
 桌面状态：**一个结论**。

 ⚠️ 服务端的 `unavailable_reason` 既不在这里、也不上屏：它是**没有类型化 code 的原文**
 （判据见 `docs/research/ios-error-and-feedback.md` R45），中文界面上会变成一句英文，
 和它上面那句我们自己的话并列，看起来像半成品。五种结论各自有一句话
 （`machine.desktop.available` / `idle` / `notEnabled` / `notInstalled` / `unknown`），够用了。

 判定顺序是刻意的——先问"这个智能体开了桌面吗"，再问"容器里有没有桌面环境"，
 最后才是"画面在推吗"。反过来（先看 running）会把"没开桌面"显示成"桌面停了"。
 */
export function desktopVerdict(display: DisplayCapability | null): {
  verdict: 'available' | 'not-enabled' | 'not-installed' | 'idle' | 'unknown';
} {
  if (display === null) return { verdict: 'unknown' };
  if (display.enabled === false) return { verdict: 'not-enabled' };
  if (display.desktop_available === false || display.available === false) {
    return { verdict: 'not-installed' };
  }
  if (display.running === true) return { verdict: 'available' };
  return { verdict: 'idle' };
}

/** 用量这一组（读不到就空着，界面据此说"读不到"）。值都是算出来的数字，不是 key。 */
export function metricsRows(metrics: ContainerMetrics | null): Row[] {
  if (metrics === null || metrics.supported === false) return [];
  const used = metrics.metrics;
  const limits = metrics.resource_limits;
  const cpu = formatPercent(used?.cpu?.usage_percent);
  const rows: Row[] = [
    { label: 'machine.row.cpu', value: cpu, valueKind: 'text' },
    {
      label: 'machine.row.memory',
      value: usageWithLimit(used?.memory?.usage_bytes, limits?.memory?.limit_bytes),
      valueKind: 'text',
    },
    {
      label: 'machine.row.storage',
      value: usageWithLimit(used?.storage?.used_bytes, limits?.storage?.limit_bytes),
      valueKind: 'text',
    },
  ];
  return rows.filter((row) => row.value !== '');
}

/** agent 截图落在工作区的哪个目录（服务端 `screenshotSubdir`，见侦察记录）。 */
export const SCREENSHOT_DIRECTORY = '.memoh/screenshots';
