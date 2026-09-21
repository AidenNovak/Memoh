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
 * ## 桥不在时的行为
 *
 * 旧 dev client（原生还没有 picker 方法）与非 iOS 平台上 `nativePicker()` 是 null。
 * 那时**当作"用户什么都没选"**（`cancelled`）而不是抛错：调用方本来就区分
 * `completed` / `cancelled`，两条路走同一条分支，不会把它带进一个没处理过的状态。
 * 代价说清楚：**选择器打不开**（点胶囊没反应），但 App 不会崩。
 */
import { nativePicker, type NativePickerSubscription } from '@memoh-ios/kit';

import type { PresentationResult } from './sessions.ts';

/** 列表形态。`grid` 只给头像选择器（每格是方形符号块）。 */
export type NativePickerLayout = 'list' | 'grid';

/** 选择器现在是什么状态。加载/失败**由 RN 判**，原生只按它画。 */
export type NativePickerStatus = 'ready' | 'loading' | 'error';

/** 列表里的一行。 */
export interface NativePickerRow {
  /** 行标识。原生用它拼 testID（`picker-row-<id>`），RN 也用它认出"点的是哪一行"。 */
  id: string;
  label: string;
  /** 次级文案（模型 id、时区全名、会话来源…）；空串 = 不画。 */
  detail?: string;
  /** 行首的 SF Symbol 名（`grid` 时是格子里的图形）。 */
  symbol?: string;
  selected?: boolean;
  /**
   * 选中这一行时回给 RN 的值。
   *
   * **不透明**：原生只原样回传，不解析。RN 自己 `JSON.stringify` 一个业务对象，
   * 收到后自己 `JSON.parse`——这样"这行代表什么"只有 RN 知道（原生不该认识 `modelId`
   * 这种字段名）。
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
}

export interface NativePickerSection {
  id: string;
  /** 分组小标题；空 = 不画（例如"跟随默认"那一组自己带标题，动作行那一组不带）。 */
  header?: string;
  /** 分组标题左侧那颗单色厂商标的资源名（`features/chat/providerIcons.ts` 的 slug）。 */
  icon?: string;
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
