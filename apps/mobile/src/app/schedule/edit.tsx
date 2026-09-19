/**
 * 定时任务编辑页的路由。
 *
 * 挂在**根栈**而不是 `(tabs)` 里：编辑是"从列表推进去的下一页"，它要盖住底部 tab 栏
 * （设计稿里定时编辑没有 tab 栏）。`scheduleId` 缺失 = 新建。
 */
import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ScheduleEditScreen } from '../../screens/ScheduleEditScreen.tsx';

export default function ScheduleEditRoute() {
  const params = useLocalSearchParams<{ scheduleId?: string }>();
  const scheduleId =
    typeof params.scheduleId === 'string' && params.scheduleId !== '' ? params.scheduleId : null;
  return <ScheduleEditScreen scheduleId={scheduleId} />;
}
