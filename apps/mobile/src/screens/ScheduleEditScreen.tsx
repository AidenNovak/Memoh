import { NativeScheduleEditScreen } from './NativeScheduleEditScreen.tsx';

/** Route-owned thin wrapper; the visible Schedule editor is native on iOS. */
export function ScheduleEditScreen({ scheduleId }: { scheduleId: string | null }) {
  return <NativeScheduleEditScreen scheduleId={scheduleId} />;
}
