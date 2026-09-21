/**
 * 审批 / ask_user 两个 **原生 sheet** 的 typed facade。
 *
 * ## 为什么是模块级函数，而不是视图薄壳
 *
 * 这两个 sheet 不占 RN 布局里的位置：它们是原生自己 present 的 UIKit sheet（原生侧
 * `ChatSheetPresenter`），RN 只是"叫它出来 / 叫它收掉 / 把新模型推过去"。
 * present 幂等——sheet 已经在就只更新模型（SwiftUI 重渲染），不重复 present。
 *
 * ## 为什么允许 null
 *
 * 与 `nativeNotifications()` 同一套理由：**旧 dev client** 里原生代码还没编进去，模块在
 * 但方法不在；非 iOS 平台也不该崩。所以调用方拿到的可能是 null，且必须能继续跑
 * （不弹 sheet 也照样能收发消息，只是少了审批这一步的图形入口）。
 *
 * ## 为什么方法名照抄不重命名
 *
 * 名字必须与 `MemohKitModule.swift` 里注册的字符串**一字不差**。对不上时模块还在、函数
 * 还在，但 JS 拿到的是 undefined——表现是"桥什么都没发生"，而构建一切正常
 * （notifications 那层踩过同一个坑）。
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/** 用户选了审批选项（`reason` 只在拒绝流里有值）。 */
export interface NativeChatApprovalChoosePayload {
  optionId?: string;
  reason?: string;
}

/**
 * ask_user sheet 报上来的动作。
 *
 * `type`：`toggleOption` / `toggleCustom` / `setText` / `footerText` / `submit` / `cancel`；
 * 其余字段按 `type` 取用（原生不构建答案，只把用户做了什么报回来）。
 */
export interface NativeChatUserInputPayload {
  type?: string;
  questionId?: string;
  optionId?: string;
  text?: string;
}

export type NativeChatSheetEvent = 'onChatApprovalChoose' | 'onChatUserInputEvent';

/** 事件 → 载荷的对照表：`addListener` 据此把每个事件的载荷收窄。 */
export interface NativeChatSheetEventMap {
  onChatApprovalChoose: NativeChatApprovalChoosePayload;
  onChatUserInputEvent: NativeChatUserInputPayload;
}

export interface NativeChatSheetSubscription {
  remove(): void;
}

export interface NativeChatSheets {
  /** `json` = `JSON.stringify(ApprovalSheetModel)`；已在则只更新模型。 */
  chatPresentApproval(json: string): Promise<void>;
  chatDismissApproval(): Promise<void>;
  /** `json` = `JSON.stringify(UserInputSheetModel)`；已在则只更新模型。 */
  chatPresentUserInput(json: string): Promise<void>;
  chatDismissUserInput(): Promise<void>;
  addListener<E extends NativeChatSheetEvent>(
    event: E,
    listener: (payload: NativeChatSheetEventMap[E]) => void,
  ): NativeChatSheetSubscription;
}

const REQUIRED_METHODS: readonly (keyof NativeChatSheets)[] = [
  'chatPresentApproval',
  'chatDismissApproval',
  'chatPresentUserInput',
  'chatDismissUserInput',
  'addListener',
];

/** 能力探测：模块在 + 需要的方法都在（老构建里模块在、方法不在）。 */
function isChatSheetCapable(module: unknown): module is NativeChatSheets {
  if (typeof module !== 'object' || module === null) return false;
  const candidate = module as Record<string, unknown>;
  return REQUIRED_METHODS.every((name) => typeof candidate[name] === 'function');
}

let resolved = false;
let facade: NativeChatSheets | null = null;

export function nativeChatSheets(): NativeChatSheets | null {
  if (resolved) return facade;
  resolved = true;
  if (Platform.OS !== 'ios') return null;
  try {
    const module = requireOptionalNativeModule<unknown>('MemohKit');
    if (module === null || module === undefined) return null;
    if (isChatSheetCapable(module)) {
      facade = module;
      return facade;
    }
  } catch {
    return null;
  }
  return null;
}
