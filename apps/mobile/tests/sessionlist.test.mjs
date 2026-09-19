/**
 * 会话列表的写入规则。
 *
 * ## 这些用例存在的理由
 *
 * 重复 key 那条警告**用户是看得见的**（LogBox 横幅压在输入框上），而它的成因不是
 * "某个 map 写错了"，是一段**先查再写的异步流程**在开发构建里被调用了两次。
 * 纯逻辑层能钉住的是那条不变量：
 *
 *   > 同一份状态经过任意次写入，同一个会话 id 只出现一次。
 *
 * 复现路径与证据见 `docs/onboarding.md`（同目录的会话列表一节）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prependSession, uniqueSessions } from '../src/features/session/sessionList.ts';

/** 只关心 id 的会话摘要工厂。 */
function session(id) {
  return { id, title: `t-${id}`, updatedAt: '2026-09-14T14:00:00Z', source: 'chat' };
}

test('uniqueSessions：同一个 id 只留第一次出现的那条（列表是"最新的在前"）', () => {
  const older = { ...session('a'), title: '旧标题' };
  const newer = { ...session('a'), title: '新标题' };
  const list = [newer, session('b'), older];

  const result = uniqueSessions(list);

  assert.deepEqual(
    result.map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.equal(result[0].title, '新标题', '保留靠前的那条，它才是更新的');
});

test('uniqueSessions：没有重复时保持原顺序、不复制数组内容', () => {
  const list = [session('a'), session('b'), session('c')];
  assert.deepEqual(uniqueSessions(list), list);
  assert.deepEqual(uniqueSessions([]), []);
});

test('prependSession：列表里已经有这个会话就不写第二份', () => {
  // 这就是线上那条重复 key 的正解：`ensureSessionInList` 在 await 之后重新判断。
  // 开发构建里那次"同一依赖跑两次"的 effect，第一次已经把会话写进去了，
  // 第二次必须变成 no-op——而不是又 prepend 一份。
  const list = [session('a'), session('b')];
  const again = prependSession(list, session('a'));

  assert.equal(again, list, '已存在时必须返回原数组（调用方靠引用判断"什么都没发生"）');
  assert.equal(again.length, 2);
});

test('prependSession：新会话放到头部，且不改变其余顺序', () => {
  const list = [session('a'), session('b')];
  const result = prependSession(list, session('c'));

  assert.deepEqual(
    result.map((entry) => entry.id),
    ['c', 'a', 'b'],
  );
});

test('并发补标题：两次写入叠加后仍然只有一个该会话（复现场景）', () => {
  // 两次 `ensureSessionInList` 都读到"列表里还没有"（50 条），各自 await 取标题——
  // 这正是实测里那两次调用。第一次写成功之后，第二次不能再写。
  const base = Array.from({ length: 50 }, (_, index) => session(`s${index}`));
  const fresh = session('new');

  const afterFirst = prependSession(base, fresh);
  // 第二次调用读到的"当前列表"已经是第一次写完的那份。
  const afterSecond = prependSession(afterFirst, fresh);

  assert.equal(afterSecond.length, 51, '51 条（原来 50 + 新增 1），不是 52');
  assert.equal(afterSecond.filter((entry) => entry.id === 'new').length, 1);
  // 去重入口再兜一层：即使某天有人绕过 prependSession，UI 也不会看到两份。
  assert.equal(uniqueSessions([fresh, ...afterSecond]).length, 51);
});
