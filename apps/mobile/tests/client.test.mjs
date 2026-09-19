/**
 * REST 客户端测试。
 *
 * 重点是**请求怎么被构造出来的**，而不是服务端返回什么。起因是一个真实故障：
 * `updateSettings` 把 body 直接当成 options 传给了内部的 `send()`，于是请求体
 * 是 `{}`，服务端返回 200 但什么都没改。这个 bug 最难查的地方在于——它看起来
 * 完全成功，只是"设置没生效"。
 *
 * 用假的 fetch 断言实际发出的请求，不依赖网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, MemohClient } from '../src/api/client.ts';

/** 装一个假的 fetch，记录调用，返回一个可控的响应。 */
function stubFetch(response = { status: 200, body: '{}' }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : String(init.body),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
      json: async () => JSON.parse(response.body),
    };
  };
  return calls;
}

test('updateSettings 把 body 放进请求体，而不是当成 options', async () => {
  // 这条断言来自真实故障：body 被当成 options，请求体变成 undefined，
  // 服务端 200 但设置没生效——最难查的一类 bug。
  const calls = stubFetch({ status: 200, body: '{"ok":true}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.updateSettings('bot-1', { tool_approval_config: { enabled: true } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'http://x/bots/bot-1/settings');
  assert.notEqual(calls[0].body, undefined, '请求体不能是 undefined');
  assert.deepEqual(JSON.parse(calls[0].body), { tool_approval_config: { enabled: true } });
});

test('带 body 的请求自动加上 Content-Type', async () => {
  const calls = stubFetch();
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.updateSettings('bot-1', { a: 1 });

  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

test('不带 body 的 GET 不会带上 Content-Type', async () => {
  const calls = stubFetch({ status: 200, body: '{"items":[]}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.listBots();

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers['Content-Type'], undefined);
});

test('认证请求带上 Authorization，登录请求不带', async () => {
  const calls = stubFetch({
    status: 200,
    body: '{"access_token":"t","token_type":"Bearer","expires_at":"x"}',
  });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.login('u', 'p');
  assert.equal(calls[0].headers.Authorization, undefined, '登录是公开入口，不该带 token');

  await client.listBots();
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');
});

test('baseUrl 末尾斜杠被规范化，不会拼出双斜杠', async () => {
  const calls = stubFetch({ status: 200, body: '{"items":[]}' });
  const client = new MemohClient({ baseUrl: 'http://x///', getToken: () => 'tok' });

  await client.listBots();

  assert.equal(calls[0].url, 'http://x/bots');
});

test('query 参数被拼上；空值与 undefined 被跳过', async () => {
  const calls = stubFetch({ status: 200, body: '{"items":[],"next_cursor":""}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.listSessions('bot-1', { limit: 20, cursor: '' });

  assert.match(calls[0].url, /limit=20/);
  assert.doesNotMatch(calls[0].url, /cursor=/, '空字符串不该出现在 query 里');
});

test('401 触发 onUnauthorized（上层据此清 Keychain 回登录页）', async () => {
  stubFetch({ status: 401, body: '{"message":"expired"}' });
  let called = false;
  const client = new MemohClient({
    baseUrl: 'http://x',
    getToken: () => 'tok',
    onUnauthorized: () => {
      called = true;
    },
  });

  await assert.rejects(
    () => client.listBots(),
    (error) => error instanceof ApiError && error.isUnauthorized,
  );
  assert.equal(called, true);
});

test('登录失败不触发 onUnauthorized（那时本来就没凭据）', async () => {
  stubFetch({ status: 401, body: '{"message":"invalid credentials"}' });
  let called = false;
  const client = new MemohClient({
    baseUrl: 'http://x',
    getToken: () => null,
    onUnauthorized: () => {
      called = true;
    },
  });

  await assert.rejects(() => client.login('u', 'bad'));
  assert.equal(called, false);
});

test('网络层异常被归一成 status 0 的 ApiError', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await assert.rejects(
    () => client.listBots(),
    (error) => error instanceof ApiError && error.status === 0 && error.isNetwork === true,
  );
});

test('错误响应里的 message 被提取成可读文案', async () => {
  stubFetch({ status: 400, body: '{"message":"invalid message version tag"}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await assert.rejects(
    () => client.listBots(),
    (error) => error.message === 'invalid message version tag',
  );
});

test('非 JSON 错误体（例如网关 HTML）不会让错误处理再崩一次', async () => {
  stubFetch({ status: 502, body: '<html>Bad Gateway</html>' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await assert.rejects(
    () => client.listBots(),
    (error) => error instanceof ApiError && error.status === 502,
  );
});

test('204 返回 undefined 而不是试图解析空体', async () => {
  stubFetch({ status: 204, body: '' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  const result = await client.deleteSession('bot-1', 's-1');

  assert.equal(result, undefined);
});

test('listModels 能同时吃下 {items:[]} 与裸数组两种形状', async () => {
  // 上游两种返回形状都出现过，调用方不该为此写两套分支。
  stubFetch({
    status: 200,
    body: '{"items":[{"id":"m1","model_id":"k3","name":"K3","provider_id":"p1"}]}',
  });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  const wrapped = await client.listModels();
  const wrappedItems = Array.isArray(wrapped) ? wrapped : (wrapped.items ?? []);
  assert.equal(wrappedItems.length, 1);
  assert.equal(wrappedItems[0].model_id, 'k3');
});

test('入队 follow-up：路径、方法、幂等 id 与正文都对', async () => {
  // 幂等 id 写错的代价：服务端把重试当成新的一条，agent 后面连着答两遍同一句话。
  const calls = stubFetch({ status: 200, body: '{"item_id":"i1"}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.enqueueFollowUp('bot-1', 'sess-1', '补一句', 'inv-9');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://x/bots/bot-1/sessions/sess-1/follow-up-queue');
  assert.deepEqual(JSON.parse(calls[0].body), { invocation_id: 'inv-9', text: '补一句' });
});

test('入队 steer：打到 steer-queue，不是 follow-up-queue', async () => {
  // 这两条队列打错端点会很隐蔽：一样是 200，只是排进了另一条队列（多等一轮）。
  const calls = stubFetch({ status: 200, body: '{}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.enqueueSteer('bot-1', 'sess-1', '现在就告诉它', 'inv-1');

  assert.equal(calls[0].url, 'http://x/bots/bot-1/sessions/sess-1/steer-queue');
  assert.deepEqual(JSON.parse(calls[0].body), { invocation_id: 'inv-1', text: '现在就告诉它' });
});

test('读队列：两条队列一起拿，形状归一成 camelCase', async () => {
  const calls = stubFetch({
    status: 200,
    body: JSON.stringify({
      follow_up: [{ item_id: 'f1', text: '后面再跑', position: 2, status: 'accepted' }],
      steer: [{ item_id: 's1', text: '插一句', position: 1, status: 'claimed' }],
      steer_supported: true,
    }),
  });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  const queue = await client.getSessionQueue('bot-1', 'sess-1');

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://x/bots/bot-1/sessions/sess-1/queue');
  assert.equal(queue.steerSupported, true);
  assert.deepEqual(queue.followUp, [
    { itemId: 'f1', text: '后面再跑', position: 2, status: 'accepted', kind: 'follow-up' },
  ]);
  assert.deepEqual(queue.steer, [
    { itemId: 's1', text: '插一句', position: 1, status: 'claimed', kind: 'steer' },
  ]);
});

test('读队列：服务端没给 steer_supported 时不猜成 true', async () => {
  // 服务端没声明支持插话时给入口，用户点了必然失败——宁可不给。
  stubFetch({ status: 200, body: '{"follow_up":[]}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  const queue = await client.getSessionQueue('bot-1', 'sess-1');

  assert.equal(queue.steerSupported, false);
});

test('删队列项：按 kind 选对端点，item_id 要转义', async () => {
  const calls = stubFetch({ status: 204, body: '' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.deleteQueueItem('bot-1', 'sess-1', 'follow-up', 'item/1');
  await client.deleteQueueItem('bot-1', 'sess-1', 'steer', 'item 2');

  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'http://x/bots/bot-1/sessions/sess-1/follow-up-queue/item%2F1');
  assert.equal(calls[1].url, 'http://x/bots/bot-1/sessions/sess-1/steer-queue/item%202');
});

test('提成 steer：打 follow-up-queue/<id>/steer', async () => {
  const calls = stubFetch({ status: 200, body: '{}' });
  const client = new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok' });

  await client.promoteQueueItem('bot-1', 'sess-1', 'f1');

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://x/bots/bot-1/sessions/sess-1/follow-up-queue/f1/steer');
});
