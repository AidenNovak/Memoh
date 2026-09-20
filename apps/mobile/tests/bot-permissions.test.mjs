/**
 * bot 配置面的权限门控（`features/bots/permissions.ts`）。
 *
 * 这条判据的每一个分岔都有真实后果，所以逐条钉死：
 *
 * - **空数组 / 缺字段 = 可管理**：老服务端与自托管单用户部署不发
 *   `current_user_permissions`，把它读成"只读"会把 bot 的主人挡在自己的设置外面。
 * - **非空但不含 `manage` = 只读**：共享 bot 给别人的是"能聊"，不是"能改"。
 * - **别拿 `workspace_exec` 凑数**：那是"能不能开实时通道"，与"能不能改配置"无关；
 *   猜宽了会给人一个按下去必然 403 的入口。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canManageBot } from '../src/features/bots/permissions.ts';
import { hubViewsFor, visibleHubView } from '../src/features/bots/surfaces.ts';

test('没有 bot（还没选/还没拉到）不认为可管理', () => {
  assert.equal(canManageBot(null), false);
  assert.equal(canManageBot(undefined), false);
});

test('权限字段缺失 = 可管理（老服务端与自托管单用户不发这个字段）', () => {
  assert.equal(canManageBot({}), true);
});

test('空数组 = 可管理（服务端没有表达"只读"）', () => {
  assert.equal(canManageBot({ current_user_permissions: [] }), true);
});

test('有 manage = 可管理', () => {
  assert.equal(canManageBot({ current_user_permissions: ['manage'] }), true);
  assert.equal(canManageBot({ current_user_permissions: ['chat', 'manage'] }), true);
});

test('有权限但不含 manage = 只读', () => {
  assert.equal(canManageBot({ current_user_permissions: ['chat'] }), false);
  assert.equal(canManageBot({ current_user_permissions: ['chat', 'workspace_read'] }), false);
});

test('workspace_exec 不等于能改配置（那是实时通道的门槛）', () => {
  assert.equal(canManageBot({ current_user_permissions: ['workspace_exec'] }), false);
});

test('字段存在但不是数组（服务端给了个 null）按"没表达"处理', () => {
  assert.equal(canManageBot({ current_user_permissions: undefined }), true);
});

test('会话 tab 只显示服务端权限真正允许的视图', () => {
  assert.deepEqual(hubViewsFor(null), ['sessions']);
  assert.deepEqual(hubViewsFor({ current_user_permissions: ['chat'] }), ['sessions']);
  assert.deepEqual(hubViewsFor({ current_user_permissions: ['chat', 'workspace_read'] }), [
    'sessions',
    'files',
  ]);
  assert.deepEqual(
    hubViewsFor({
      current_user_permissions: ['chat', 'workspace_read', 'workspace_exec', 'manage'],
    }),
    ['sessions', 'files', 'schedule'],
  );
});

test('受限深链在权限未知或不允许时绝不挂载受限子页', () => {
  assert.equal(visibleHubView(null, 'schedule'), 'sessions');
  assert.equal(visibleHubView({ current_user_permissions: ['chat'] }, 'schedule'), 'sessions');
  assert.equal(
    visibleHubView({ current_user_permissions: ['chat', 'manage'] }, 'schedule'),
    'schedule',
  );
});
