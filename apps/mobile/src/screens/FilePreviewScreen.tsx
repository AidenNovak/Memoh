import React from 'react';

import { NativeFilePreviewScreen } from './NativeFilePreviewScreen.tsx';

/** Thin route-owned bridge; the visible file preview is native on iOS. */
export function FilePreviewScreen({ path }: { path: string }) {
  return <NativeFilePreviewScreen path={path} />;
}
