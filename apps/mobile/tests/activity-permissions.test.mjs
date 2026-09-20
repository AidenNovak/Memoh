/** 首页活动聚合不应为注定被 403 的 bot 建立 WebSocket。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activityBotKey,
  realtimeActivityBots,
} from '../src/features/activity/useSessionActivity.ts';

function bot(id, permissions) {
  return { id, name: id, current_user_permissions: permissions };
}

test('活动聚合只保留 workspace_exec / manage bot', () => {
  const bots = [
    bot('chat-only', ['chat']),
    bot('reader', ['chat', 'workspace_read']),
    bot('runtime', ['chat', 'workspace_exec']),
    bot('manager', ['chat', 'manage']),
  ];
  assert.deepEqual(
    realtimeActivityBots(bots).map((item) => item.id),
    ['runtime', 'manager'],
  );
});

test('权限变化会改变订阅 key，触发旧连接释放', () => {
  const before = activityBotKey([bot('b1', ['chat', 'workspace_exec'])]);
  const after = activityBotKey([bot('b1', ['chat'])]);
  assert.notEqual(before, after);
});

test('权限顺序与 chat-only bot 的名字不会让可用连接全量重建', () => {
  const before = activityBotKey([
    { ...bot('runtime', ['chat', 'workspace_exec']), display_name: 'Runtime' },
    bot('chat-only', ['chat']),
  ]);
  const after = activityBotKey([
    { ...bot('runtime', ['workspace_exec', 'chat']), display_name: 'Runtime' },
    { ...bot('chat-only', ['chat']), name: 'renamed' },
  ]);
  assert.equal(before, after);
});
