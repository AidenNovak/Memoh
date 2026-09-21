/**
 * Native login page bridge.
 *
 * SwiftUI owns every visible control, validation, Memoh discovery, login request, and Keychain
 * write. RN supplies localized copy/theme and creates the existing application client after native
 * authentication succeeds. Passwords and email placeholder input never cross this bridge.
 */
import { NativeLoginView, type NativeLoginViewModel } from '@memoh-ios/kit';
import React, { useCallback } from 'react';

import { MemohClient } from '../api/client.ts';
import { adoptNativeSession, getFreshToken } from '../api/credentials.ts';
import type { SessionSeed } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

export function LoginScreen({
  onSignedIn,
  noticeKey,
}: {
  onSignedIn: (seed: SessionSeed) => void;
  noticeKey?: string;
}) {
  const t = useT();
  const { mode } = useTheme();

  const handleSignedIn = useCallback(
    (event: { nativeEvent: { sessionJson?: string } }) => {
      const session = adoptNativeSession(event.nativeEvent.sessionJson);
      if (session === null) return;
      const client = new MemohClient({
        baseUrl: session.baseUrl,
        getToken: () => getFreshToken(),
      });
      onSignedIn({ client });
    },
    [onSignedIn],
  );

  const viewModel: NativeLoginViewModel = {
    cloud: {
      title: t('login.title'),
      subtitle: t('login.subtitle'),
      github: t('login.cloud.github'),
      google: t('login.cloud.google'),
      divider: t('login.cloud.divider'),
      emailPlaceholder: t('login.cloud.email.placeholder'),
      emailContinue: t('login.cloud.email.continue'),
      emailInvalid: t('login.cloud.email.invalid'),
      unavailable: t('login.cloud.unavailable'),
    },
    selfHosted: {
      title: t('login.selfhosted.title'),
      subtitle: t('login.selfhosted.subtitle'),
      section: t('login.selfhosted.section'),
      enter: t('login.selfhosted.enter'),
      back: t('common.back'),
      done: t('common.done'),
      server: t('login.server'),
      serverChange: t('login.server.change'),
      serverPlaceholder: t('login.server.placeholder'),
      serverHint: t('login.server.hint'),
      username: t('login.username'),
      password: t('login.password'),
      submit: t('login.submit'),
      submitting: t('login.submitting'),
    },
    errors: {
      serverEmpty: t('login.server.empty'),
      serverInvalid: t('login.server.invalid'),
      usernameRequired: t('login.username.required'),
      passwordRequired: t('login.password.required'),
      notMemoh: t('login.server.notMemoh'),
      invalidCredentials: t('login.invalidCredentials'),
      unreachable: t('login.unreachable'),
      failed: t('login.failed'),
    },
    notice: noticeKey === undefined ? '' : t(noticeKey),
  };

  return (
    <NativeLoginView
      style={{ flex: 1 }}
      mode={mode}
      viewModelJson={JSON.stringify(viewModel)}
      onSignedIn={handleSignedIn}
      unavailableLabel={t('error.unexpected')}
    />
  );
}
