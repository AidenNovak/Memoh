/**
 * "发出去的那一帧到底带了什么"——把一条原本只能在 Maestro 里验的断言搬到 node 侧。
 *
 * ## 这一份替代了谁
 *
 * `verification/navigation/assert-wire.py` 断言的是**固定服务端收到的原始帧**里
 * `model_id` / `reasoning_effort` / 正文都在。它跑在 Maestro 流程里 —— 那条路要模拟器 +
 * Maestro（也就是要 Xcode）。可是"这一帧带没带这几个字段"是**协议层**的事，与界面无关：
 * 用 node 起同一个固定服务端（`verification/fixture/server.mjs` 本来就有
 * `GET /__last-client-message` 这个观测台）、用真的 `MemohRealtime` 发一条，就能在
 * **本机**把同一件事断言掉。
 *
 * ## 判据是"服务端看到了什么"，不是"我们这边调用了什么"
 *
 * 观测台给的是原样的帧 JSON。客户端改了字段名、忘了带某个参数、或者把值吞了，这里就红——
 * 而界面看起来一切正常。这正是 `assert-wire.py` 当初存在的理由（它的注释原话：
 * "界面验收只能证明界面变了，而模型/强度的契约是每条消息都带 `model_id`"）。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { makeClient, startFixture } from '../verification/fixture/netlab.mjs';

const SESSION = 'wire-session';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let fixture;

before(async () => {
  // 18500：避开验收（18099）、自检（18199）、实验台（18299）、弱网（18400）。
  fixture = await startFixture(18500);
});

after(() => {
  fixture?.stop();
});

async function waitForOpen(realtime) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (realtime.connectionState === 'open') return;
    await sleep(20);
  }
  throw new Error(`没连上，状态停在 ${realtime.connectionState}`);
}

/** 读服务端手上那条帧（到点还没到就返回 null）。 */
async function lastClientMessage() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = await (await fetch(`${fixture.base}/__last-client-message`)).json();
    if (frame !== null) return frame;
    await sleep(20);
  }
  return null;
}

test('发出去的 message 帧：模型 / 思考强度 / 技能 / 正文都要在', async () => {
  const { realtime } = makeClient({ base: fixture.base });
  try {
    realtime.connect();
    await waitForOpen(realtime);

    realtime.sendMessage({
      sessionId: SESSION,
      text: 'wire check',
      modelId: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      requestedSkills: ['demo-skill'],
    });

    const frame = await lastClientMessage();
    assert.notEqual(frame, null, '服务端一条 message 帧都没收到');
    assert.equal(frame.type, 'message');
    assert.equal(frame.session_id, SESSION);
    assert.equal(frame.text, 'wire check', '正文必须原样带过去（`/skill` 也在正文里）');
    assert.equal(frame.model_id, 'deepseek-v4-flash', '模型必须随消息走，不是只改界面胶囊');
    assert.equal(frame.reasoning_effort, 'high');
    assert.deepEqual(frame.requested_skills, ['demo-skill']);
    assert.ok(
      typeof frame.invocation_id === 'string' && frame.invocation_id !== '',
      '幂等键必须在：重发同一个不会产生第二轮',
    );
  } finally {
    realtime.dispose();
  }
});

test('没选模型时：帧里不许凭空冒出 model_id（缺省由服务端定）', async () => {
  const { realtime } = makeClient({ base: fixture.base });
  try {
    realtime.connect();
    await waitForOpen(realtime);

    realtime.sendMessage({ sessionId: SESSION, text: 'no model' });

    const frame = await lastClientMessage();
    assert.notEqual(frame, null, '服务端一条 message 帧都没收到');
    assert.equal(frame.text, 'no model');
    assert.equal(frame.model_id, undefined, '我们没选，就不该编一个值发出去');
    assert.equal(frame.reasoning_effort, undefined);
  } finally {
    realtime.dispose();
  }
});
