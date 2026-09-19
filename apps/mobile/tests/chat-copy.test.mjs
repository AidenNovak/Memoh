/**
 * 这一屏"从状态翻出一句话 / 一颗按钮"的纯逻辑（拆 `ChatScreen` 时搬出来的）。
 *
 * ## 为什么这些值得单独钉
 *
 * 它们的共同点是**错了也没人看得见**：读屏用户听不到播报、胶囊悄悄退回"默认"、
 * 失败原因被吞掉、按钮字形与读屏标签错位——都不会报错、不会崩，只有用户会觉得
 * "这个 App 怪怪的"。过去它们写在 `ChatScreen` 的函数体里（评审 D2 点名的那个
 * ~700 行单函数），只能靠真机一张张截图看。
 *
 * 判据来源：`docs/CHAT-ACCEPTANCE.md` 的 A4/A5/A6/B2，以及规则 R23/R24（别用命名
 * 约定嗅探服务端原文）、R28（自己出现的事要念一次）、R30/R48（读到什么 = 看到什么）。
 *
 * 反假绿：`tests/mutation-check.sh` 的 `composer-glyph-ignores-action` /
 * `run-failure-announced-when-not-errored`（改坏实现确认这两条会红）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  headerSubtitle,
  modelPillLabel,
  reasonOf,
  runFailureNotice,
  userTextOfTurn,
} from '../src/features/chat/copy.ts';
import { composerView } from '../src/features/chat/composer.ts';

/** 只翻译"我们自己表里有的" key，其余原样返回——和 `translateFor` 的兜底一致。 */
const catalog = {
  'chat.run.failed': '这一轮提前停了',
  'chat.thinking': '思考中',
  'chat.gap': '刷新中',
  'chat.model.default': '默认',
  'chat.effort.high': '高',
  'chat.send': '发送',
  'chat.stop': '停止',
  'queue.send': '排队',
};
const t = (key) => catalog[key] ?? key;
const hasKey = (key) => Object.hasOwn(catalog, key);

// ---------------------------------------------------------------- run 失败那一块

test('run 失败：不是 errored 就不说话（视觉不出现、读屏也不念）', () => {
  assert.equal(runFailureNotice({ runStatus: 'running', runError: null }, t, hasKey), null);
  assert.equal(runFailureNotice({ runStatus: 'completed', runError: null }, t, hasKey), null);
  // 还没收到过 snapshot（null）时同样不出现。
  assert.equal(runFailureNotice({ runStatus: null, runError: null }, t, hasKey), null);
  /**
   这一格是**最要紧**的一格：`runError` 还留着、状态已经不是 errored 时不许再播报。
   把判据写成"有没有 runError"就会在用户重新跑起来之后又念一遍上一轮的失败。
   */
  assert.equal(
    runFailureNotice({ runStatus: 'running', runError: 'error.runAbandoned' }, t, hasKey),
    null,
  );
});

test('run 失败：自己的 key 翻译，服务端原文原样转达（R23/R24）', () => {
  // reducer 给的是我们自己的 key。
  assert.deepEqual(
    runFailureNotice({ runStatus: 'errored', runError: 'chat.run.failed' }, t, hasKey),
    {
      label: '这一轮提前停了 · 这一轮提前停了',
      reason: '这一轮提前停了',
    },
  );
  // 协议里带的可能是服务端**已经写好的句子**：查不到就原样转达，不许嗅探 `error.` 前缀。
  const serverSentence = 'The run was abandoned by the server.';
  assert.deepEqual(
    runFailureNotice({ runStatus: 'errored', runError: serverSentence }, t, hasKey),
    {
      label: `这一轮提前停了 · ${serverSentence}`,
      reason: serverSentence,
    },
  );
  // 分隔符必须是 `·`：原因那句自带标点不可控，半角句点会在中文里拼出「停了. 这个 run…」。
  assert.ok(
    runFailureNotice({ runStatus: 'errored', runError: serverSentence }, t, hasKey).label.includes(
      ' · ',
    ),
  );
});

test('run 失败：没有原因时只有标题，且不编一句', () => {
  // 视觉上是一行；读屏念的是标题那一句（读到什么 = 看到什么，R30/R48）。
  assert.deepEqual(runFailureNotice({ runStatus: 'errored', runError: null }, t, hasKey), {
    label: '这一轮提前停了',
    reason: null,
  });
  assert.deepEqual(runFailureNotice({ runStatus: 'errored', runError: '' }, t, hasKey), {
    label: '这一轮提前停了',
    reason: null,
  });
});

test('reasonOf：空 / 缺省一律 null，不返回空串（否则会多画一行空行）', () => {
  assert.equal(reasonOf(null, t, hasKey), null);
  assert.equal(reasonOf('', t, hasKey), null);
  assert.equal(reasonOf('chat.thinking', t, hasKey), '思考中');
  assert.equal(reasonOf('别的服务端原文', t, hasKey), '别的服务端原文');
});

// ---------------------------------------------------------------- 表头副标题

test('副标题：谁在说话 · 现在在干什么（两段都可能缺，缺的那段不出现）', () => {
  const bot = { name: 'helper', display_name: '小助手' };
  // 运行中优先于 stale：正在跑的时候说"刷新中"会让人以为它卡住了。
  assert.equal(headerSubtitle({ bot, running: true, stale: true }, t), '小助手 · 思考中');
  assert.equal(headerSubtitle({ bot, running: false, stale: true }, t), '小助手 · 刷新中');
  // 都没发生：只留名字，不留一个孤零零的 `·`。
  assert.equal(headerSubtitle({ bot, running: false, stale: false }, t), '小助手');
  // 没有 display_name 时退回 name（服务端允许它为空）。
  assert.equal(
    headerSubtitle({ bot: { name: 'helper', display_name: '' }, running: false, stale: false }, t),
    'helper',
  );
  // 没有 bot：只剩状态那一段。
  assert.equal(headerSubtitle({ bot: null, running: true, stale: false }, t), '思考中');
  assert.equal(headerSubtitle({ bot: null, running: false, stale: false }, t), '');
});

// ---------------------------------------------------------------- 模型胶囊

const sections = [
  {
    title: 'Kimi',
    models: [
      {
        modelId: 'k3',
        name: 'Kimi K3',
        providerId: 'kimi',
        providerName: 'Kimi',
        supportsReasoning: true,
        canDisableReasoning: true,
        efforts: ['low', 'high'],
        defaultEffort: 'low',
      },
    ],
  },
];

test('胶囊：没选过 → "默认"（服务端决定用哪个）', () => {
  assert.equal(modelPillLabel(null, { modelId: null, reasoningEffort: null }, t), '默认');
  assert.equal(modelPillLabel(sections, { modelId: null, reasoningEffort: 'high' }, t), '默认');
});

test('胶囊：选过且有名字 → 名字（`k3` 不是给人看的）', () => {
  assert.equal(modelPillLabel(sections, { modelId: 'k3', reasoningEffort: null }, t), 'Kimi K3');
});

test('胶囊：选过但目录里没有 → 原样显示 modelId，不撒谎说"默认"', () => {
  assert.equal(
    modelPillLabel(sections, { modelId: 'gone-4o', reasoningEffort: null }, t),
    'gone-4o',
  );
  // 目录还没拉回来（null）也是同一档。
  assert.equal(modelPillLabel(null, { modelId: 'k3', reasoningEffort: null }, t), 'k3');
});

test('胶囊：强度跟着模型名一起写（否则得点开才知道上一轮用的哪档）', () => {
  assert.equal(
    modelPillLabel(sections, { modelId: 'k3', reasoningEffort: 'high' }, t),
    'Kimi K3 · 高',
  );
  // 服务端可以加新档位：认不出来就原样显示那个字符串（不显示空白、不显示 unknown）。
  assert.equal(
    modelPillLabel(sections, { modelId: 'k3', reasoningEffort: 'ultra' }, t),
    'Kimi K3 · ultra',
  );
});

// ---------------------------------------------------------------- 一轮里的用户正文

function turn(key, blocks) {
  return { key, position: 0, active: false, user: { blocks } };
}

test('userTextOfTurn：只取 text 块，多个块按行拼；找不到那一轮返回空串', () => {
  const turns = [
    turn('t1', [
      { kind: 'text', key: 'b1', text: '第一句' },
      { kind: 'attachments', key: 'b2', items: [] },
      { kind: 'text', key: 'b3', text: '第二句' },
    ]),
  ];
  assert.equal(userTextOfTurn(turns, 't1'), '第一句\n第二句');
  // 找不到那一轮（历史被换掉、渲染被截断）：宁可什么都不发，也不发一条我们编出来的消息。
  assert.equal(userTextOfTurn(turns, 'nope'), '');
  assert.equal(userTextOfTurn([], 't1'), '');
  // 没有 user 侧的那一轮（只有助手回答）也是空串。
  assert.equal(userTextOfTurn([{ key: 't2', position: 0, active: false }], 't2'), '');
  // 全是附件、没有正文：空串（不发一条只有附件的"重发"）。
  assert.equal(
    userTextOfTurn([turn('t3', [{ kind: 'attachments', key: 'b', items: [] }])], 't3'),
    '',
  );
});

// ---------------------------------------------------------------- 发送键语义

test('A6/B2：运行中且草稿为空 → 停止，绝不是发送', () => {
  for (const support of ['unknown', 'yes', 'no']) {
    const view = composerView({ draft: '', running: true, support });
    assert.equal(view.action, 'stop', `support=${support}`);
    assert.equal(view.glyph, '■');
    assert.equal(view.labelKey, 'chat.stop');
    // 运行中按钮**可点**（那一下就是停止）——这是判据 A5 的那颗键。
    assert.equal(view.canSend, true);
  }
});

test('空闲：永远是发送（草稿为空时由禁用表达，语义不变）', () => {
  for (const support of ['unknown', 'yes', 'no']) {
    const empty = composerView({ draft: '', running: false, support });
    assert.equal(empty.action, 'send');
    assert.equal(empty.canSend, false, '没文字就该禁用');
    assert.equal(empty.glyph, '↑');
    assert.equal(empty.labelKey, 'chat.send');

    const typed = composerView({ draft: '你好', running: false, support });
    assert.equal(typed.action, 'send');
    assert.equal(typed.canSend, true);
    assert.equal(typed.labelKey, 'chat.send');
  }
});

test('A7：运行中 + 有草稿 = 支持队列才排队，否则回到停止', () => {
  // 本部署 `/queue` 404 → support 是 `no`，运行中的按钮必须是停止（与同一部署的桌面端一致）。
  assert.deepEqual(
    { ...composerView({ draft: '补一句', running: true, support: 'no' }) },
    {
      hasDraft: true,
      canSend: true,
      action: 'stop',
      labelKey: 'chat.stop',
      glyph: '■',
    },
  );
  const queued = composerView({ draft: '补一句', running: true, support: 'yes' });
  assert.equal(queued.action, 'queue');
  // "排队"和"发送"对用户是两件事：字形相同（都是 ↑），但读屏标签必须分开。
  assert.equal(queued.labelKey, 'queue.send');
  assert.equal(queued.glyph, '↑');
  // 能力还没探测出来时按"不支持"处理：宁可不给入口，也不要给一个必然失败的。
  assert.equal(composerView({ draft: '补一句', running: true, support: 'unknown' }).action, 'stop');
});

test('草稿判据是 trim 之后还有没有内容（空格不算"有话说"）', () => {
  assert.equal(composerView({ draft: '   ', running: false, support: 'no' }).hasDraft, false);
  assert.equal(composerView({ draft: '   ', running: true, support: 'no' }).action, 'stop');
  assert.equal(composerView({ draft: ' x ', running: false, support: 'no' }).hasDraft, true);
});
