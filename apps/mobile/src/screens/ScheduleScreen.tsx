import { NativeScheduleScreen } from './NativeScheduleScreen.tsx';

/** Route-owned thin wrapper; the visible Schedule list is native on iOS. */
export function ScheduleScreen() {
  return <NativeScheduleScreen />;
}
