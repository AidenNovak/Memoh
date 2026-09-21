import React from 'react';

import { NativeFilesScreen } from './NativeFilesScreen.tsx';

/** Thin route-owned bridge; the visible Files surface is native on iOS. */
export function FilesScreen({ path }: { path: string }) {
  return <NativeFilesScreen path={path} />;
}
