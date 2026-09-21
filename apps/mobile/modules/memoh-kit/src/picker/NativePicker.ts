/**
 * 通用选择器 sheet 的 typed facade。
 *
 * ## 为什么是模块级函数，而不是 RN 的 presented 页
 *
 * 7 个选择器（模型 / 头像 / 语言 / 时区 / 运行位置 / 切 agent / 重命名）以前各是一张
 * `present()` 出来的 RN sheet（`ui/*PickerPage.tsx`）。它们的形态几乎一样——分组列表、
 * 一颗搜索框、当前项打勾——而每一张都要自己再画一遍 `insetGrouped` 卡片、分隔线、
 * 命中区、键盘避让。现在原生只画一次（`Chat/PickerSheets.swift`），RN 只"组装一份模型 +
 * 等结论"。
 *
 * 与 `NativeChatSheets` 同一套理由，逐条一致：
 *
 * - **不占 RN 布局**：sheet 由原生自己 present（`ChatSheetPresenter`），RN 只叫它出来 /
 *   推新模型 / 收掉。
 * - **允许 null**：旧 dev client 里模块在、方法不在；非 iOS 平台也没有它。调用方拿到
 *   null 时必须能继续跑（不弹选择器，而不是崩）。
 * - **方法名照抄**：名字必须与 `MemohKitModule.swift` 里注册的字符串**一字不差**。对不上
 *   时模块还在、函数还在，但 JS 拿到 undefined——表现是"桥什么都没发生"，而构建一切正常。
 *
 * ## 行值是不透明字符串
 *
 * `select` 事件回的是 `valueJson`（RN 自己 stringify 的 JSON），**原生不解析它**：
 * 选择器不知道"模型""时区""会话"是什么，它只知道"这一行被点了，这是这行的值"。
 * 业务语义（哪个字段、要不要发 PATCH）全在 RN。
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/**
 * 原生报上来的动作。
 *
 * `type`：`select`（点了某一行）/ `submit`（底部表单的"保存"）/ `input`（输入框击键）/
 * `search`（搜索框击键）/ `dismissed`（用户下滑关掉了）/ `retry`（失败态的重试钮）。
 * 其余字段按 `type` 取用。
 *
 * ⚠️ **`submit` 与 `select` 不一样：它不自动关 sheet。** `select` 之后原生立刻收掉，
 * 而 `submit` 只是一个"用户按了保存"的信号——保存要发请求（重命名是 `PATCH`），
 * 成不成只有 RN 知道，所以由 RN 决定收还是不收（失败时把原因推回去）。
 */
export interface NativePickerEventPayload {
  type?: string;
  /** `select` 的不透明行值（RN 自己 `JSON.stringify` 的）。 */
  valueJson?: string;
  /** `submit` / `input` / `search` 的文本。 */
  text?: string;
}

export type NativePickerEvent = 'onPickerEvent';

/** 事件 → 载荷的对照表：`addListener` 据此把每个事件的载荷收窄。 */
export interface NativePickerEventMap {
  onPickerEvent: NativePickerEventPayload;
}

export interface NativePickerSubscription {
  remove(): void;
}

export interface NativePicker {
  /** `json` = `JSON.stringify(NativePickerRequest)`；已在则只更新模型。 */
  pickerPresent(json: string): Promise<void>;
  /** 已在台上时整份换掉模型（搜索过滤、加载态、失败态都走它）。 */
  pickerUpdate(json: string): Promise<void>;
  /** 收掉。没在台上时是空操作。 */
  pickerDismiss(): Promise<void>;
  addListener<E extends NativePickerEvent>(
    event: E,
    listener: (payload: NativePickerEventMap[E]) => void,
  ): NativePickerSubscription;
}

const REQUIRED_METHODS: readonly (keyof NativePicker)[] = [
  'pickerPresent',
  'pickerUpdate',
  'pickerDismiss',
  'addListener',
];

/** 能力探测：模块在 + 需要的方法都在（老构建里模块在、方法不在）。 */
function isPickerCapable(module: unknown): module is NativePicker {
  if (typeof module !== 'object' || module === null) return false;
  const candidate = module as Record<string, unknown>;
  return REQUIRED_METHODS.every((name) => typeof candidate[name] === 'function');
}

let resolved = false;
let facade: NativePicker | null = null;

export function nativePicker(): NativePicker | null {
  if (resolved) return facade;
  resolved = true;
  if (Platform.OS !== 'ios') return null;
  try {
    const module = requireOptionalNativeModule<unknown>('MemohKit');
    if (module === null || module === undefined) return null;
    if (isPickerCapable(module)) {
      facade = module;
      return facade;
    }
  } catch {
    return null;
  }
  return null;
}
