/**
 * 这一屏的**路由同步**与**出席钥匙**（拆 `ChatScreen` 时搬出来的纯逻辑）。
 *
 * ## 为什么这两件事要合起来钉
 *
 * 它们回答的是同一个问题：**"什么时候该有且只有一次"**。
 *
 * - 路由：`/chat/new` 上发出第一句之后，服务端建好会话，路由必须 `replace` 到
 *   `/chat/<id>`——**一次**。不换，用户看到的是"草稿消失、界面一片空白"（消息其实
 *   已经上路了）；换错（比如不是 `new` 路由也跟着换），会把用户正在读的那一屏顶掉。
 * - 审批 / 提问：服务端说"我在等你"，界面就弹出 sheet——**同一个待办只弹一次**。
 *   重复弹会在屏幕上叠出两个 sheet；不弹，run 会永久停在 `waiting_decision` 上。
 *
 * 两处的判据过去都埋在 `ChatScreen` 的 effect 里，只有真机才看得见。搬出来之后它们
 * 能被逐格断言（包括"不该发生的那些格"）。
 *
 * 反假绿：`tests/mutation-check.sh` 的 `route-replace-not-guarded-by-new` /
 * `approval-key-drops-approval-id`（改坏实现确认这两条会红）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatSessionId,
  createdSessionRoute,
  shouldOpenInfoOnMount,
  shouldOpenSession,
} from '../src/features/chat/route.ts';
import {
  approvalPresentationKey,
  userInputPresentationKey,
} from '../src/features/chat/presentation.ts';

test('chatSessionId：`new` 读空会话（服务端来建），其余读路由上那一条', () => {
  assert.equal(chatSessionId({ isNew: true, routeSessionId: 'new' }), '');
  assert.equal(chatSessionId({ isNew: false, routeSessionId: 's-42' }), 's-42');
});

test('shouldOpenSession：store 里打开的就是路由上那条时，不许再开一次', () => {
  // 再开一次会把正在流的内容清掉（store 的 openSession 是"换会话"）。
  assert.equal(
    shouldOpenSession({ isNew: false, routeSessionId: 's1', openSessionId: 's1' }),
    false,
  );
  assert.equal(
    shouldOpenSession({ isNew: false, routeSessionId: 's2', openSessionId: 's1' }),
    true,
  );
  // 还没打开过（null）→ 要开。
  assert.equal(
    shouldOpenSession({ isNew: false, routeSessionId: 's1', openSessionId: null }),
    true,
  );
  // `new` 没有会话可开——它在等第一次发送。
  assert.equal(
    shouldOpenSession({ isNew: true, routeSessionId: 'new', openSessionId: null }),
    false,
  );
  assert.equal(
    shouldOpenSession({ isNew: true, routeSessionId: 'new', openSessionId: 's9' }),
    false,
  );
});

test('createdSessionRoute：只有 `/chat/new` 上的新会话才换路由', () => {
  assert.equal(createdSessionRoute({ isNew: true, openSessionId: 's7' }), '/chat/s7');
  // 会话还没建好：没有目标可去。
  assert.equal(createdSessionRoute({ isNew: true, openSessionId: null }), null);
  /**
   不是 `new` 路由时**必须**什么都不做。

   这一格是真会踩的：切会话 / 重连重订阅都会让 `currentSessionId` 变，而这个 effect 的
   依赖里就有它——少了 `isNew` 这道闸，用户正在读的那一屏会被 `replace` 成同一条会话的
   另一份路由，表现为"读着读着页面自己跳了一下"。
   */
  assert.equal(createdSessionRoute({ isNew: false, openSessionId: 's7' }), null);
  assert.equal(createdSessionRoute({ isNew: false, openSessionId: null }), null);
});

test('shouldOpenInfoOnMount：`?info=1` 是验收种子，只在已有会话上生效', () => {
  assert.equal(shouldOpenInfoOnMount({ info: '1', isNew: false }), true);
  // 没有参数 / 别的值：不打开。
  assert.equal(shouldOpenInfoOnMount({ info: undefined, isNew: false }), false);
  assert.equal(shouldOpenInfoOnMount({ info: '0', isNew: false }), false);
  // 新会话没有会话信息可看（面板要 sessionId）。
  assert.equal(shouldOpenInfoOnMount({ info: '1', isNew: true }), false);
});

test('出席钥匙：同一个待办是同一把钥匙（只开一次）', () => {
  const first = approvalPresentationKey({ sessionId: 's1', approvalId: 'a1' });
  // effect 重跑、帧重发：钥匙必须**逐字**相同，否则屏幕上会叠出第二个 sheet。
  assert.equal(approvalPresentationKey({ sessionId: 's1', approvalId: 'a1' }), first);
});

test('出席钥匙：又来一个待办 / 换一个会话，钥匙必须变（该弹就弹）', () => {
  const base = approvalPresentationKey({ sessionId: 's1', approvalId: 'a1' });
  // 第二个审批不能被吞掉——用布尔的"有没有待办"就会吞。
  assert.notEqual(approvalPresentationKey({ sessionId: 's1', approvalId: 'a2' }), base);
  // 审批面板的参数里带着 sessionId（它要拿这个 id 去回应），钥匙少了这一段会撞车。
  assert.notEqual(approvalPresentationKey({ sessionId: 's2', approvalId: 'a1' }), base);
  /**
   审批与提问是**两个各自独立的 hook 调用**（`usePresentedPage` 各持一个 `inFlight` 集合），
   两边即使拼出同一个字符串也不会互相去重——所以这里不断言"两者不同"，那是在钉一个
   并不存在的契约。要钉的是**各自的**键：同一个 id 稳定、不同 id 分开。
   */
  assert.equal(
    userInputPresentationKey({ sessionId: 's1', userInputId: 'u1' }),
    userInputPresentationKey({ sessionId: 's1', userInputId: 'u1' }),
  );
  assert.notEqual(
    userInputPresentationKey({ sessionId: 's1', userInputId: 'u1' }),
    userInputPresentationKey({ sessionId: 's1', userInputId: 'u2' }),
  );
  assert.notEqual(
    userInputPresentationKey({ sessionId: 's1', userInputId: 'u1' }),
    userInputPresentationKey({ sessionId: 's2', userInputId: 'u1' }),
  );
});
