/**
 * 模型目录取数的**失败路径**（`features/chat/models.ts` 的 `loadCatalog`）。
 *
 * ## 这一处为什么值得钉
 *
 * composer 上那颗"现在用的是哪个模型"的胶囊靠这个目录拿名字。而它是**进程内缓存**的：
 * 失败的 promise 一旦留在缓存里，一次网络抖动就会让这颗胶囊**整个 App 生命周期**都
 * 显示不出模型名——没有任何提示、只能杀进程重来。反过来，把"拉不到"静默当成"这台
 * 服务器没有模型"，斜杠菜单和选择器就会显示成空，用户以为模型被删了。
 *
 * 两者都是"不崩、但一直在说谎"的类型，所以这里逐条钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadCatalog, resetCatalogCache } from '../src/features/chat/models.ts';

const MODELS = [
  {
    id: 'uuid-1',
    model_id: 'k3',
    name: 'Kimi K3',
    provider_id: 'p-kimi',
    type: 'chat',
    enable: true,
    reasoning: { supported: true, can_disable: false, efforts: ['low'], default_effort: 'low' },
  },
];

/** 一个可以按需失败的假 client。每次调用都会记数。 */
function fakeClient({ models, modelsError, providers = [], providersError } = {}) {
  const calls = { models: 0, providers: 0 };
  return {
    calls,
    listModels: async () => {
      calls.models += 1;
      if (modelsError !== undefined) throw modelsError;
      return { items: models ?? MODELS };
    },
    listProviders: async () => {
      calls.providers += 1;
      if (providersError !== undefined) throw providersError;
      return { providers };
    },
  };
}

test('目录拉不到必须 reject："拉不到"和"这台服务器没有模型"不是一件事', async () => {
  // resolve 成空目录的后果：选择器是空的、胶囊没有名字，而屏幕上没有任何一行说
  // "这次没拉到"。用户会以为模型被删了。
  resetCatalogCache();
  const boom = new Error('fetch failed');
  const client = fakeClient({ modelsError: boom });

  await assert.rejects(
    () => loadCatalog(client),
    (error) => {
      assert.equal(error, boom, '失败要原样带出去：上层靠它（presentError）决定说什么、给不给重试');
      return true;
    },
    '拿不到目录就是失败，不许成功返回一个空目录',
  );
});

test('失败的 promise 不许留在缓存里：下一次调用要真的再试一次', async () => {
  // 留在缓存里的代价是"一次抖动 = 这颗胶囊整个 App 生命周期都没有名字"。
  resetCatalogCache();
  let failing = true;
  let attempts = 0;
  const client = {
    listModels: async () => {
      attempts += 1;
      if (failing) throw new Error('first attempt fails');
      return { items: MODELS };
    },
    listProviders: async () => ({ providers: [] }),
  };

  await assert.rejects(() => loadCatalog(client), /first attempt fails/, '第一次必须失败');

  failing = false;
  const sections = await loadCatalog(client);

  assert.equal(attempts, 2, '第二次要真的再拉一次（而不是复用那条失败的 promise）');
  assert.ok(
    sections.flatMap((section) => section.models).some((model) => model.modelId === 'k3'),
    '第二次成功之后目录必须真的可用',
  );
});

test('providers 拉失败不许把目录一起带走（分组退化成平铺，不是整个目录消失）', async () => {
  // provider 名字拿不到只是"分不了组"，模型本身还是能选的。这里把它变成失败，
  // 选择器就会整个空掉——损失远大于收益。
  resetCatalogCache();
  const client = fakeClient({ providersError: new Error('providers 500') });

  const sections = await loadCatalog(client);

  const models = sections.flatMap((section) => section.models);
  assert.deepEqual(
    models.map((model) => model.modelId),
    ['k3'],
    '模型一个都不许少',
  );
  assert.deepEqual(
    sections.map((section) => section.title),
    [null],
    '没有品牌名就平铺',
  );
});

test('models 与 providers 同时失败：providers 的兜底 catch 不许把整个失败吞掉', async () => {
  // `.catch(() => [])` 只挂在 providers 那一条上。如果它被挪到 Promise.all 外面，
  // "目录拉不到"就会变成"目录是空的"——最坏的一种静默失败。
  resetCatalogCache();
  const client = fakeClient({
    modelsError: new Error('models down'),
    providersError: new Error('providers down'),
  });

  await assert.rejects(
    () => loadCatalog(client),
    /models down/,
    'models 失败必须冒出来，不许被 providers 的兜底掩盖',
  );
});

test('同一个 client 成功之后不再重复拉（目录是缓存，不是每帧都请求一次）', async () => {
  resetCatalogCache();
  const client = fakeClient({});

  await loadCatalog(client);
  await loadCatalog(client);

  assert.equal(client.calls.models, 1, '同一份目录拉两次是白打服务端（composer 每次渲染都要它）');
  assert.equal(client.calls.providers, 1);
});

test('换了 client（换服务器）就必须重新拉：缓存认的是实例，不是"拉过一次"', async () => {
  // Memoh 是自托管的：换服务器 = 换一份目录。按"全局拉过一次"缓存会让新服务器上
  // 显示着旧服务器的模型名。
  resetCatalogCache();
  const first = fakeClient({});
  await loadCatalog(first);

  const second = fakeClient({ models: [{ ...MODELS[0], model_id: 'other', name: 'Other' }] });
  const sections = await loadCatalog(second);

  assert.equal(second.calls.models, 1, '新的 client 必须自己去拉');
  assert.deepEqual(
    sections.flatMap((section) => section.models).map((model) => model.modelId),
    ['other'],
  );
});
