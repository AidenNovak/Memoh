/**
 * 「运行位置」的约束与显示（`src/features/schedule/runTarget.ts`）。
 *
 * 这一项上一轮**故意没做**，理由是"没有会话选择器就会写出缺 target_session_id 的必然被拒
 * 请求"。所以这里的护栏就是那条理由：**说要用已有会话，就必须有会话 id**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkRunTarget,
  selectedSessionLabel,
  sessionLabel,
  switchRunTarget,
} from '../src/features/schedule/runTarget.ts';

test('新会话：不需要 id，直接可用', () => {
  assert.deepEqual(checkRunTarget({ runTarget: 'new_session', targetSessionId: '' }), {
    ok: true,
    problemKey: null,
  });
});

test('要用已有会话但没选：**不合法**，并给一句能让用户动手的话', () => {
  const check = checkRunTarget({ runTarget: 'existing_session', targetSessionId: '' });
  assert.equal(check.ok, false);
  assert.equal(check.problemKey, 'schedule.runTarget.needsSession');
  // 只有空白也算没选（粘贴进来一个空格不该被当成选好了）
  assert.equal(checkRunTarget({ runTarget: 'existing_session', targetSessionId: '   ' }).ok, false);
});

test('要用已有会话且选了：可用', () => {
  assert.deepEqual(checkRunTarget({ runTarget: 'existing_session', targetSessionId: 's-1' }), {
    ok: true,
    problemKey: null,
  });
});

test('切回新会话时清掉残留的 id（否则下次切回复用它悄悄回来）', () => {
  assert.deepEqual(
    switchRunTarget({ runTarget: 'existing_session', targetSessionId: 's-1' }, 'new_session'),
    {
      runTarget: 'new_session',
      targetSessionId: '',
    },
  );
});

test('切到已有会话时保留已选的（用户来回切一次不该丢选择）', () => {
  assert.deepEqual(
    switchRunTarget({ runTarget: 'new_session', targetSessionId: 's-1' }, 'existing_session'),
    {
      runTarget: 'existing_session',
      targetSessionId: 's-1',
    },
  );
});

test('会话标题为空时给 id 前 8 位，不编"未命名会话"', () => {
  assert.equal(sessionLabel({ id: 'abcdef1234567890', title: '周报' }), '周报');
  assert.equal(sessionLabel({ id: 'abcdef1234567890', title: '' }), 'abcdef12');
  assert.equal(sessionLabel({ id: 'abcdef1234567890', title: '   ' }), 'abcdef12');
});

test('选中的会话不在已加载的那一页里：也显示得出（给 id），不显示成"没选"', () => {
  assert.equal(selectedSessionLabel('abcdef1234567890', []), 'abcdef12');
  assert.equal(selectedSessionLabel('s-1', [{ id: 's-1', title: '周报' }]), '周报');
  assert.equal(selectedSessionLabel('', []), '');
});
