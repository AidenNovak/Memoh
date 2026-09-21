import React, { useState, type ComponentType } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

export interface NativeFilePreviewViewModel {
  status:
    | 'idle'
    | 'loading'
    | 'notFound'
    | 'error'
    | 'folder'
    | 'text'
    | 'image'
    | 'binary'
    | 'tooLarge'
    | 'imageError';
  loadingLabel: string;
  title: string;
  body: string;
  retryLabel: string;
  downloadLabel: string;
  truncatedLabel: string;
  imageURI?: string | null;
  imageHeaders: Record<string, string>;
  imageMeta: string;
  lines: string[];
  retryEnabled: boolean;
  breadcrumbs: { label: string; path: string; current: boolean }[];
}

export interface NativeFilePreviewViewProps extends ViewProps {
  mode: string;
  viewModelJson: string;
  onRetry?: (event: { nativeEvent: Record<string, never> }) => void;
  onDownload?: (event: { nativeEvent: Record<string, never> }) => void;
  onNavigate?: (event: { nativeEvent: { path?: string } }) => void;
  unavailableLabel?: string;
}

export function NativeFilePreviewView({
  unavailableLabel = 'Native file preview unavailable. Rebuild the iOS app.',
  ...props
}: NativeFilePreviewViewProps) {
  const [Component] = useState<ComponentType<NativeFilePreviewViewProps> | null>(() =>
    resolveMemohNativeView<NativeFilePreviewViewProps>('NativeFilePreviewView'),
  );
  if (Component) return <Component {...props} />;
  return (
    <View style={props.style} testID="native-file-preview-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
