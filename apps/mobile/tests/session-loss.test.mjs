/**
 * 401 → 清凭据 → 回未登录（`AGENTS.md` 的硬规则）。
 *
 * 这一条原本和实现对不上：`clearSession()` 全仓唯一的调用点是用户**手动**退出，
 * 所以"token 按 exp 还没过期、服务端已经不要它了"（账号被停用/删除）时，请求 401
 * 只换了界面，Keychain 里那份脏凭据留着——下次冷启动按 `exp` 判断又会直接进主界面。
 *
 * 判据（`docs/research/review-engineering-standards.md` A1）：
 *
 * 1. **任意**已鉴权请求 401 都要清凭据并回未登录；
 * 2. 但**只有 401** 才算数：`/auth/refresh` 的网络失败/超时是**可恢复**的（token 可能
 *    还有效），那时不许把用户的凭据丢掉（否则弱网下每启动一次就被登出一次）；
 * 3. 清凭据自己失败也必须回未登录（`finally`），不能卡在中间态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemohClient } from '../src/api/client.ts';
import { createSessionLoss } from '../src/features/auth/sessionLoss.ts';

/** 假的 fetch：按给定状态码回答，记录调用。 */
function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (response.networkError === true) throw new Error('Network request failed');
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body ?? '{}',
      json: async () => JSON.parse(response.body ?? '{}'),
    };
  };
  return calls;
}

/** 一个记事的假凭据层：`clear` 与"回未登录"各记一笔，顺序即判据。 */
function fakePorts(clearFails = false) {
  const events = [];
  /** 每一次"回未登录"带着的起因（登录页要不要念一句原因，就看它）。 */
  const reasons = [];
  return {
    events,
    reasons,
    clear: async () => {
      events.push('clear');
      if (clearFails) throw new Error('keychain unavailable');
    },
    onSignedOut: (reason) => {
      reasons.push(reason);
      events.push('signedOut');
    },
  };
}

function clientFor(ports) {
  const loss = createSessionLoss({ clear: ports.clear, onSignedOut: ports.onSignedOut });
  const client = new MemohClient({
    baseUrl: 'http://x',
    getToken: () => 'stale-but-unexpired',
    onUnauthorized: loss.handle,
  });
  return { client, loss };
}

test('任意已鉴权请求 401：先清凭据，再回未登录', async () => {
  stubFetch({ status: 401, body: '{"message":"account disabled"}' });
  const ports = fakePorts();
  const { client, loss } = clientFor(ports);

  await assert.rejects(() => client.listSessions('bot-1'));

  await loss.settled();
  assert.deepEqual(ports.events, ['clear', 'signedOut'], '清凭据必须发生在回登录页之前');
  assert.equal(loss.hasFired(), true);
});

test('并发 401（多个请求同时被打回）：只清一次、只回一次', async () => {
  stubFetch({ status: 401, body: '{"message":"nope"}' });
  const ports = fakePorts();
  const { client, loss } = clientFor(ports);

  await Promise.allSettled([client.listBots(), client.me(), client.listSessions('bot-1')]);

  await loss.settled();
  assert.deepEqual(ports.events, ['clear', 'signedOut']);
});

test('成功请求不动凭据', async () => {
  stubFetch({ status: 200, body: '{"items":[]}' });
  const ports = fakePorts();
  const { client, loss } = clientFor(ports);

  await client.listBots();
  await loss.settled();

  assert.deepEqual(ports.events, []);
  assert.equal(loss.hasFired(), false);
});

test('续期时被服务端回 401：这就是"凭据没了"，照清不误', async () => {
  stubFetch({ status: 401, body: '{"message":"token rejected"}' });
  const ports = fakePorts();
  const { client, loss } = clientFor(ports);

  await assert.rejects(() => client.refresh());
  await loss.settled();

  assert.deepEqual(ports.events, ['clear', 'signedOut']);
});

test('续期只是网络失败（可恢复）：不许清凭据、不许踢人', async () => {
  stubFetch({ networkError: true });
  const ports = fakePorts();
  const { client, loss } = clientFor(ports);

  await assert.rejects(() => client.refresh());
  await loss.settled();

  assert.deepEqual(ports.events, [], '超时/断网不等于凭据失效（token 可能仍然能用）');
  assert.equal(loss.hasFired(), false);
});

test('清凭据自己失败，也必须回未登录（不能卡在中间态）', async () => {
  stubFetch({ status: 401, body: '{}' });
  const ports = fakePorts(true);
  const { client, loss } = clientFor(ports);

  await assert.rejects(() => client.me());
  await loss.settled();

  assert.deepEqual(ports.events, ['clear', 'signedOut']);
});

/**
 手动退出登录与 401 是**同一个用户的同一个结果**（回到登录页、钥匙串里不再有凭据），
 所以必须走同一个出口。

 以前不是：设置页自己 `clearSession()` + 重置 store，而闸门（`useAuthGate` 的 `phase`）
 不跟着切——退出登录之后人落在**已经卸掉会话的空壳界面**上，而不是登录页；冷启动才会
 发现"其实已经退出了"。规则本来只有一处（先清凭据、再回未登录），跑出两套就必然有一天
 只修好其中一套。
*/
test('手动退出登录：与 401 同一个出口（先清凭据，再回未登录）', async () => {
  const ports = fakePorts();
  const { loss } = clientFor(ports);

  loss.signOut();
  await loss.settled();

  assert.deepEqual(ports.events, ['clear', 'signedOut'], '顺序与 401 那条完全一致');
  assert.deepEqual(ports.reasons, ['manual'], '手动退出不是"被踢"，登录页不该念那句原因');
  assert.equal(loss.hasFired(), true);
});

test('手动退出与并发 401 撞上：只清一次、只回一次', async () => {
  stubFetch({ status: 401, body: '{}' });
  const ports = fakePorts();
  const { client, loss } = clientFor(ports);

  // 用户按下"退出登录"的同一瞬间，另一个请求被服务端回 401。
  loss.signOut();
  await Promise.allSettled([client.listBots()]);
  await loss.settled();

  assert.deepEqual(ports.events, ['clear', 'signedOut']);
  assert.deepEqual(ports.reasons, ['manual']);
});

/**
 退出之后又登录回来的人，必须还会被 401 送回去。

 出口是幂等的（`fired` 只让第一次生效），所以"重新登录"必须把闸门复位——不复位的话
 第二次会话的 401 会被当成"已经处理过"，用户被扣在一个什么都打不开的主界面上。
*/
test('退出后重新登录：闸门复位，之后的 401 仍然能把人送回登录页', async () => {
  stubFetch({ status: 401, body: '{}' });
  const ports = fakePorts();
  const { client, loss } = clientFor(ports);

  loss.signOut();
  await loss.settled();

  loss.reset();
  assert.equal(loss.hasFired(), false, '重新登录之后这一次会话是活的');

  await assert.rejects(() => client.listBots());
  await loss.settled();
  assert.deepEqual(ports.events, ['clear', 'signedOut', 'clear', 'signedOut']);
  assert.deepEqual(ports.reasons, ['manual', 'unauthorized']);
});
