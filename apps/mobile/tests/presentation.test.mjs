/**
 * 出席会话账本的规则。
 *
 * 这些用例钉的是三件"看截图看不出来"的事：
 *
 * 1. **一次出席只能结算一次。** 点按钮之后可能紧接着又被卸载（React 的清理、导航动画、
 *    进程回收），两次都去 `router.dismiss()` 会把**下面那一屏**也关掉——用户看到的是
 *    "批完一个操作，聊天页也没了"。
 * 2. **取消与完成必须分得开。** 调用方靠这个分支决定要不要报错、要不要重试。
 * 3. **账本里没有的 id 不能当作"已经结算"。** 深链/进程重启后进来的
 *    `presented/<id>` 是查不到账本的，那时应当 dismiss，而不是假装结算成功。
 *
 * 账本是纯内存结构，所以这些都能在没有模拟器的地方跑。
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  cancelPresentationSession,
  completePresentationSession,
  getPresentationSession,
  openPresentationSession,
  presentationSessionCount,
  resetPresentationSessions,
} from '../src/lib/presentation/sessions.ts';

/** 造一个够用的"页面定义"：账本只关心 id 与形态。 */
function fakePage(id) {
  return {
    id,
    title: `page-${id}`,
    presentation: { style: 'formSheet', dismissible: true, headerShown: false },
    Component: () => null,
  };
}

/** 打开一个会话并返回 `[id, 结果 promise]`。 */
function open(pageId, params = undefined) {
  let resolve;
  const result = new Promise((settle) => {
    resolve = settle;
  });
  const id = openPresentationSession({
    page: fakePage(pageId),
    params,
    presentation: { style: 'formSheet', dismissible: false, headerShown: false },
    resolve: (value) => resolve(value),
  });
  return [id, result];
}

beforeEach(() => {
  resetPresentationSessions();
});

test('id 从 1 开始、递增，且互不相同', () => {
  const [first] = open('approval');
  const [second] = open('approval');
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(presentationSessionCount(), 2);
});

test('取回的会话只有只读字段：没有 resolve 泄漏出去', () => {
  const [id] = open('approval', { sessionId: 's-1' });
  const session = getPresentationSession(id);
  assert.equal(session.id, id);
  assert.equal(session.page.id, 'approval');
  assert.deepEqual(session.params, { sessionId: 's-1' });
  assert.equal(session.presentation.dismissible, false);
  assert.equal('resolve' in session, false);
});

test('完成：promise 拿到 completed + 结果，且离开账本', async () => {
  const [id, result] = open('sessionInfo');
  assert.equal(completePresentationSession(id, { answered: true }), true);
  assert.deepEqual(await result, { status: 'completed', value: { answered: true } });
  assert.equal(presentationSessionCount(), 0);
  assert.equal(getPresentationSession(id), undefined);
});

test('取消：promise 拿到 cancelled', async () => {
  const [id, result] = open('approval');
  assert.equal(cancelPresentationSession(id), true);
  assert.deepEqual(await result, { status: 'cancelled' });
});

test('第二次结算返回 false——这正是"别把下面那一屏也关掉"的依据', async () => {
  const [id, result] = open('approval');
  assert.equal(completePresentationSession(id, undefined), true);
  // 用户点了"允许"之后又被卸载：第二次结算必须失败，调用方据此不再 dismiss。
  assert.equal(cancelPresentationSession(id), false);
  assert.equal(completePresentationSession(id, undefined), false);
  assert.deepEqual(await result, { status: 'completed', value: undefined });
});

test('账本里没有的 id：结算返回 false，也不影响别的会话', async () => {
  const [id, result] = open('approval');
  assert.equal(cancelPresentationSession(999), false);
  assert.equal(presentationSessionCount(), 1);
  assert.equal(getPresentationSession(999), undefined);
  // 真正的那个还在台上，仍然能被正常结算。
  assert.equal(cancelPresentationSession(id), true);
  assert.deepEqual(await result, { status: 'cancelled' });
});

test('多个会话互不干扰：关掉最上面那个不会结算下面的', async () => {
  const [first, firstResult] = open('sessionInfo');
  const [second, secondResult] = open('approval');
  assert.equal(cancelPresentationSession(second), true);
  assert.deepEqual(await secondResult, { status: 'cancelled' });
  assert.equal(presentationSessionCount(), 1);
  assert.equal(getPresentationSession(first)?.page.id, 'sessionInfo');
  assert.equal(completePresentationSession(first, 'done'), true);
  assert.deepEqual(await firstResult, { status: 'completed', value: 'done' });
});
