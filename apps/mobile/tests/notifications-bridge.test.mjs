/**
 * 推送桥的非原生部分：呈现翻译、分类、token 上报契约、点击路由与提交判据。
 *
 * 这一组盯的是**接线的正确性**，不是"能不能跑通"：
 *
 * 1. policy 的判定被翻译成系统选项时，`in_app` / `drop` **不许**变成横幅
 *    （前台弹横幅 = 把 HIG 判据丢掉）；
 * 2. 通知分类名必须来自 policy，动作只有"允许/拒绝"两个，且**不带** agent 的选项 id
 *    （硬编一个 agent 没给过的 `option_id` 会被服务端匹配不到，审批直接卡死）；
 * 3. 换号必须**先解绑再加**（Lody 第 24 条：覆盖式注册会把前一个用户的推送留给新用户）；
 * 4. 点击后的提交必须**只在审批 id 完全相等**时发生——替用户批准一个他没看见的命令
 *    是这条链路上唯一不可挽回的错误。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOW_ACTION_ID,
  REJECT_ACTION_ID,
  actionsForCategory,
  categorySpecs,
} from '../src/features/notifications/categories.ts';
import {
  EMPTY_HISTORY,
  parsePermissionHistory,
  recordPermissionRequest,
} from '../src/features/notifications/history.ts';
import {
  APPROVAL_WAIT_MS,
  approvalOptionIdFor,
  matchesCurrentUser,
  parseOpen,
  routeFor,
  submissionFor,
} from '../src/features/notifications/openRouting.ts';
import { payloadFor } from '../src/features/notifications/policy.ts';
import {
  PRESENTATION_OPTIONS,
  presentationResolution,
} from '../src/features/notifications/presentation.ts';
import {
  authorizationHeader,
  boundAfter,
  describeToken,
  DEVICE_REGISTRATION_PATH,
  parseBound,
  pushEnvironment,
  registrationSteps,
  requestFor,
  serializeBound,
  SERVER_REQUIREMENTS,
} from '../src/features/notifications/registration.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LOCALES = join(ROOT, 'locales');
const KIT = join(ROOT, 'modules/memoh-kit/ios/Notifications');
const PAYLOADS = join(ROOT, 'verification/push/payloads');

const translate = (key) => `t:${key}`;

// ---------------------------------------------------------------- 呈现

test('policy 的前台判定不会变成横幅', () => {
  // 前台只有 in_app / drop 两种结论，两者都不许弹横幅——这是 HIG 那条
  // "通知在前台不出现，由 App 自己接住"的落点。
  assert.deepEqual(PRESENTATION_OPTIONS.in_app, []);
  assert.deepEqual(PRESENTATION_OPTIONS.drop, []);
  // 后台（notify）才交给系统。
  assert.deepEqual(PRESENTATION_OPTIONS.notify, ['banner', 'list', 'sound']);
});

test('呈现答复是原生能认的形状', () => {
  const payload = JSON.parse(presentationResolution('req-1', 'in_app'));
  assert.equal(payload.requestId, 'req-1');
  assert.deepEqual(payload.options, []);
});

// ---------------------------------------------------------------- 分类

test('分类名来自 policy，不是另抄一份', () => {
  const specs = categorySpecs(translate);
  const approval = payloadFor('approval_waiting', { sessionId: 's', botName: 'b' });
  const run = payloadFor('run_finished', { sessionId: 's', botName: 'b' });
  assert.ok(specs.some((spec) => spec.id === approval.category));
  assert.ok(specs.some((spec) => spec.id === run.category));
  // 跑完与失败共用同一个分类：注册两个一样的分类会被系统当成一个。
  assert.equal(new Set(specs.map((spec) => spec.id)).size, specs.length);
});

test('审批分类带两个动作，且只有它带', () => {
  const specs = categorySpecs(translate);
  const approval = payloadFor('approval_waiting', { sessionId: 's', botName: 'b' });
  const actions = actionsForCategory(specs, approval.category);
  assert.deepEqual(
    actions.map((action) => action.id),
    [ALLOW_ACTION_ID, REJECT_ACTION_ID],
  );
  // 文案走 i18n（通知按钮也是用户要读的字）。
  assert.equal(actions[0].title, 't:notifications.action.allow');
  const run = payloadFor('run_finished', { sessionId: 's', botName: 'b' });
  assert.deepEqual(actionsForCategory(specs, run.category), []);
});

test('两个动作的文案在两语里都存在', () => {
  for (const file of ['en.json', 'zh-Hans.json']) {
    const catalog = JSON.parse(readFileSync(join(LOCALES, file), 'utf8'));
    for (const key of [
      'notifications.action.allow',
      'notifications.action.reject',
      'notifications.enable.row',
      'notifications.enable.header',
      'notifications.enable.footer',
    ]) {
      assert.equal(typeof catalog[key], 'string', `${file} 缺 ${key}`);
    }
  }
});

test('动作标识符与原生契约是同一套字面量', () => {
  // 原生按这套标识符认动作；两边漂了的表现是"按钮在，点了没反应"。
  const swift = readFileSync(join(KIT, 'NotificationContract.swift'), 'utf8');
  assert.ok(swift.includes('memoh.approval.allow'));
  assert.ok(swift.includes('memoh.approval.reject'));
  // 负载里的键也必须是同一套。
  assert.ok(swift.includes('"sessionId"'));
  assert.ok(swift.includes('"approvalId"'));
});

test('呈现选项名在原生那一侧都认得', () => {
  const swift = readFileSync(join(KIT, 'NotificationContract.swift'), 'utf8');
  for (const name of ['banner', 'list', 'sound', 'badge']) {
    assert.ok(swift.includes(`case ${name}`), `原生不认识呈现选项 ${name}`);
  }
});

// ---------------------------------------------------------------- token 上报

const CTX = { bundleId: 'ai.memoh.ios', userId: 'user-a' };

test('没 token 或没用户时什么都不做', () => {
  assert.deepEqual(
    registrationSteps({ token: null, userId: 'user-a', bound: null, environment: 'sandbox' }),
    [],
  );
  assert.deepEqual(
    registrationSteps({ token: 'abc', userId: null, bound: null, environment: 'sandbox' }),
    [],
  );
});

test('第一次注册只发一步', () => {
  const steps = registrationSteps({
    token: 'abc',
    userId: 'user-a',
    bound: null,
    environment: 'sandbox',
  });
  assert.deepEqual(steps, [
    { kind: 'register', token: 'abc', userId: 'user-a', environment: 'sandbox' },
  ]);
});

test('已经对上了就不重复上报', () => {
  assert.deepEqual(
    registrationSteps({
      token: 'abc',
      userId: 'user-a',
      bound: { token: 'abc', userId: 'user-a' },
      environment: 'sandbox',
    }),
    [],
  );
});

test('换号先解绑再加', () => {
  const steps = registrationSteps({
    token: 'abc',
    userId: 'user-b',
    bound: { token: 'abc', userId: 'user-a' },
    environment: 'sandbox',
  });
  assert.deepEqual(
    steps.map((step) => step.kind),
    ['unregister', 'register'],
  );
  assert.deepEqual(steps[1], {
    kind: 'register',
    token: 'abc',
    userId: 'user-b',
    environment: 'sandbox',
  });
});

test('token 轮换也是先解绑再加', () => {
  const steps = registrationSteps({
    token: 'new',
    userId: 'user-a',
    bound: { token: 'old', userId: 'user-a' },
    environment: 'production',
  });
  assert.deepEqual(
    steps.map((step) => step.kind),
    ['unregister', 'register'],
  );
});

test('token 不进 URL，只进 body', () => {
  const register = requestFor(
    { kind: 'register', token: 'abc', userId: 'user-a', environment: 'sandbox' },
    CTX,
  );
  const unregister = requestFor({ kind: 'unregister', token: 'abc' }, CTX);
  assert.equal(register.path, DEVICE_REGISTRATION_PATH);
  assert.equal(unregister.path, DEVICE_REGISTRATION_PATH);
  assert.equal(register.method, 'POST');
  assert.equal(unregister.method, 'DELETE');
  for (const request of [register, unregister]) {
    assert.ok(!request.path.includes('abc'), 'token 出现在路径里了');
    assert.equal(request.body.token, 'abc');
    assert.equal(request.body.user_id, 'user-a');
  }
  assert.equal(register.body.platform, 'ios');
  assert.equal(register.body.bundle_id, 'ai.memoh.ios');
  assert.equal(register.body.environment, 'sandbox');
  assert.equal(pushEnvironment(false), 'production');
});

test('鉴权头与其余端点一致', () => {
  assert.deepEqual(authorizationHeader('tok'), { Authorization: 'Bearer tok' });
});

test('绑定状态随结果推进，失败不改写', () => {
  const register = { kind: 'register', token: 'abc', userId: 'user-a', environment: 'sandbox' };
  assert.deepEqual(boundAfter(register, true, null), { token: 'abc', userId: 'user-a' });
  assert.equal(boundAfter(register, false, null), null);
  assert.equal(
    boundAfter({ kind: 'unregister', token: 'abc' }, true, { token: 'abc', userId: 'user-a' }),
    null,
  );
  // 解绑成功但注册没跑：不能留下"已绑过"的假状态，否则永远不再注册。
  assert.equal(boundAfter({ kind: 'unregister', token: 'abc' }, true, null), null);
});

test('绑定记录读坏了当没绑过', () => {
  assert.equal(parseBound(null), null);
  assert.equal(parseBound(''), null);
  assert.equal(parseBound('{'), null);
  assert.equal(parseBound('{"token":""}'), null);
  assert.equal(parseBound('{"token":"abc"}'), null);
  assert.deepEqual(parseBound(serializeBound({ token: 'abc', userId: 'u' })), {
    token: 'abc',
    userId: 'u',
  });
});

test('日志里不出现 token 本身', () => {
  const token = 'a1b2c3d4e5f6';
  const shown = describeToken(token);
  assert.ok(!shown.includes(token));
  assert.equal(describeToken(null), 'none');
  assert.equal(describeToken(''), 'none');
});

test('服务端那一半的要求写在契约里', () => {
  // 三条都是安全要求，不是建议——少一条就会出现"能给别人解绑"或"留下两条绑定"。
  assert.equal(SERVER_REQUIREMENTS.length, 3);
  assert.ok(SERVER_REQUIREMENTS.some((line) => line.includes('400')));
  assert.ok(SERVER_REQUIREMENTS.some((line) => line.includes('覆盖')));
});

// ---------------------------------------------------------------- 权限史

test('权限史读坏了退回没请求过', () => {
  assert.deepEqual(parsePermissionHistory(null), EMPTY_HISTORY);
  assert.deepEqual(parsePermissionHistory('[]'), EMPTY_HISTORY);
  assert.deepEqual(parsePermissionHistory('{"askedCount":"3"}'), EMPTY_HISTORY);
  assert.deepEqual(parsePermissionHistory('{"askedCount":-2,"lastAskedAt":"x"}'), {
    askedCount: 0,
    lastAskedAt: null,
  });
});

test('记一次请求只加计数与时间', () => {
  const next = recordPermissionRequest(EMPTY_HISTORY, 1000);
  assert.deepEqual(next, { askedCount: 1, lastAskedAt: 1000 });
  assert.deepEqual(recordPermissionRequest(next, 2000), { askedCount: 2, lastAskedAt: 2000 });
});

// ---------------------------------------------------------------- 点击

test('没有 sessionId 的点击不产生请求', () => {
  assert.equal(parseOpen({ action: 'opened' }), null);
  assert.equal(parseOpen('nope'), null);
  assert.equal(parseOpen(null), null);
});

test('认不出的动作当"点了通知本体"，事件认不出就是空', () => {
  const open = parseOpen({ sessionId: 's1', action: 'whatever', event: 'brand_new' });
  assert.equal(open.action, 'opened');
  assert.equal(open.event, null);
});

test('数值 id 也认（负载过了三道序列化）', () => {
  const open = parseOpen({ sessionId: 42, action: 'allow' });
  assert.equal(open.sessionId, '42');
});

test('深链目标就是会话路由', () => {
  const open = parseOpen({ sessionId: 's1', action: 'opened' });
  assert.equal(routeFor(open), '/chat/s1');
});

test('提交的是兜底决定，不带 agent 的选项 id', () => {
  const allow = parseOpen({ sessionId: 's1', approvalId: 'a1', action: 'allow' });
  const reject = parseOpen({ sessionId: 's1', approvalId: 'a1', action: 'reject' });
  assert.equal(approvalOptionIdFor(allow), '__fallback_approve__');
  assert.equal(approvalOptionIdFor(reject), '__fallback_reject__');
  // 点通知本体不提交任何决定。
  assert.equal(approvalOptionIdFor(parseOpen({ sessionId: 's1', action: 'opened' })), null);
});

test('别的声音都不属于这个账号时不深链、不提交', () => {
  const foreign = parseOpen({
    sessionId: 's1',
    approvalId: 'a1',
    action: 'allow',
    recipientUserId: 'someone',
  });
  assert.equal(matchesCurrentUser(foreign, 'user-a'), false);
  const submission = submissionFor({
    open: foreign,
    pending: { approvalId: 'a1', runId: 'r1' },
    elapsedMs: 0,
    currentUserId: 'user-a',
  });
  assert.deepEqual(submission, { kind: 'stop', why: 'not_mine' });
  // 负载没带归属时无法核对，放行（否则会吞掉用户真正的审批）。
  assert.equal(matchesCurrentUser(parseOpen({ sessionId: 's1', action: 'allow' }), 'user-a'), true);
  // 未登录时带着归属的通知一律不放行。
  assert.equal(matchesCurrentUser(foreign, null), false);
});

test('审批 id 完全相等才提交', () => {
  const open = parseOpen({ sessionId: 's1', approvalId: 'a1', action: 'allow' });
  assert.deepEqual(
    submissionFor({ open, pending: { approvalId: 'a2', runId: 'r' }, elapsedMs: 0 }),
    { kind: 'wait' },
  );
  assert.deepEqual(
    submissionFor({ open, pending: { approvalId: 'a1', runId: 'r' }, elapsedMs: 0 }),
    { kind: 'submit', optionId: '__fallback_approve__' },
  );
  assert.deepEqual(submissionFor({ open, pending: null, elapsedMs: 0 }), { kind: 'wait' });
});

test('等不到就放弃，不用"当前挂着的另一次审批"顶上', () => {
  const open = parseOpen({ sessionId: 's1', approvalId: 'a1', action: 'allow' });
  assert.deepEqual(
    submissionFor({ open, pending: { approvalId: 'a2', runId: 'r' }, elapsedMs: APPROVAL_WAIT_MS }),
    { kind: 'stop', why: 'timed_out' },
  );
  const noApproval = parseOpen({ sessionId: 's1', action: 'allow' });
  assert.deepEqual(submissionFor({ open: noApproval, pending: null, elapsedMs: 0 }), {
    kind: 'stop',
    why: 'no_approval_id',
  });
});

// ---------------------------------------------------------------- 负载样例

test('验收用的负载与判据一致（分类/线程/打扰等级）', () => {
  const files = ['approval-1.json', 'approval-2.json', 'run-finished.json', 'run-failed.json'];
  const cases = [
    ['approval-1.json', 'approval_waiting'],
    ['approval-2.json', 'approval_waiting'],
    ['run-finished.json', 'run_finished'],
    ['run-failed.json', 'run_failed'],
  ];
  for (const [file, event] of cases) {
    assert.ok(files.includes(file));
    const payload = JSON.parse(readFileSync(join(PAYLOADS, file), 'utf8'));
    const aps = payload.aps;
    const expected = payloadFor(event, { sessionId: payload.sessionId, botName: 'x' });
    // same 来源：分类、线程、打扰等级都必须是 policy 算出来的那一套。
    assert.equal(aps.category, expected.category, `${file} category`);
    assert.equal(aps['thread-id'], expected.threadId, `${file} thread-id`);
    assert.equal(aps['interruption-level'], levelName(expected.interruptionLevel), `${file} level`);
    assert.equal(payload.event, event, `${file} event`);
    assert.ok(typeof aps.alert.title === 'string' && aps.alert.title !== '');
    assert.ok(typeof aps.alert.body === 'string' && aps.alert.body !== '');
    // 设备 token 是设备级信息，不进负载。
    assert.equal(aps.token, undefined);
  }
});

test('审批负载带得到会话与那一次审批，跑完/失败不带审批', () => {
  const approval = JSON.parse(readFileSync(join(PAYLOADS, 'approval-1.json'), 'utf8'));
  assert.equal(approval.sessionId, 'fixture-session-untitled');
  assert.equal(approval.approvalId, 'scene-approval-2');
  assert.equal(approval.recipientUserId, 'fixture-user');
  const finished = JSON.parse(readFileSync(join(PAYLOADS, 'run-finished.json'), 'utf8'));
  assert.equal(finished.approvalId, undefined);
});

test('负载里的正文不含对话内容与错误原文', () => {
  // 通知会出现在锁屏上（HIG：不要把敏感信息放进通知）。样例是给别人照抄的模板，
  // 这里把"不该出现什么"钉住。
  for (const file of [
    'approval-1.json',
    'approval-2.json',
    'run-finished.json',
    'run-failed.json',
  ]) {
    const raw = readFileSync(join(PAYLOADS, file), 'utf8');
    for (const forbidden of ['rm -rf', '/tmp', 'stack', 'Error:', 'token']) {
      assert.ok(!raw.includes(forbidden), `${file} 里出现了 ${forbidden}`);
    }
  }
});

function levelName(level) {
  if (level === 'timeSensitive') return 'time-sensitive';
  return level;
}
