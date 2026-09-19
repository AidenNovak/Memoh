/**
 * 对话与输入区的**验收判据**里能变成纯逻辑断言的那几条（见 `docs/CHAT-ACCEPTANCE.md`）。
 *
 * 这份清单里的多数条目要靠真机证据（截图、录屏、无障碍树）。这里只钉住其中两条
 * **错了也没人看得见**的规则：
 *
 * 1. **运行中不许给出"发送"入口**（A6/B2）。发送键的语义由 `composerActionWithSupport`
 *    从 run 状态推出来；推错了的表现是"agent 还在跑，按钮却是发送箭头"，用户唯一的
 *    结论是"这个 App 坏了"。所以这里把三种支持度 × 两种草稿态 × 运行/空闲**全排一遍**，
 *    而不是只测实现里此刻会走到的那一格。
 * 2. **空态文案不许承诺这台部署做不到的事**（A8）。原文案写着"它干活时你还能再排一句"，
 *    而实测部署的 `/queue` 一律 404（`docs/environment.md`「部署实际支持什么」）——
 *    用户照着做只会撞上"停止"。这条判据按**形状**查（出现排队语义的词就算违规），
 *    措辞怎么改都不会漏。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { composerActionWithSupport } from '../src/features/chat/queue.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'locales');

function catalog(name) {
  return JSON.parse(readFileSync(join(LOCALES, name), 'utf8'));
}

test('A6：运行中且草稿为空时，发送键绝不返回 send', () => {
  const supports = ['unknown', 'yes', 'no'];
  for (const support of supports) {
    for (const hasDraft of [true, false]) {
      for (const running of [true, false]) {
        const action = composerActionWithSupport({ running, hasDraft, support });
        // 值域先钉住：出现第四个值说明渲染层会拿到它没处理的分支。
        assert.ok(['send', 'queue', 'stop'].includes(action), `未知动作 ${action}`);
        if (running && !hasDraft) {
          assert.equal(
            action,
            'stop',
            `运行中 + 空草稿（support=${support}）必须是停止，不能是 ${action}`,
          );
        }
        if (!running) {
          // 空闲时永远是"发送"：草稿为空时按钮由渲染层禁用，语义不能变成"停止"。
          assert.equal(action, 'send', `空闲（support=${support}）必须是发送，不能是 ${action}`);
        }
      }
    }
  }
});

test('A7：只有服务端真支持队列时，"运行中 + 有草稿"才是排队', () => {
  assert.equal(
    composerActionWithSupport({ running: true, hasDraft: true, support: 'yes' }),
    'queue',
  );
  assert.equal(composerActionWithSupport({ running: true, hasDraft: true, support: 'no' }), 'stop');
  // 能力还没探测出来时按"不支持"处理：给一个必然失败的入口比没有入口更坏。
  assert.equal(
    composerActionWithSupport({ running: true, hasDraft: true, support: 'unknown' }),
    'stop',
  );
});

test('A8：空态文案不得承诺"边跑边排队"', () => {
  const banned = [/queue/i, /排队/, /再排/, /继续排/];
  for (const name of ['en.json', 'zh-Hans.json']) {
    const body = catalog(name)['chat.empty.body'];
    assert.equal(typeof body, 'string', `${name} 缺 chat.empty.body`);
    for (const pattern of banned) {
      assert.ok(
        !pattern.test(body),
        `${name} 的 chat.empty.body 承诺了队列能力（命中 ${pattern}）：${body}`,
      );
    }
  }
});

test('A4/A5：输入区要用的那几条文案两份都在', () => {
  const keys = [
    'chat.model.a11y',
    'chat.model.default',
    'chat.send',
    'chat.stop',
    'chat.placeholder',
  ];
  for (const name of ['en.json', 'zh-Hans.json']) {
    const table = catalog(name);
    for (const key of keys) {
      assert.equal(typeof table[key], 'string', `${name} 缺 ${key}`);
      assert.notEqual(table[key], '', `${name} 的 ${key} 是空的`);
    }
  }
});
