/**
 * 会话列表的游标分页（A2）：不能悄悄少了 50 条之后的内容。
 *
 * 服务端 `next_cursor` 的语义是**明确**的（`internal/handlers/session.go`）：空串当且仅当
 * 没有下一页，"clients should stop paging on an empty cursor and never expect a follow-up
 * empty page"。所以这里钉三件事：游标怎么读、两页怎么并、尾部该说什么。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SESSION_PAGE_LIMIT,
  appendSessionPage,
  cursorFromResponse,
  sessionsFooter,
} from '../src/features/session/paging.ts';

function summary(id, updatedAt = '2026-09-01T00:00:00Z') {
  return { id, title: id, updatedAt, source: '', type: 'chat' };
}

test('空 next_cursor = 到底了（不是"再请求一次空页"）', () => {
  assert.equal(cursorFromResponse(''), null);
  assert.equal(cursorFromResponse('   '), null);
  assert.equal(cursorFromResponse(undefined), null);
  assert.equal(cursorFromResponse('eyJ1IjoiMjAyNi0wOS0wMSJ9'), 'eyJ1IjoiMjAyNi0wOS0wMSJ9');
});

test('把新一页接在后面：顺序不变、重叠的一条不出现两次', () => {
  const first = [summary('a'), summary('b')];
  const second = [summary('b'), summary('c')];

  assert.deepEqual(
    appendSessionPage(first, second).map((item) => item.id),
    ['a', 'b', 'c'],
  );
});

test('接页不能改动原数组（状态是不可变的）', () => {
  const first = [summary('a')];
  appendSessionPage(first, [summary('b')]);
  assert.deepEqual(
    first.map((item) => item.id),
    ['a'],
  );
});

test('尾部：还有更早的就说出来，到 50 条以内的账号一个字都不多', () => {
  assert.equal(sessionsFooter({ cursor: 'cur-2', loading: false, error: null }), 'more');
  assert.equal(sessionsFooter({ cursor: 'cur-2', loading: true, error: null }), 'loading');
  assert.equal(sessionsFooter({ cursor: null, loading: false, error: null }), 'none');
});

test('尾部：拉失败了要说话（静默失败会被读成"没有更早的会话"）', () => {
  assert.equal(
    sessionsFooter({ cursor: 'cur-2', loading: false, error: 'error.network' }),
    'error',
  );
});

test('一页 50 条：和服务端默认值对齐（别偷偷改小）', () => {
  assert.equal(SESSION_PAGE_LIMIT, 50);
});
