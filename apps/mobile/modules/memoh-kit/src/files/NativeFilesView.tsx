import React, { useState, type ComponentType } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';
import type { NativeHubChromeModel } from '../hub/NativeHubChrome';

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
  /** Hub 顶层件（大标题 / 视图切换 / agent 菜单 / 连接行 / 新建会话）；缺省 = 不画。 */
  hub?: NativeHubChromeModel | null;
}

export interface NativeFilesViewProps extends ViewProps {
  mode: string;
  viewModelJson: string;
  onOpen?: (event: { nativeEvent: { path?: string; isDir?: boolean } }) => void;
  onNavigate?: (event: { nativeEvent: { path?: string } }) => void;
  onRefresh?: (event: { nativeEvent: Record<string, never> }) => void;
  onLoadMore?: (event: { nativeEvent: Record<string, never> }) => void;
  onAction?: (event: { nativeEvent: { path?: string; action?: string } }) => void;
  /** Hub：切视图（`sessions` | `files` | `schedule`）。 */
  onViewChange?: (event: { nativeEvent: { view?: string } }) => void;
  /** Hub：切 agent / 新建 agent（`botId === '__new__'`）。 */
  onSelectBot?: (event: { nativeEvent: { botId?: string } }) => void;
  /** Hub：新建会话。 */
  onNewSession?: (event: { nativeEvent: Record<string, never> }) => void;
  /** Hub：点连接行重试。 */
  onRetryConnection?: (event: { nativeEvent: Record<string, never> }) => void;
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
