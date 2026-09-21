/**
 * 通用选择器 sheet 的 RN 半边：**组装一份模型 → 等一个结论**。
 *
 * ## 为什么不是 `present()` 出来的 RN 页
 *
 * 以前 7 个选择器各是一张 RN sheet（`ui/ModelPickerPage.tsx` 等），每一张都把
 * `insetGrouped` 卡片、分隔线、命中区、键盘避让、选中勾再画一遍。形态一样、代价重复，
 * 而且它们**不是这个 App 独有的东西**——iOS 自己就有这套列表。现在原生画一次
 * （`modules/memoh-kit/ios/Chat/PickerSheets.swift`），RN 只负责两件事：
 *
 * 1. **组装**：标题、分组、每一行的文案与值、当前选中项、底部输入区（`NativePickerRequest`）。
 * 2. **等结论**：`select` → `{status:'completed', value}`；下滑关掉 → `{status:'cancelled'}`。
 *
 * 业务判据（拉目录、搜索过滤、强度档位、运行位置校验、重命名差分）**留在 RN**，
 * 原生不认识"模型""时区""会话"这些词——它只把用户点了哪一行、打了什么字报回来。
 *
 * ## 与 `present()` 的关系
 *
 * 返回值形状与 `present()` **一模一样**（`PresentationResult<T>`），所以调用点那行
 * `if (outcome.status !== 'completed') return;` 一个字都不用改。差别只有一处：
 * `present()` 会往路由栈里推一屏，这里不会——sheet 是原生自己 present 的，路由栈不动。
 *
 * ## 三种用法共用这一份（模块 9A3b）
 *
 * 除了"挑一个"（`list` / `grid`），这张 sheet 还承载两类界面，靠 `Section.layout` 区分：
 * `info`（只读信息面板：会话信息、机器面板）与 `form`（表单：cron 选择器）。
 * 它们**不是**选择器，但仍然走同一个 facade、同一个 promise：只读面板只用 `update`
 * （比如压缩完之后重画数字），最后靠下滑关掉（`cancelled`）收场；表单则靠 `select`
 * 把"用户按了哪一颗键/哪一格"报回来，由 RN 重算模型再 `update` 下发。
 *
 * ## 桥不在时的行为
 *
 * 旧 dev client（原生还没有 picker 方法）与非 iOS 平台上 `nativePicker()` 是 null。
 * 那时**当作"用户什么都没选"**（`cancelled`）而不是抛错：调用方本来就区分
 * `completed` / `cancelled`，两条路走同一条分支，不会把它带进一个没处理过的状态。
 * 代价说清楚：**选择器打不开**（点胶囊没反应），但 App 不会崩。
 */
import {
  nativePicker,
  type NativePickerSubscription,
  type NativeSettingsAvatar,
} from '@memoh-ios/kit';

import type { PresentationResult } from './sessions.ts';

/** 布局形态。
 *
 * - `list`（默认）：可选的分组列表行。
 * - `grid`：头像选择器那种方形符号块网格。
 * - `info`：**只读信息面板**（会话信息、机器面板）——行画成 `label + value`；
 *   `kind: 'progress'` 的那一行画成"标签 + 百分比 + 一条用量条"。这一种布局里**只有
 *   `valueJson` 非空的行可点**（那是动作行："立即压缩"、"看截图"），其余一律只读。
 * - `form`：**表单**（cron 选择器）——行按各自的 `kind` 画（radio / stepper / weekday / text）。
 *
 * 四种形态共用一张原生 sheet（同一套 detents、抓手、滑掉上报），见 spec §1：
 * 不为只读面板再写第二个 presenter。
 */
export type NativePickerLayout = 'list' | 'grid' | 'info' | 'form';

/** 选择器现在是什么状态。加载/失败**由 RN 判**，原生只按它画。 */
export type NativePickerStatus = 'ready' | 'loading' | 'error';

/**
 * 行的形态（只有 `form` 布局用得上，`list` / `grid` 忽略它）。
 *
 * - `radio`：与现在的列表行一样（可选、带勾）→ 回 `select` + 这一行的 `valueJson`。
 * - `stepper`：`−` `value` `+` 三件套 → 回 `select` + **那一颗键自己的**载荷
 *   （`downValueJson` / `upValueJson`）。
 * - `weekday`：`chips` 那些可点的格子 → 回 `select` + 那一格的载荷。
 * - `text`：受控输入框 → 回 `input`。
 * - `progress`：只读的用量行（`info` 布局里）→ 不可点。
 */
export type NativePickerRowKind = 'radio' | 'stepper' | 'weekday' | 'text' | 'progress';

/** 语气：只影响那一行的字色（`''` = 次级灰）。**由 RN 判好**，原生不猜。 */
export type NativePickerTone = 'destructive' | 'success' | 'warning' | '';

/**
 * 一格（`weekday` 行专用）。
 *
 * 文案与选中态都由 RN 给：原生不知道"周一"叫什么，也不会去拆 `"1,2,3"` 那种串
 * （那一串是给 RN 自己读的显示值，不是原生的输入）。
 */
export interface NativePickerChip {
  /** 这一格的标识；原生用它拼 testID（`picker-row-<行 id>-<格 id>`）。 */
  id: string;
  label: string;
  selected?: boolean;
  /**
   * 这一格被按下时回给 RN 的值。与行的 `valueJson` 同一条约定：**不透明**，原生原样回传。
   * 表单里"按了哪一格"这件事就靠它表达（RN 收到后自己重算 spec 再 `update`）。
   */
  valueJson: string;
}

/** 列表里的一行。 */
export interface NativePickerRow {
  /** 行标识。原生用它拼 testID（`picker-row-<id>`），RN 也用它认出"点的是哪一行"。 */
  id: string;
  label: string;
  /** 次级文案（模型 id、时区全名、会话来源…）；空串 = 不画。 */
  detail?: string;
  /** 行首的 SF Symbol 名（`grid` 时是格子里的图形）。 */
  symbol?: string;
  /**
   * 行首 / 格子里的**头像计划**（`list` 与 `grid` 都用得上）。
   *
   * 与 `symbol` 的关系：`avatar` 是"这个 bot / 这一枚头像到底长什么样"（远程图、内置图形、
   * 吉祥物），判据全在 RN（`features/bots/nativeAvatar.ts`）；`symbol` 退成**兜底**——
   * 只有 `avatar` 缺省时原生才按现在的画法画一颗符号。两样都给不会打架：原生优先看 `avatar`。
   */
  avatar?: NativeSettingsAvatar;
  selected?: boolean;
  /**
   * 选中这一行时回给 RN 的值。
   *
   * **不透明**：原生只原样回传，不解析。RN 自己 `JSON.stringify` 一个业务对象，
   * 收到后自己 `JSON.parse`——这样"这行代表什么"只有 RN 知道（原生不该认识 `modelId`
   * 这种字段名）。
   *
   * 在 `info` 面板里它还兼一个作用：**非空 = 这一行是动作行**（可点，例如"立即压缩"）。
   * 只读的行必须给空串——契约里 `valueJson` 是必填的，别漏。
   */
  valueJson: string;
  /**
   * 不可选（原生画灰态、不响应点击）。判据在 RN：切 agent 时 `check_state === 'issue'`
   * 的行就是这么挡的（服务端 `bot.status` 里没有 `error`，别照抄桌面端那句死代码）。
   */
  disabled?: boolean;
  /**
   * 按下**不关** sheet：这一行不是结论，只是"接着选"（切运行位置、再拉一批会话）。
   * 那些行由 RN 更新模型后重发一份，结算与否也由 RN 说了算。
   *
   * ⚠️ 设了它的行**必须同时用 `onSelect` 接管**：原生不会替这次出席结算，而事件仍然会
   * 到 `presentNativePicker`——不接管的话，`valueJson` 会被当成"他选了这个"直接结算掉。
   */
  staysOpen?: boolean;
  /** 行形态（`form` / `info` 布局才用得上）。缺省 = 普通列表行。 */
  kind?: NativePickerRowKind;
  /**
   * `info` 行的右侧值 / `stepper` 的当前显示值（RN 补好零：`09`）/ `progress` 的 0…1 比例。
   *
   * 同一个字段在三种行上是三种意思，但都是"这一行现在是什么值"——契约里只有这一个位置，
   * 再开两个字段只会让"该填哪个"更难说清。
   */
  value?: string;
  /** 等宽显示；`info` 行里同时允许长按选中复制（表达式、镜像名要能复制走）。 */
  mono?: boolean;
  /** 语气色（只读行用得上：无效表达式是危险色、桌面不可用是警告色）。 */
  tone?: NativePickerTone;
  /**
   * `stepper` 的两颗键各自的不透明载荷。
   *
   * 为什么是两份而不是一份 + 原生算方向：`valueJson` 的约定是"RN 序列化、原生原样回传"，
   * 原生一旦去改里面的 `delta` 就等于解析业务载荷了。方向留在 RN：
   * `{"action":"step","field":"hour","delta":-1}` / `…"delta":1`。
   */
  downValueJson?: string;
  upValueJson?: string;
  /** `weekday` 行的格子（星期 7 格、月份 12 格、每月几号 31 格都是它）。 */
  chips?: NativePickerChip[];
}

export interface NativePickerSection {
  id: string;
  /** 分组小标题；空 = 不画（例如"跟随默认"那一组自己带标题，动作行那一组不带）。 */
  header?: string;
  /** 分组标题左侧那颗单色厂商标的资源名（`features/chat/providerIcons.ts` 的 slug）。 */
  icon?: string;
  /**
   * 分组脚注；空 = 不画。
   *
   * `info` 面板靠它承载"为什么这一格是空的"那类说明（会话信息的"没有窗口所以不给百分比"、
   * 机器面板的"读不到用量"、cron 的"五段式"），位置与 RN 版的分组 footer 一致。
   */
  footer?: string;
  layout?: NativePickerLayout;
  rows: NativePickerRow[];
}

/** 底部单字段表单（重命名的"保存"、头像的自定义网址）。整个键缺省 = 不画输入区。 */
export interface NativePickerInput {
  label: string;
  placeholder: string;
  /** 受控值：击键通过 `onInput` 回到 RN，RN 改完再 `update` 推回去。 */
  value: string;
  submitLabel: string;
}

/** RN → 原生的一份完整模型（契约见 `.work-module9a3a-spec.md` §2）。 */
export interface NativePickerRequest {
  title: string;
  /** 空 = 不画搜索框。 */
  searchPlaceholder?: string;
  /**
   * 搜索框的 testID。给的是**原名**（`model-search` / `language-search` / `timezone-search`），
   * 与替换掉的那几张 RN 页一致——验收脚本按它们断言。缺省 = 不设标识。
   */
  searchTestID?: string;
  sections: NativePickerSection[];
  input?: NativePickerInput | null;
  emptyLabel?: string;
  loadingLabel?: string;
  status?: NativePickerStatus;
  errorTitle?: string;
  errorBody?: string;
  retryLabel?: string;
}

/**
 * 台上的把手。
 *
 * 为什么需要它：**一份模型不够用**。拉目录、再拉一页会话、重命名失败都要改已经画出来的
 * 那张 sheet，而"什么时候改"只有调用方知道（它是异步的）。
 */
export interface NativePickerHandle {
  /** 整份换掉台上的模型。已经结算过时是空操作。 */
  update(request: NativePickerRequest): void;
  /**
   * 自己给这次出席下结论（`select` 之外的路：重命名保存成功、运行位置校验通过）。
   * 会顺带收掉 sheet——原生那条"选中即关闭"的规矩在 RN 这一侧也成立。
   */
  finish(value: unknown): void;
}

/**
 * 交互回调。
 *
 * 全部可选：只有"用户打字"或"这一行不是选中而是另一个动作"的选择器才需要它们。
 */
export interface NativePickerInteractions {
  /**
   * sheet 已经在台上。
   *
   * 拉取数据从这里开始（`onPresented` 之后再 `update`）：**必须等 present 落地**，
   * 否则第一次 `update` 可能赶在原生把 sheet 挂上去之前，被丢掉之后界面就永远停在
   * 加载态（目录有缓存时那一帧会来得特别快）。
   */
  onPresented?(handle: NativePickerHandle): void;
  /** 搜索框击键（受控）。RN 过滤后 `update` 一份新模型。 */
  onSearch?(text: string, handle: NativePickerHandle): void;
  /** 底部输入框击键（受控）。 */
  onInput?(text: string, handle: NativePickerHandle): void;
  /** 底部"保存"被按了。**不会自动结算**——成不成只有 RN 知道（可能要发请求）。 */
  onSubmit?(text: string, handle: NativePickerHandle): void;
  /**
   * 这一行被点了，但**先让调用方看一眼**。
   *
   * 返回 `true` = 已接管（promise 不结算）：给两种行用——
   * "再拉一批"这种动作行，以及"点了不该直接生效"的行（切 agent 时 `check_state === 'issue'`
   * 的行要挡住）。返回 `false` / 什么都不返回 = 按 `select` 处理（解析 `valueJson` 后结算）。
   */
  onSelect?(valueJson: string, handle: NativePickerHandle): boolean | void;
  /** 失败态的重试钮。 */
  onRetry?(handle: NativePickerHandle): void;
}

/**
 * 打开一个原生选择器，等它的结论。
 *
 * 同一时刻只会有一个选择器（原生只有一层 sheet）：**已经在台上时，新的这一次直接回
 * `cancelled`**，不去动那张正在用的 sheet。理由是两个出席共用一个事件通道，放进来会
 * 互相串台——A 的 `await` 拿到 B 选的值，而 B 永远等不到结论。
 */
export function presentNativePicker<T>(
  request: NativePickerRequest,
  interactions: NativePickerInteractions = {},
): Promise<PresentationResult<T>> {
  return new Promise<PresentationResult<T>>((resolve) => {
    const picker = nativePicker();
    if (picker === null) {
      resolve({ status: 'cancelled' });
      return;
    }
    if (onStage !== null) {
      resolve({ status: 'cancelled' });
      return;
    }

    const token = Symbol('picker');
    onStage = token;
    let settled = false;
    let subscription: NativePickerSubscription | null = null;

    const settle = (result: PresentationResult<T>) => {
      // 只结算一次：下滑与 `finish()` 可能在同一帧里都到（原生那边也防了重复上报，
      // 但这里再防一次的成本是零，而漏防的代价是"关掉下面那一屏"）。
      if (settled) return;
      settled = true;
      if (onStage === token) onStage = null;
      subscription?.remove();
      subscription = null;
      resolve(result);
    };

    const handle: NativePickerHandle = {
      update: (next) => {
        // 结算之后台上那张 sheet 已经不属于这一次出席了，推过去只会改到别人的界面。
        if (settled) return;
        fireAndForget(() => picker.pickerUpdate(JSON.stringify(next)));
      },
      finish: (value) => {
        if (settled) return;
        // 先结算再收 sheet：收的动作会让原生报一个 `dismissed`，那时这次出席已经结束，
        // 它不该把结论改写成 `cancelled`。
        settle({ status: 'completed', value: value as T });
        fireAndForget(() => picker.pickerDismiss());
      },
    };

    // **先订阅再 present**：sheet 可能在 present 落地前就被关掉（下滑、坏 JSON），
    // 那一次 `dismissed` 不能丢——丢了调用方的 await 永远不返回。
    subscription = picker.addListener('onPickerEvent', (payload) => {
      if (settled) return;
      switch (payload.type) {
        case 'select': {
          const valueJson = payload.valueJson ?? '';
          if (interactions.onSelect?.(valueJson, handle) === true) return;
          const value = parseRowValue(valueJson);
          // 坏载荷（空串、非法 JSON）不动结论：宁可等用户再点一次，
          // 也不要把一个 `undefined` 当成"他选了这个"交给调用方。
          if (value === undefined) return;
          settle({ status: 'completed', value: value as T });
          return;
        }
        case 'submit':
          interactions.onSubmit?.(payload.text ?? '', handle);
          return;
        case 'input':
          interactions.onInput?.(payload.text ?? '', handle);
          return;
        case 'search':
          interactions.onSearch?.(payload.text ?? '', handle);
          return;
        case 'retry':
          interactions.onRetry?.(handle);
          return;
        case 'dismissed':
          settle({ status: 'cancelled' });
          return;
        default:
          // 不认识的动作（旧原生多报一种）：什么都不做，等一个认识的。
          return;
      }
    });

    void (async () => {
      try {
        // `await` 包一层：这几个方法在新原生里是 `AsyncFunction`（返回 promise），
        // 但万一注册成同步函数（返回 undefined）或当场抛错，这条路也要能收场。
        await picker.pickerPresent(JSON.stringify(request));
        if (!settled) interactions.onPresented?.(handle);
      } catch {
        // 原生没接这份模型（坏 JSON / 没有可挂的宿主）：别把调用方挂在 await 上。
        settle({ status: 'cancelled' });
      }
    })();
  });
}

/** 台上那一张 sheet 的令牌；null = 没有。见 `presentNativePicker` 的文件头。 */
let onStage: symbol | null = null;

/**
 一次"发了就算"的桥调用（推模型 / 收 sheet）。

 同步/异步、成功/失败都不该把选择器带崩：这一下失败不改变任何结论——该不该结算、
 该不该关，是 RN 已经在别处定好的事。
 */
function fireAndForget(call: () => Promise<void> | void): void {
  void (async () => {
    try {
      await call();
    } catch {
      // 故意吞掉：一次 `pickerUpdate` / `pickerDismiss` 没发出去，界面停在上一份模型上，
      // 而这次出席的结论不受影响（原生那边收不掉时用户还能下滑）。
    }
  })();
}

/** 解析行值。空串与非法 JSON 回 `undefined`（合法的行值不可能是它）。 */
function parseRowValue(valueJson: string): unknown {
  if (valueJson === '') return undefined;
  try {
    return JSON.parse(valueJson);
  } catch {
    return undefined;
  }
}
