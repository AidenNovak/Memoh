import React, { useState, type ComponentType } from 'react';
import { Platform, Text, View, type ViewProps } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

export interface NativeSessionsViewModel {
  title: string;
  newSessionLabel: string;
  newBotLabel: string;
  botMenuLabel: string;
  viewMenuLabel: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyBody: string;
  errorTitle: string;
  retryLabel: string;
  loadingLabel: string;
  moreLabel: string;
  moreLoadingLabel: string;
  moreFailedLabel: string;
  windowLabel: string;
  pendingTitle: string;
  activeTitle: string;
  renameLabel: string;
  forkLabel: string;
  actionsHint: string;
  loading: boolean;
  errorMessage?: string | null;
  retryEnabled: boolean;
  moreState: 'none' | 'more' | 'loading' | 'error';
  connection?: { label: string; pendingLabel: string; retryHint: string } | null;
  bots: { id: string; name: string; statusLabel: string; selected: boolean }[];
  views: { id: string; label: string; symbol: string; selected: boolean }[];
  pendingApprovals: { id: string; botId: string; title: string; detail: string }[];
  activeRuns: { id: string; botId: string; title: string; detail: string }[];
  sessions: {
    id: string;
    title: string;
    subtitle: string;
    updatedLabel: string;
    canFork: boolean;
  }[];
}

export interface NativeSessionsViewProps extends ViewProps {
  mode: string;
  viewModelJson: string;
  onOpenSession?: (event: { nativeEvent: { sessionId?: string; botId?: string } }) => void;
  onNewSession?: (event: { nativeEvent: Record<string, never> }) => void;
  onRefresh?: (event: { nativeEvent: Record<string, never> }) => void;
  onLoadMore?: (event: { nativeEvent: Record<string, never> }) => void;
  onSelectBot?: (event: { nativeEvent: { botId?: string } }) => void;
  onSelectView?: (event: { nativeEvent: { view?: string } }) => void;
  onSessionAction?: (event: { nativeEvent: { sessionId?: string; action?: string } }) => void;
  unavailableLabel?: string;
}

let resolved = false;
let NativeView: ComponentType<NativeSessionsViewProps> | null = null;

function resolveView() {
  if (resolved) return NativeView;
  resolved = true;
  if (Platform.OS !== 'ios') return null;
  try {
    const module = requireOptionalNativeModule('MemohKit');
    const runtime = globalThis as typeof globalThis & {
      expo?: { getViewConfig?: (module: string, view: string) => unknown };
    };
    if (module && runtime.expo?.getViewConfig?.('MemohKit', 'NativeSessionsView')) {
      NativeView = requireNativeView<NativeSessionsViewProps>('MemohKit', 'NativeSessionsView');
    }
  } catch {
    // Older dev clients may not contain this view yet.
  }
  return NativeView;
}

export function NativeSessionsView({
  unavailableLabel = 'Native sessions unavailable. Rebuild the iOS app.',
  ...props
}: NativeSessionsViewProps) {
  const [Component] = useState(() => resolveView());
  if (Component) return <Component {...props} />;
  return (
    <View style={props.style} testID="native-sessions-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
