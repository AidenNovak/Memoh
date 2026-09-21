import React, { useState, type ComponentType } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

export interface NativeScheduleListViewModel {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'permission' | 'error';
  title: string;
  loadingLabel: string;
  emptyTitle: string;
  emptyBody: string;
  permissionTitle: string;
  permissionBody: string;
  errorTitle: string;
  errorBody: string;
  retryEnabled: boolean;
  retryLabel: string;
  newLabel: string;
  footer: string;
  timezone: string;
  toggleEnabled: boolean;
  rows: {
    id: string;
    name: string;
    subtitle: string;
    enabled: boolean;
    accessibilityLabel: string;
  }[];
}

export interface NativeScheduleEditorViewModel {
  status: 'loading' | 'ready' | 'saving' | 'permission' | 'error';
  title: string;
  loadingLabel: string;
  permissionTitle: string;
  permissionBody: string;
  errorTitle: string;
  errorBody: string;
  validationError?: string | null;
  nameLabel: string;
  descriptionLabel: string;
  commandLabel: string;
  commandPlaceholder: string;
  patternLabel: string;
  enabledLabel: string;
  maxCallsLabel: string;
  maxCallsPlaceholder: string;
  frequencyLabel: string;
  runTargetLabel: string;
  runTargetValue: string;
  executionFooter: string;
  timezone: string;
  nextPreview: string;
  saveLabel: string;
  savingLabel: string;
  deleteLabel: string;
  deleteTitle: string;
  deleteBody: string;
  deleteRunningBody: string;
  deleteConfirmLabel: string;
  cancelLabel: string;
  name: string;
  description: string;
  command: string;
  pattern: string;
  enabled: boolean;
  maxCalls: string;
}

export interface NativeScheduleViewProps extends ViewProps {
  mode: string;
  listModelJson?: string;
  editorModelJson?: string;
  onRefresh?: (event: { nativeEvent: Record<string, never> }) => void;
  onRetry?: (event: { nativeEvent: Record<string, never> }) => void;
  onNew?: (event: { nativeEvent: Record<string, never> }) => void;
  onOpen?: (event: { nativeEvent: { scheduleId?: string } }) => void;
  onToggle?: (event: { nativeEvent: { scheduleId?: string; enabled?: boolean } }) => void;
  onBack?: (event: { nativeEvent: Record<string, never> }) => void;
  onFieldChange?: (event: { nativeEvent: { field?: string; value?: string } }) => void;
  onPatternPicker?: (event: { nativeEvent: Record<string, never> }) => void;
  onEnabledChange?: (event: { nativeEvent: { enabled?: boolean } }) => void;
  onRunTarget?: (event: { nativeEvent: Record<string, never> }) => void;
  onSave?: (event: { nativeEvent: Record<string, never> }) => void;
  onDelete?: (event: { nativeEvent: Record<string, never> }) => void;
  unavailableLabel?: string;
}

export function NativeScheduleView({
  unavailableLabel = 'Native schedule unavailable. Rebuild the iOS app.',
  ...props
}: NativeScheduleViewProps) {
  const [Component] = useState<ComponentType<NativeScheduleViewProps> | null>(() =>
    resolveMemohNativeView<NativeScheduleViewProps>('NativeScheduleView'),
  );
  if (Component) return <Component {...props} />;
  return (
    <View style={props.style} testID="native-schedule-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
