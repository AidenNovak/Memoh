/**
 * 定时列表的**行内开关**：判据抽成纯函数之后，在 node 侧钉住。
 *
 * ## 这一份替代了谁
 *
 * `2026-09-15-remaining-work.md` 的 A9 一直停在"部分"：列表渲染验过，**开关没点过**
 * （当时怕动 dev 栈上的真任务）。而"点一下开关"要验的其实是两件事，都与界面无关：
 *
 * 1. **发出去的 payload 只带改过的那一个字段**（L2：改一个字段就够，走 patch）——
 *    多带字段的后果是"拨一下开关，把模型覆盖和推理强度清空了"，而且不会有任何报错；
 * 2. **失败必须把开关拨回去**——否则界面在撒谎（用户看到"关掉了"，服务端其实还是开的）。
 *
 * 这两条以前只存在于 `useSchedule` 的两段内联 `map` 里，而 hook 在这个仓库没有测试面
 * （`pnpm test` 跑纯模块，没有渲染器）。现在状态转移抽成了 `model.ts` 的 `withEnabled`，
 * 于是判据能在**本机**跑；真机上"手指点一下开关"那一步仍然要模拟器（留在清单里）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPayload, updatePayload, withEnabled } from '../src/features/schedule/model.ts';

/** 只关心开关那两条，其余字段用最小值。 */
function schedule(id, enabled) {
  return {
    id,
    name: `task-${id}`,
    description: '',
    pattern: '0 9 * * *',
    command: 'echo hi',
    enabled,
    maxCalls: null,
    execution: {
      runTarget: 'new_session',
      targetSessionId: '',
      runtimeType: '',
      botAgentId: '',
      acpAgentId: '',
      modelId: '',
      acpModelId: '',
      reasoningEffort: '',
      workdirId: '',
    },
  };
}

test('拨开关的 payload 只带 `enabled`——不许把别的字段一起发上去', () => {
  assert.deepEqual(updatePayload({ enabled: false }), { enabled: false });
  assert.deepEqual(updatePayload({ enabled: true }), { enabled: true });
});

test('`maxCalls: null` 是"不限"，要发出去而不是被 `undefined` 吃掉', () => {
  // `null`（显式清空）与 `undefined`（没改这一项）是两件事：前者必须进 payload。
  assert.deepEqual(updatePayload({ maxCalls: null }), { max_calls: null });
  assert.deepEqual(updatePayload({}), {});
});

test('保存整块 `execution` 时：九个字段一个不许少（否则"改个名字清空模型"）', () => {
  const payload = updatePayload({
    name: '改名',
    execution: {
      runTarget: 'existing_session',
      targetSessionId: 's-1',
      runtimeType: 'claude',
      botAgentId: 'a-1',
      acpAgentId: 'acp-1',
      modelId: 'm-1',
      acpModelId: 'am-1',
      reasoningEffort: 'high',
      workdirId: 'w-1',
    },
  });
  assert.deepEqual(payload, {
    name: '改名',
    execution: {
      run_target: 'existing_session',
      target_session_id: 's-1',
      runtime_type: 'claude',
      bot_agent_id: 'a-1',
      acp_agent_id: 'acp-1',
      model_id: 'm-1',
      acp_model_id: 'am-1',
      reasoning_effort: 'high',
      workdir_id: 'w-1',
    },
  });
});

test('新建走平铺形状：不把 `execution` 包成嵌套对象', () => {
  const payload = createPayload({
    name: '每天九点',
    description: '',
    pattern: '0 9 * * *',
    command: 'echo hi',
    enabled: true,
    maxCalls: null,
    execution: {
      runTarget: 'new_session',
      targetSessionId: '',
      runtimeType: 'claude',
      botAgentId: '',
      acpAgentId: '',
      modelId: 'm-1',
      acpModelId: '',
      reasoningEffort: '',
      workdirId: '',
    },
  });
  assert.equal(payload.execution, undefined, 'create 用平铺形状，不该有 execution 这一层');
  assert.equal(payload.run_target, 'new_session');
  assert.equal(payload.model_id, 'm-1');
  assert.equal(payload.enabled, true);
});

test('乐观更新：只动那一条，其余条目与顺序都不变', () => {
  const items = [schedule('a', true), schedule('b', true), schedule('c', false)];
  const next = withEnabled(items, 'b', false);

  assert.deepEqual(
    next?.map((item) => [item.id, item.enabled]),
    [
      ['a', true],
      ['b', false],
      ['c', false],
    ],
  );
  // 没被改的那两条**原样返回**（不是复制一份）：列表是长列表，无谓的重建会让
  // FlatList 整片重渲染。
  assert.equal(next?.[0], items[0]);
  assert.equal(next?.[2], items[2]);
});

test('失败拨回：回到调用前那个值，而且不动别的条目', () => {
  const items = [schedule('a', true), schedule('b', true)];
  const original = items[1];

  const optimistic = withEnabled(items, 'b', false);
  const reverted = withEnabled(optimistic, 'b', original.enabled);

  assert.equal(reverted?.[1]?.enabled, true, '失败之后开关必须回到原值，否则界面在撒谎');
  assert.equal(reverted?.[0], items[0]);
});

test('列表还没拉回来（null）时：原样返回 null，不许炸', () => {
  assert.equal(withEnabled(null, 'a', true), null);
});
