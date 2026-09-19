/**
 * 翻页的**往返**验证：真的把 `cursor` / `before_message_id` 发出去，并把两页合起来看。
 *
 * 为什么除了纯函数测试还要这一层：纯函数证明"合并对了"，但证明不了**请求参数真的发了**
 * ——`listSessions` 的 `cursor` 与 `listMessages` 的 `beforeMessageId` 此前**全仓没有调用点**
 * （评审 A2 的原话），一条写错参数名的路走到真机上只会得到"永远第一页"。
 *
 * 这个固定服务端照服务端 Go 源码的语义写（`internal/handlers/session.go` 的
 * `encodeSessionCursor` / `listSessionsResponse`，`internal/chat/message/service.go` 的
 * `ListBeforeMessageBySession` 与 `internal/handlers/message.go` 的 `extendToUITurnHead`）：
 *
 * - 会话列表：keyset 游标，`next_cursor` 为空串**当且仅当**没有下一页；
 * - 历史：`before_message_id` 返回**严格早于**那条消息的行，且**把页首延伸到轮次边界**
 *   ——所以边界那一轮会与上一页重叠，合并必须按 `turn_id` 去重（`docs/research/memoh-api.md`
 *   §3.3 的坑）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { MemohClient } from '../src/api/client.ts';
import { HISTORY_PAGE_LIMIT } from '../src/features/chat/historyPage.ts';
import {
  applyHistory,
  initialChatState,
  prependHistory,
  turnsForDisplay,
} from '../src/features/chat/reducer.ts';
import {
  SESSION_PAGE_LIMIT,
  appendSessionPage,
  cursorFromResponse,
} from '../src/features/session/paging.ts';

const BOT = 'bot-1';

/** 51 个会话（第 51 个只有再翻一页才拿得到）+ 101 轮历史。 */
function fixture() {
  const sessions = Array.from({ length: 51 }, (_, index) => ({
    id: `session-${String(index + 1).padStart(2, '0')}`,
    // 越靠前越新（服务端按 updated_at desc 分页）。
    updated_at: `2026-09-${String(30 - index).padStart(2, '0')}T00:00:00Z`,
    title: `session ${index + 1}`,
  }));

  // 101 轮，每轮两行（用户一行、助手一行）。轮次 id 记录在行的 turn 上。
  const rows = [];
  for (let index = 1; index <= 101; index += 1) {
    rows.push({ id: `m${index}-user`, turn: index });
    rows.push({ id: `m${index}-assistant`, turn: index });
  }
  return { sessions, rows };
}

/**
 * 服务端返回的是 `UITurn[]`：每一轮拆成 user / assistant 两条，`id` 是这一轮**第一条**
 * 消息的行 id（`chatview.ConvertMessagesToUITurns` 就是这么填的）——那正是下一页的游标。
 */
function turnItems(page) {
  const turns = [...new Set(page.map((row) => row.turn))];
  const items = [];
  for (const turn of turns) {
    const first = page.find((row) => row.turn === turn);
    items.push({
      turn_id: `t${turn}`,
      turn_position: turn,
      role: 'user',
      text: `第 ${turn} 轮`,
      id: first.id,
    });
    items.push({
      turn_id: `t${turn}`,
      turn_position: turn,
      role: 'assistant',
      messages: [{ id: turn, type: 'text', content: `第 ${turn} 轮的回复` }],
      id: first.id,
    });
  }
  return items;
}

async function withServer(run) {
  const data = fixture();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === `/bots/${BOT}/sessions`) {
      const limit = Number(url.searchParams.get('limit') ?? `${SESSION_PAGE_LIMIT}`);
      const cursor = url.searchParams.get('cursor');
      const start = cursor === null ? 0 : data.sessions.findIndex((item) => item.id === cursor) + 1;
      const page = data.sessions.slice(start, start + limit);
      const hasMore = start + limit < data.sessions.length;
      // 空串 = 到底（服务端契约）。
      json({ items: page, next_cursor: hasMore ? page[page.length - 1].id : '' });
      return;
    }

    if (url.pathname === `/bots/${BOT}/messages`) {
      const limit = Number(url.searchParams.get('limit') ?? '30');
      const before = url.searchParams.get('before_message_id');
      let candidates = data.rows;
      if (before !== null) {
        const index = data.rows.findIndex((row) => row.id === before);
        candidates = index < 0 ? [] : data.rows.slice(0, index);
      }
      let page = candidates.slice(Math.max(0, candidates.length - limit));
      // `extendToUITurnHead`：页首向前延伸到轮次边界（这里的最多两行）。
      if (page.length > 0) {
        const head = page[0].turn;
        const extra = data.rows.filter((row) => row.turn === head && !page.includes(row));
        page = [...extra, ...page];
      }
      json({ items: turnItems(page) });
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"message":"not found"}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(new MemohClient({ baseUrl: `http://127.0.0.1:${port}`, getToken: () => 'tok' }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('会话列表：两页接起来能拿到第 51 个（游标真的发出去了）', async () => {
  await withServer(async (client) => {
    const first = await client.listSessions(BOT, { limit: SESSION_PAGE_LIMIT });
    assert.equal(first.items.length, 50);

    let sessions = first.items.map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updated_at,
      source: '',
      type: 'chat',
    }));
    let cursor = cursorFromResponse(first.next_cursor);
    assert.notEqual(cursor, null, '还有下一页时必须给游标');

    const second = await client.listSessions(BOT, { limit: SESSION_PAGE_LIMIT, cursor });
    sessions = appendSessionPage(
      sessions,
      second.items.map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updated_at,
        source: '',
        type: 'chat',
      })),
    );
    cursor = cursorFromResponse(second.next_cursor);

    assert.equal(sessions.length, 51, '第 51 个会话必须拿得到（以前它在界面上直接消失）');
    assert.equal(new Set(sessions.map((item) => item.id)).size, 51, '不许重复');
    assert.equal(cursor, null, '拿到最后一个之后就是到底');
  });
});

test('历史：往前翻能取到第 1 轮，且不重复不丢（按 turn_id 去重）', async () => {
  await withServer(async (client) => {
    const first = await client.listMessages(BOT, 'session-01', { limit: HISTORY_PAGE_LIMIT });
    let state = applyHistory(initialChatState, first.items);

    /**
     ⚠️ 服务端**没有 `has_more`**（`docs/research/memoh-api.md` §3.3）：到底的唯一判据是
     "返回空页"。所以最后那一次空页请求是**协议要求**的，不是 bug——它换来的是
     `olderExhausted`，之后再也不请求。
     */
    let requests = 1;
    let emptyPage = false;
    let previousOldest = Number.POSITIVE_INFINITY;
    while (state.olderCursor !== null && requests < 10) {
      const cursor = state.olderCursor;
      const page = await client.listMessages(BOT, 'session-01', {
        limit: HISTORY_PAGE_LIMIT,
        beforeMessageId: cursor,
      });
      requests += 1;
      if (page.items.length === 0) {
        emptyPage = true;
        state = prependHistory(state, page.items);
        break;
      }
      const oldest = Math.min(...page.items.map((turn) => turn.turn_position));
      assert.ok(oldest < previousOldest, `游标必须真的往前挪（这次最老 ${oldest}）`);
      previousOldest = oldest;
      state = prependHistory(state, page.items);
    }
    assert.equal(emptyPage, true, '空页是"到底"的唯一信号，必须出现过一次');
    assert.ok(requests <= 4, `请求数要收敛（实际 ${requests}）`);

    const keys = turnsForDisplay(state).map((turn) => turn.key);
    assert.equal(new Set(keys).size, keys.length, '不许有重复轮次（页首延伸会造成重叠）');
    assert.equal(keys.length, 101, '101 轮必须一轮不落');
    assert.equal(keys[0], 't1', '第 1 轮真的能翻到');
    assert.deepEqual(
      keys.slice(0, 3),
      ['t1', 't2', 't3'],
      '顺序按 turn_position（不能因为分页把顺序搞乱）',
    );
    assert.equal(state.olderExhausted, true, '翻到底之后不再请求');
  });
});
