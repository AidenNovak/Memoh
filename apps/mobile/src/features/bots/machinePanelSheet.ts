/**
 * 「机器」浮窗：**组装原生只读面板的模型**（`layout: 'info'`）。
 *
 * 这一份替掉 `ui/MachinePanelPage.tsx`（那张 RN sheet 已删除）。搬走的只有"画"，
 * 原页那三条判据一条都没丢（它们本来就在 `features/machine/panel.ts` 里，这次只调用）：
 *
 * 1. **三个只读端点并行拿**，而且**只有三个都失败**才算这一屏失败：容器读到了、
 *    用量读不到，仍然是有用的信息（原页的 `Promise.allSettled` 判据）。
 * 2. **读不到不是 0**：用量那几行由 `metricsRows` 决定（`supported: false` 或字段缺失
 *    就整组不画，并在脚注里说"读不到"）。
 * 3. **桌面只给一个结论**：`desktopVerdict` 的判定顺序（先问开没开桌面、再问容器里
 *    装没装、最后才是画面在推没有）一字不差；服务端的 `unavailable_reason` 仍然不上屏。
 *
 * ## 没有"连接桌面"按钮，但有一条真能看到屏幕的路
 *
 * 实时桌面是 WebRTC（服务端只发 host candidate、没有 STUN/TURN），本客户端没接原生
 * WebRTC，所以给一个"连接"按钮只会得到一个必然失败的按钮。这一屏给的是
 * **agent 截图落进工作区**那条路（`machine.openScreenshots`）——它原来是一个 RN 路由
 * `push`，现在是面板返回的一个动作：**先收掉 sheet，再由调用方 push**
 * （sheet 是原生 present 的，压在 RN 栈上面，不先收掉的话用户按了什么都不会发生）。
 */
import type { ContainerMetrics, ContainerStatus, DisplayCapability } from '../../api/types.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
  type NativePickerRow,
  type NativePickerSection,
  type NativePickerTone,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import { desktopVerdict, machineRows, metricsRows, type Row } from '../machine/panel.ts';

/** 这一屏只用得上三个只读端点（与 `features/chat/models.ts` 的 `CatalogSource` 同一条规矩）。 */
export interface MachinePanelSource {
  getContainer(botId: string): Promise<ContainerStatus>;
  getContainerMetrics(botId: string): Promise<ContainerMetrics>;
  getDisplay(botId: string): Promise<DisplayCapability>;
}

export interface MachinePanelParams {
  /** 数据来源。null = 还没建连，这时不开这张 sheet（与 `presentModelPicker` 同一条）。 */
  client: MachinePanelSource | null;
  botId: string;
}

/** 面板上的动作。现在只有一条：去看截图（由调用方 push 那个文件目录）。 */
export interface MachinePanelAction {
  action: 'openScreenshots';
}

type Verdict = 'available' | 'idle' | 'not-enabled' | 'not-installed' | 'unknown';

const VERDICT_KEY: Record<Verdict, string> = {
  available: 'machine.desktop.available',
  idle: 'machine.desktop.idle',
  'not-enabled': 'machine.desktop.notEnabled',
  'not-installed': 'machine.desktop.notInstalled',
  unknown: 'machine.desktop.unknown',
};

/**
 结论的语气色。

 原页在结论句前面点一颗小圆点（可用是绿、容器里没装是黄、其余是灰）。这里改成**给那句话上色**：
 只读行没有"圆点"这个位置，而颜色要落在有信息量的那一档上（"没装桌面环境"是要用户换镜像的，
 与"这个 bot 没开桌面"不是同一件事）。
 */
const VERDICT_TONE: Record<Verdict, NativePickerTone> = {
  available: 'success',
  idle: '',
  'not-enabled': '',
  'not-installed': 'warning',
  unknown: '',
};

export function presentMachinePanel(
  params: MachinePanelParams,
): Promise<PresentationResult<MachinePanelAction>> {
  const { botId, client } = params;
  if (client === null || botId === '') return Promise.resolve({ status: 'cancelled' });

  let container: ContainerStatus | null = null;
  let metrics: ContainerMetrics | null = null;
  let display: DisplayCapability | null = null;
  /** 三个端点**全都**失败（原页同一条：只有一个失败仍然是有用的信息）。 */
  let failed = false;
  let loading = true;

  const buildRequest = (): NativePickerRequest => {
    const sections: NativePickerSection[] = [];
    const machine = machineRows(container);
    const usage = metricsRows(metrics);
    const verdict = desktopVerdict(display).verdict;

    if (machine.length > 0) {
      sections.push({
        id: 'machine',
        header: t('machine.group.machine'),
        layout: 'info',
        rows: machine.map((row) => rowOf('machine', row)),
      });
    }

    if (display !== null) {
      sections.push({
        id: 'desktop',
        header: t('machine.group.desktop'),
        footer: t('machine.desktop.footer'),
        layout: 'info',
        rows: [
          {
            id: 'machine-desktop-verdict',
            // 结论句本身就是这一行：没有可对照的标签，颜色落在它身上（见 VERDICT_TONE）。
            label: t(VERDICT_KEY[verdict]),
            tone: VERDICT_TONE[verdict],
            valueJson: '',
          },
          {
            id: 'machine-open-screenshots',
            label: t('machine.openScreenshots'),
            // **由这里结算**（要先收掉 sheet 才能 push 那个目录），所以整行 `staysOpen`。
            staysOpen: true,
            valueJson: JSON.stringify({ action: 'openScreenshots' } satisfies MachinePanelAction),
          },
        ],
      });
    }

    // 用量那一组：读不到时**也要有一组**——原页会单独画一句"读不到用量"，而这里的脚注
    // 就是那句话（没有行的分组靠脚注才画得出来，见 `NativePickerSheet.swift` 的 `list`）。
    if (usage.length > 0 || metrics !== null) {
      sections.push({
        id: 'usage',
        header: t('machine.group.usage'),
        footer:
          metrics !== null && metrics.supported === false ? t('machine.usage.unsupported') : '',
        layout: 'info',
        rows: usage.map((row) => rowOf('machine-usage', row)),
      });
    }

    return {
      title: t('machine.title'),
      sections,
      // 三个都失败 → 错误块（原页就是一行红字）。没有重试钮：原页也没有，且这一屏随时
      // 可以下滑关掉再点开（重新进来就会重拉）。
      status: statusOf(failed, loading),
      // 原页的加载态只有一颗转圈，没有文案（`loadingLabel` 空串 = 只画转圈）。
      loadingLabel: '',
      errorTitle: failed ? t('machine.failed') : '',
      errorBody: '',
      retryLabel: '',
    };
  };

  /** 三个只读端点并行拿（它们互不依赖，串行只会让浮窗慢三倍）。 */
  const load = async (handle: NativePickerHandle) => {
    const results = await Promise.allSettled([
      client.getContainer(botId),
      client.getContainerMetrics(botId),
      client.getDisplay(botId),
    ]);
    if (results[0].status === 'fulfilled') container = results[0].value;
    if (results[1].status === 'fulfilled') metrics = results[1].value;
    if (results[2].status === 'fulfilled') display = results[2].value;
    failed = results.every((result) => result.status === 'rejected');
    loading = false;
    handle.update(buildRequest());
  };

  return presentNativePicker<MachinePanelAction>(buildRequest(), {
    onPresented: (handle) => {
      void load(handle);
    },
    onSelect: (valueJson, handle) => {
      if (readAction(valueJson) === 'openScreenshots') {
        // 先结算（调用方拿到动作后去 push），sheet 由原生那条"结算即收掉"的路收走。
        handle.finish({ action: 'openScreenshots' });
      }
      return true;
    },
  });
}

/** 一行只读值。`valueKind` 的两种来源照原页处理：文案 key 要过 `t()`，服务端原文原样显示。 */
function rowOf(prefix: string, row: Row): NativePickerRow {
  return {
    id: `${prefix}-${row.label}`,
    label: t(row.label),
    value: row.valueKind === 'key' ? t(row.value) : row.value,
    valueJson: '',
  };
}

/**
 现在是什么状态。

 三个端点**全都**失败才是错误页（原页那一行红字）；还没拿到任何数据时是加载态
（原页那颗转圈）；其余一律画数据——**部分失败不影响上屏**，容器读到了就是有用的信息。
 */
function statusOf(failed: boolean, loading: boolean): 'ready' | 'loading' | 'error' {
  if (failed) return 'error';
  if (loading) return 'loading';
  return 'ready';
}

/** 行值解析。认不出就回 null（这一行我们不知道它要做什么）。 */
function readAction(valueJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const action = (parsed as { action?: unknown }).action;
    return typeof action === 'string' ? action : null;
  } catch {
    return null;
  }
}
