/**
 * REST 客户端的**失败路径**。
 *
 * `client.test.mjs` 盯的是"请求怎么被构造出来"（形状对不对）；这一份盯的是
 * **失败怎么被分类**——以及分类之后屏上会说什么。
 *
 * ## 为什么值得一条一条钉
 *
 * 失败分类错了不会崩，只会**撒谎**：
 *
 * - 网关 HTML 透明上屏 → 用户读到 "<html>502 Bad Gateway"；
 * - 没有类型化 code 的 5xx 原文上屏 → 用户读到 "HTTP 500" 这种零信息；
 * - 超时被说成"没有网络" → 用户去开关 Wi-Fi，而问题在服务端；
 * - 把 404 / 403 说成网络错误 → 用户反复点重试；
 * - 门户劫持返回 200 + HTML 时静默当成"没有数据" → 屏幕上显示空列表，而数据是拉到过的。
 *
 * 判据的权威出处是 `docs/research/ios-error-and-feedback.md` §3/§4 与
 * `features/errors/present.ts` 的文件头（**retry 是白名单**、**服务端原文只在带类型化
 * code 时才上屏**），所以这里每条都同时断言"抛什么"和"屏上说什么"。
 *
 * 每条用例都自己写一句 `assert.rejects`（而不是共用一个"先 catch 再 assert"的壳）：
 * 失败路径的断言本身就是"它必须失败"，共用壳会让"其实成功了"的实现也通过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, MemohClient } from '../src/api/client.ts';
import { canRetry, presentError } from '../src/features/errors/present.ts';

/** 假 fetch：按给定的状态与响应体回一次，并把请求记下来。 */
function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers ?? {} });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
      json: async () => JSON.parse(response.body),
    };
  };
  return calls;
}

function client(overrides = {}) {
  return new MemohClient({ baseUrl: 'http://x', getToken: () => 'tok', ...overrides });
}

/**
 * 「这次失败必须是哪一类」——写成 `assert.rejects` 的判据。
 *
 * 判据里每条 `assert` 都带 label：不成立时读到的是"哪一类对不上"，不是
 * `false !== true`。`sink.error` 是出口——后半句"屏上会说什么"还要用这个错误对象。
 */
function apiIs(expected, label, sink = {}) {
  return (error) => {
    assert.ok(error instanceof ApiError, `${label}：应当是 ApiError，实际 ${typeof error}`);
    if (expected.status !== undefined) {
      assert.equal(error.status, expected.status, `${label}：status 对不上`);
    }
    if (expected.code !== undefined)
      assert.equal(error.code, expected.code, `${label}：code 对不上`);
    if (expected.message !== undefined) {
      assert.equal(
        error.message,
        expected.message,
        `${label}：message 对不上（用户可能读到的就是它）`,
      );
    }
    sink.error = error;
    return true;
  };
}

// ---------------------------------------------------------------- 5xx：网关与服务端

test('网关 HTML 502：不许把 HTML 原文带到用户面前', async () => {
  // 形状：nginx/Cloudflare 挂掉时回的 HTML 错误页。它没有 code，message 只能是我们
  // 自己的兜底。透原文的后果是屏幕上出现一段 HTML。
  stubFetch({ status: 502, body: '<html><body>502 Bad Gateway</body></html>' });
  const sink = {};
  await assert.rejects(
    () => client().listBots(),
    apiIs({ status: 502, message: 'HTTP 502', code: undefined }, '网关 HTML 502', sink),
    '网关 HTML 502：不许把 HTML 原文带到用户面前',
  );
  const seen = sink.error;

  assert.ok(!seen.message.includes('<html'), 'HTML 原文一个字都不许出现在消息里');
  assert.equal(seen.code, undefined, '网关不会给类型化 code');

  const presentation = presentError(seen);
  assert.equal(presentation.detail, undefined, '没有 code 就没有"服务端说的原因"可透');
  assert.equal(canRetry(presentation), true, '网关抖一下是值得重试的');
});

test('5xx 带 message 但没有类型化 code：原文只留给诊断，不上屏', async () => {
  // 这条判据（`detailOf`）是"服务端原文什么时候能上屏"的唯一开关。放宽它，
  // 用户就会开始读到 `HTTP 500`、网关 HTML 这类对开发者才有用的话。
  stubFetch({ status: 500, body: '{"message":"HTTP 500"}' });
  const sink = {};
  await assert.rejects(
    () => client().listBots(),
    apiIs({ status: 500, message: 'HTTP 500' }, '没有类型化 code 的 5xx', sink),
    '没有类型化 code 的 5xx：原文只留给诊断，不上屏',
  );
  const seen = sink.error;

  assert.equal(seen.code, undefined);
  const presentation = presentError(seen);
  assert.equal(presentation.key, 'error.server');
  assert.equal(presentation.detail, undefined, '没有 code 的 message 永远不上屏');
  assert.equal(canRetry(presentation), true);
});

test('5xx 带 code，但 message 只是我们自己的兜底：一个字都不许上屏', async () => {
  // 两个闸门是"与"关系：有 `code` 才允许考虑透原文，而 `HTTP 500` 这类**我们自己拼的**
  // 兜底句即使陪着 code 也不许上屏——它不含任何用户能用的信息，读了只会以为是客户端的错。
  stubFetch({ status: 503, body: '{"code":"upstream_unavailable"}' });
  const sink = {};
  await assert.rejects(
    () => client().listSessions('b1'),
    apiIs(
      { status: 503, code: 'upstream_unavailable', message: 'HTTP 503' },
      '带 code 的兜底 503',
      sink,
    ),
    '带 code 但服务端没给可读原因的 5xx：原文不上屏',
  );
  const seen = sink.error;

  const presentation = presentError(seen);
  assert.equal(presentation.detail, undefined, '`HTTP 503` 是给开发者看的，不上屏');
  assert.equal(presentation.key, 'error.server');
  assert.equal(canRetry(presentation), true, '服务端自己有 code，但这一档仍然是"值得重试"');
});

test('5xx 带类型化 code：原文原样带出来，且不给重试', async () => {
  // 真实先例：编辑定时任务时另一个客户端改过这条（`schedule_write_conflict`）。
  // 重发还是同一个拒绝——给"重试"等于让用户去做一件我们已知不会成的事。
  stubFetch({
    status: 500,
    body: '{"message":"another client changed this schedule","code":"schedule_write_conflict"}',
  });
  const sink = {};
  await assert.rejects(
    () => client().updateSchedule('b1', 's1', { crs: 'x' }),
    apiIs({ status: 500, code: 'schedule_write_conflict' }, '带 code 的 5xx', sink),
    '带类型化 code 的 5xx：原因要原样带出来',
  );
  const seen = sink.error;

  const presentation = presentError(seen);
  assert.equal(presentation.detail, 'another client changed this schedule', '服务端说的原因要上屏');
  assert.equal(canRetry(presentation), false, '同一个请求再发一次还是被拒');
});

test('429 限流：单独一档，且可以重试', async () => {
  stubFetch({ status: 429, body: '{"message":"too many requests"}' });
  const sink = {};
  await assert.rejects(
    () => client().listSessions('b1'),
    apiIs({ status: 429 }, '限流', sink),
    '限流必须是 429，且单独成一档',
  );

  const presentation = presentError(sink.error);
  assert.equal(presentation.key, 'error.rateLimited');
  assert.equal(canRetry(presentation), true, '限流是"等一下再试"，不是"这条路没了"');
});

// ---------------------------------------------------------------- 4xx：业务拒绝

test('400 校验失败：不给重试（同一个请求再发一次还是被拒）', async () => {
  stubFetch({ status: 400, body: '{"message":"invalid message version tag"}' });
  const sink = {};
  await assert.rejects(
    () => client().updateSettings('b1', { a: 1 }),
    apiIs({ status: 400, message: 'invalid message version tag' }, '400 校验失败', sink),
    '400 校验失败：要把服务端的原话带出来',
  );

  const presentation = presentError(sink.error);
  assert.equal(presentation.key, 'error.rejected');
  assert.equal(canRetry(presentation), false);
});

test('409 冲突：带 code 时把服务端的原因上屏，仍然不给重试', async () => {
  // 与 5xx 同一个判据：`code` 是"这条错误有意被分辨过"的信号。
  stubFetch({
    status: 409,
    body: '{"message":"only chat sessions can be forked","code":"fork_not_allowed"}',
  });
  const sink = {};
  await assert.rejects(
    () => client().forkSession('b1', 's1'),
    apiIs({ status: 409, code: 'fork_not_allowed' }, '409 冲突', sink),
    '409 冲突：code 不许丢（它决定原因能不能上屏）',
  );

  const presentation = presentError(sink.error);
  assert.equal(presentation.detail, 'only chat sessions can be forked');
  assert.equal(canRetry(presentation), false);
});

test('403 权限不足：不给动作（换页、重试都不会好）', async () => {
  stubFetch({ status: 403, body: '{"message":"forbidden"}' });
  const sink = {};
  await assert.rejects(
    () => client().listFiles('b1', '/data'),
    apiIs({ status: 403 }, '403', sink),
    '403 不是网络问题，必须是 403',
  );

  const presentation = presentError(sink.error);
  assert.equal(presentation.key, 'error.forbidden');
  assert.equal(presentation.recovery, 'none', '给动作才是撒谎');
});

test('404 是"它不存在"，不是"网络坏了"：调用方据此说"文件没有了"', async () => {
  // 服务端对"路径不存在"只给 404（没有别的形状）。判成网络错误会让用户以为
  // 整个工作区都读不了，而其实只是那一个路径没了。
  stubFetch({ status: 404, body: '{"message":"no such path"}' });
  const sink = {};
  await assert.rejects(
    () => client().statFile('b1', '/data/missing.md'),
    apiIs({ status: 404 }, '文件不存在', sink),
    '404：文件不存在必须是 404',
  );
  const seen = sink.error;

  assert.equal(seen.isNetwork, false, '404 不是网络问题——isNetwork 只看 status 0');
  const presentation = presentError(seen);
  assert.equal(presentation.key, 'error.notFound');
  assert.equal(canRetry(presentation), false);
});

test('队列端点 404：是"这台部署没有这个能力"，不是离线', async () => {
  // 实测部署对 `/queue` 一律 404。把它判成网络故障，界面就会一直提示连不上，
  // 而真实结论是"运行中的发送按钮该回到停止语义"。
  stubFetch({ status: 404, body: '' });
  const sink = {};
  await assert.rejects(
    () => client().getSessionQueue('b1', 's1'),
    apiIs({ status: 404 }, '队列端点不存在', sink),
    '队列端点不存在时要是 404（能力探测靠它）',
  );

  assert.equal(
    sink.error.isNetwork,
    false,
    '判成离线就会去重连，而网络是好的——这台部署只是没有队列',
  );
});

// ---------------------------------------------------------------- 401：凭据

test('401 触发 onUnauthorized 恰好一次，并说清要重新登录', async () => {
  // 没有 refresh token：任意 401 都是"会话结束"。多触发一次会连着跳两次登录页。
  stubFetch({ status: 401, body: '{"message":"expired"}' });
  let calls = 0;
  const sink = {};
  await assert.rejects(
    () =>
      client({
        onUnauthorized: () => {
          calls += 1;
        },
      }).listBots(),
    apiIs({ status: 401 }, '401', sink),
    '401 必须抛出（上层据此清凭据回登录页）',
  );

  assert.equal(sink.error.isUnauthorized, true);
  assert.equal(calls, 1, '一次失败只许清一次凭据');
  const presentation = presentError(sink.error);
  assert.equal(presentation.key, 'error.unauthorized');
  assert.equal(presentation.recovery, 'signin', '这时候给"重试"是让人等到天亮');
});

test('refresh 上的 401：没有兜底续期，只能回登录页', async () => {
  // `/auth/refresh` 必须带未过期的 Bearer——过期就救不回来了。这条 401 与别处的
  // 401 语义相同，但路径不同，写漏了就会在"续期失败"那条路上静默转圈。
  stubFetch({ status: 401, body: '{"message":"token expired"}' });
  const sink = {};
  await assert.rejects(
    () => client().refresh(),
    apiIs({ status: 401 }, 'refresh 上的 401', sink),
    '续期失败必须以 401 抛出（不许静默返回一个空 token）',
  );

  assert.equal(sink.error.isUnauthorized, true);
  assert.equal(presentError(sink.error).recovery, 'signin');
});

test('服务端 5xx 不许触发 onUnauthorized（它抖一下不能把用户登出）', async () => {
  // 把 5xx 也当成"凭据失效"，用户会在服务端抖动的那几秒里被清掉 Keychain 赶回
  // 登录页——而他什么都没做错，重新登录也救不了那台服务端。
  stubFetch({ status: 502, body: '' });
  let calls = 0;
  await assert.rejects(
    () =>
      client({
        onUnauthorized: () => {
          calls += 1;
        },
      }).listBots(),
    apiIs({ status: 502 }, '5xx 时的凭据处理'),
    '5xx 必须抛出（但不算凭据问题）',
  );

  assert.equal(calls, 0, '只有 401 才配清凭据');
});

test('403 同样不许触发 onUnauthorized（凭据认得，只是没权限）', async () => {
  // 顺手把 403 也当成"登录过期"会让用户去重新登录，而登录之后依然是 403。
  stubFetch({ status: 403, body: '{"message":"forbidden"}' });
  let calls = 0;
  await assert.rejects(
    () =>
      client({
        onUnauthorized: () => {
          calls += 1;
        },
      }).listBots(),
    apiIs({ status: 403 }, '403 时的凭据处理'),
    '403 必须抛出（但不算凭据问题）',
  );

  assert.equal(calls, 0, '403 说明凭据是认得的');
});

// ---------------------------------------------------------------- 错误体形状

test('错误体用 error 字段（而不是 message）时也要读得出来', async () => {
  // 上游两种形状都出现过。少读一种，用户看到的就是"HTTP 500"这种零信息兜底。
  stubFetch({ status: 400, body: '{"error":"invalid cron expression"}' });
  await assert.rejects(
    () => client().createSchedule('b1', { crs: 'bad' }),
    apiIs({ status: 400, message: 'invalid cron expression' }, 'error 字段'),
    '错误体用 error 字段时也要读得出来',
  );
});

test('错误体没有任何可读字段：退回状态码兜底，不许编内容', async () => {
  stubFetch({ status: 500, body: '{}' });
  const sink = {};
  await assert.rejects(
    () => client().listBots(),
    apiIs({ status: 500, message: 'HTTP 500', code: undefined }, '空错误体', sink),
    '空错误体只能退回状态码兜底',
  );

  assert.equal(presentError(sink.error).detail, undefined);
});

test('错误体是 JSON 标量（不是对象）：不许让错误处理再崩一次', async () => {
  // `JSON.parse` 成功但拿到 `"boom"` / `null` 时，读 `.message` 会踩空。
  stubFetch({ status: 503, body: '"boom"' });
  await assert.rejects(
    () => client().listBots(),
    apiIs({ status: 503, message: 'HTTP 503' }, '标量错误体'),
    '标量错误体：归一化的责任在 client，不许把原始解析错误漏出去',
  );

  stubFetch({ status: 503, body: 'null' });
  await assert.rejects(
    () => client().listBots(),
    apiIs({ status: 503, message: 'HTTP 503' }, '错误体是 null'),
    '错误体是 null 时也不许让错误处理再崩一次',
  );
});

// ---------------------------------------------------------------- 传输层

test('网络层异常：归一成 status 0，且不许说成超时', async () => {
  // 超时也走 status 0（两个都没有 HTTP 状态码），所以区分靠 `code`。
  globalThis.fetch = async () => {
    throw new TypeError('Network request failed');
  };
  const sink = {};
  await assert.rejects(
    () => client().listBots(),
    apiIs({ status: 0, code: undefined }, '网络层异常', sink),
    '网络层异常要归一成 status 0 的 ApiError',
  );
  const seen = sink.error;

  assert.equal(seen.isNetwork, true);
  assert.equal(presentError(seen).key, 'error.network');
  assert.equal(canRetry(presentError(seen)), true);
});

test('请求超时：单独一档（不说"没有网络"），且仍然可重试', async () => {
  // 15 秒的超时是模块常量，等它真到点会让整个门禁变慢；所以这里**只把定时器压小**
  // （≥15s 的定时器改成 20ms），客户端自己的逻辑一行都不改。
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (handler, delay, ...rest) =>
    realSetTimeout(handler, typeof delay === 'number' && delay >= 15_000 ? 20 : delay, ...rest);
  try {
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new Error('The operation was aborted.')),
        );
      });

    const sink = {};
    await assert.rejects(
      () => client().listBots(),
      apiIs({ status: 0, code: 'timeout' }, '请求超时', sink),
      '超时必须抛出带 timeout 码的失败',
    );

    const presentation = presentError(sink.error);
    assert.equal(presentation.key, 'error.timeout', '超时不许说成"没有网络"（用户会去开关 Wi-Fi）');
    assert.equal(canRetry(presentation), true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('200 但响应体不是 JSON：必须抛出，不许静默当成"没有数据"', async () => {
  // 门户劫持 / 网关 200 + HTML 页时，静默返回 undefined 会让上层把一次失败的拉取
  // 渲染成"这台服务器上没有会话"——那是撒谎，而且没有任何日志线索。
  stubFetch({ status: 200, body: '<html><body>captive portal</body></html>' });

  await assert.rejects(
    () => client().listSessions('b1'),
    (error) => {
      assert.ok(
        !(error instanceof ApiError),
        '它不是服务端给的错误，不该被伪装成 ApiError（那会让人以为是 API 在拒绝）',
      );
      assert.ok(error instanceof SyntaxError, `应当是解析失败，实际 ${error?.name}`);
      return true;
    },
    '解析失败必须抛出去，让调用方 catch 得到',
  );
});

// ---------------------------------------------------------------- 队列与压缩（失败语义各异）

test('入队失败：原因与 code 都要带出来（闸门靠它们决定能不能原样重放）', async () => {
  // 入队是"用户以为排上了"的地方，失败必须能说出原因；而重放的前提是上层知道
  // 它是同一件事（同一个 invocation_id）。
  stubFetch({ status: 500, body: '{"message":"queue is full","code":"queue_full"}' });
  const sink = {};
  await assert.rejects(
    () => client().enqueueFollowUp('b1', 's1', '补一句', 'inv-9'),
    apiIs({ status: 500, code: 'queue_full', message: 'queue is full' }, '入队失败', sink),
    '入队失败要保留服务端的原因与码',
  );

  assert.equal(sink.error.isNetwork, false, '这不是网络问题——重连解决不了"队列满了"');
});

test('提成 steer 被拒（服务端不支持插话）：原因要原样上屏', async () => {
  stubFetch({
    status: 409,
    body: '{"message":"steer is not supported for this run","code":"steer_unsupported"}',
  });
  const sink = {};
  await assert.rejects(
    () => client().promoteQueueItem('b1', 's1', 'f1'),
    apiIs({ status: 409, code: 'steer_unsupported' }, '提成 steer 被拒', sink),
    '服务端拒绝插话时要能读出来',
  );

  assert.equal(presentError(sink.error).detail, 'steer is not supported for this run');
  assert.equal(canRetry(presentError(sink.error)), false, '同一轮里再点一次还是被拒');
});

test('删除队列项 404：那条已经不在了，这不是网络故障', async () => {
  // 另一个客户端（或服务端自己）已经把它取用/清掉了。判成网络错误会让界面提示
  // "连不上"，用户反复重试一个"已经没有的东西"。
  stubFetch({ status: 404, body: '{"message":"no such queue item"}' });
  const sink = {};
  await assert.rejects(
    () => client().deleteQueueItem('b1', 's1', 'follow-up', 'gone'),
    apiIs({ status: 404 }, '删除一个不存在的队列项', sink),
    '删除一个不存在的队列项要明确是 404',
  );

  assert.equal(sink.error.isNetwork, false);
  assert.equal(presentError(sink.error).key, 'error.notFound');
});

test('压缩不可用（类型化 code）：与"压缩失败"分开，不给重试', async () => {
  // 服务端明确说"这台部署现在没有能用来压缩的模型"——这不是失败，重试一百次也一样。
  stubFetch({
    status: 500,
    body: '{"message":"no compaction model configured","code":"compaction_model_unavailable"}',
  });
  const sink = {};
  await assert.rejects(
    () => client().compactSession('b1', 's1'),
    apiIs({ status: 500, code: 'compaction_model_unavailable' }, '压缩不可用', sink),
    '压缩不可用要带出服务端的码',
  );

  const presentation = presentError(sink.error);
  assert.equal(presentation.detail, 'no compaction model configured', '原因要给用户看');
  assert.equal(canRetry(presentation), false, '重试不能让它变得可用');
});

// ---------------------------------------------------------------- 凭据探针（契约是"给答案"）

test('probeAuth：401 说成"凭据没了"', async () => {
  // realtime 靠它把"握手失败"里的超时与 401 分开（close 事件的 reason 只是平台提示）。
  stubFetch({ status: 401, body: '{"message":"expired"}' });
  assert.equal(await client().probeAuth(), true);
});

test('probeAuth：服务端 5xx 不算凭据失效（不许把用户踢回登录页）', async () => {
  stubFetch({ status: 500, body: '{}' });
  assert.equal(await client().probeAuth(), false, '服务端故障时把人登出，是最冤的一次登出');
});

test('probeAuth：问不出来（网络失败）不等于"凭据坏了"，且不许抛给状态机', async () => {
  // 它的契约是"只回答一个问题，永远给得出答案"。抛出去会让 realtime 的
  // checkCredentials 收到一个未处理的 rejection。
  globalThis.fetch = async () => {
    throw new TypeError('Network request failed');
  };
  await assert.doesNotReject(async () => {
    assert.equal(await client().probeAuth(), false, '问不出来就往"重试"那边靠，绝不能当成凭据失效');
  }, '探针本身不许抛（它的契约是给一个答案）');
});

test('probeAuth：403 是权限问题，不是凭据失效', async () => {
  // 403 说明凭据是认得的（只是没权限）。按"凭据失效"处理会让人去重新登录，
  // 而重新登录之后依然是 403。
  stubFetch({ status: 403, body: '{"message":"forbidden"}' });
  assert.equal(await client().probeAuth(), false);
});

test('probeAuth：一切正常时返回 false（它就是"凭据被拒了吗"这一个问题）', async () => {
  const calls = stubFetch({ status: 200, body: '{"id":"u1"}' });
  assert.equal(await client().probeAuth(), false);
  assert.equal(calls[0].url, 'http://x/users/me', '问的必须是"我是谁"这个端点');
});
