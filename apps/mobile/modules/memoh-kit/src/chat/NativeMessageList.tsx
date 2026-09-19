import { requireNativeView, requireOptionalNativeModule } from 'expo';
import React, { type ComponentType } from 'react';
import { Platform, Text, View, type ViewProps } from 'react-native';

export interface NativeMessageListProps extends ViewProps {
  /** JSON.stringify(RenderTurn[]); the reducer owns ordering and stream assembly. */
  turnsJson: string;
  onReachTop?: () => void;
  /**
   * 错误块里"再来一次"的回执。
   *
   * 判据（什么时候给动作、什么时候不给）在原生侧 `ErrorBlockPresentation` —— 与
   * `features/errors/present.ts` 同构；这里只负责**执行**：原生报上来是哪一轮，
   * 我们把那一轮的用户输入重发一次。
   *
   * **不传 = 这个宿主没有能执行动作的东西**（例如只回放本地帧的场景台）。原生据此
   * 不显示按钮：一个点了没反应的按钮比不给更糟。
   */
  onErrorAction?: (event: {
    nativeEvent: { turn?: string; text?: string; block?: string };
  }) => void;
  /**
   * 复制成功的回执（原生侧已经落了粘贴板、也已经自己确认过一次）。
   *
   * 有了它，宿主可以把 `chat.message.copied` 那条文案接上（例如自己的提示条）：
   * `event.nativeEvent.text` 就是**渲染后的纯文本**，与粘贴板里的一致。
   *
   * **不传也不影响复制**：原生侧自带胶囊确认与读屏播报。这条事件存在的意义只是让宿主
   * 有机会用同一套文案，而不是各自发明一句。
   */
  onMessageCopied?: (event: { nativeEvent: { block?: string; text?: string } }) => void;
  emptyTitle?: string;
  emptyBody?: string;
  unavailableLabel?: string;
}

let resolved = false;
let NativeView: ComponentType<NativeMessageListProps & { errorActionEnabled: boolean }> | null =
  null;

function resolveView() {
  if (resolved) return NativeView;
  resolved = true;
  if (Platform.OS !== 'ios') return null;
  try {
    const module = requireOptionalNativeModule('MemohKit');
    // Expo registers host views lazily: module presence alone cannot prove a view exists.
    const runtime = globalThis as typeof globalThis & {
      expo?: { getViewConfig?: (module: string, view: string) => unknown };
    };
    if (module && runtime.expo?.getViewConfig?.('MemohKit', 'NativeMessageList')) {
      NativeView = requireNativeView('MemohKit', 'NativeMessageList');
    }
  } catch {
    // An older dev client may not contain the native module yet.
  }
  return NativeView;
}

export function NativeMessageList({
  onErrorAction,
  onMessageCopied,
  unavailableLabel = 'Native messages unavailable. Rebuild the iOS app.',
  ...props
}: NativeMessageListProps) {
  const Component = resolveView();
  if (Component) {
    return (
      <Component
        {...props}
        // 按钮只在**有人能执行**的时候出现（原生侧的 `actionEnabled`）。
        errorActionEnabled={onErrorAction !== undefined}
        onErrorAction={onErrorAction}
        onMessageCopied={onMessageCopied}
      />
    );
  }
  // Availability notice only, never a second transcript renderer or Android implementation.
  return (
    <View style={props.style} testID="native-messages-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
