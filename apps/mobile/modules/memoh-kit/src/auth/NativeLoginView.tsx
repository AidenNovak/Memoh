import React, { useState } from 'react';
import { Text, View, type ViewProps } from 'react-native';

import { resolveMemohNativeView } from '../nativeView';

export interface NativeLoginViewModel {
  cloud: {
    title: string;
    subtitle: string;
    github: string;
    google: string;
    divider: string;
    emailPlaceholder: string;
    emailContinue: string;
    emailInvalid: string;
    unavailable: string;
  };
  selfHosted: {
    title: string;
    subtitle: string;
    section: string;
    enter: string;
    back: string;
    done: string;
    server: string;
    serverChange: string;
    serverPlaceholder: string;
    serverHint: string;
    username: string;
    password: string;
    submit: string;
    submitting: string;
  };
  errors: {
    serverEmpty: string;
    serverInvalid: string;
    usernameRequired: string;
    passwordRequired: string;
    notMemoh: string;
    invalidCredentials: string;
    unreachable: string;
    failed: string;
  };
  /** Localized one-shot session-loss message; empty for a normal signed-out launch. */
  notice: string;
}

export interface NativeLoginViewProps extends ViewProps {
  mode: string;
  viewModelJson: string;
  onSignedIn?: (event: { nativeEvent: { sessionJson?: string } }) => void;
  unavailableLabel?: string;
}

export function NativeLoginView({
  unavailableLabel = 'Native login unavailable. Rebuild the iOS app.',
  ...props
}: NativeLoginViewProps) {
  const [Component] = useState(() =>
    resolveMemohNativeView<NativeLoginViewProps>('NativeLoginView'),
  );
  if (Component) return <Component {...props} />;

  return (
    <View style={props.style} testID="native-login-unavailable">
      <Text accessibilityRole="alert">{unavailableLabel}</Text>
    </View>
  );
}
