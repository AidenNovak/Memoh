import React, { useState, type ComponentType } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

export interface NativeFilesViewModel {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'permission' | 'invalid' | 'error';
  title: string;
  loadingLabel: string;
  emptyLabel: string;
  permissionTitle: string;
  permissionBody: string;
  invalidTitle: string;
  invalidBody: string;
  errorTitle: string;
  errorBody: string;
  retryLabel: string;
  upLabel: string;
  moreLabel: string;
  footer: string;
  openLabel: string;
  copyPathLabel: string;
  downloadLabel: string;
  breadcrumbs: { label: string; path: string; current: boolean }[];
  entries: {
    name: string;
    path: string;
    subtitle: string;
    symbol: string;
    accessibilityLabel: string;
    isDir: boolean;
  }[];
  hiddenCount: number;
  retryEnabled: boolean;
  parentPath?: string | null;
}

export interface NativeFilesViewProps extends ViewProps {
  mode: string;
  viewModelJson: string;
  onOpen?: (event: { nativeEvent: { path?: string; isDir?: boolean } }) => void;
  onNavigate?: (event: { nativeEvent: { path?: string } }) => void;
  onRefresh?: (event: { nativeEvent: Record<string, never> }) => void;
  onLoadMore?: (event: { nativeEvent: Record<string, never> }) => void;
  onAction?: (event: { nativeEvent: { path?: string; action?: string } }) => void;
  unavailableLabel?: string;
}

export function NativeFilesView({
  unavailableLabel = 'Native files unavailable. Rebuild the iOS app.',
  ...props
}: NativeFilesViewProps) {
  const [Component] = useState<ComponentType<NativeFilesViewProps> | null>(() =>
    resolveMemohNativeView<NativeFilesViewProps>('NativeFilesView'),
  );
  if (Component) return <Component {...props} />;
  return (
    <View style={props.style} testID="native-files-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
