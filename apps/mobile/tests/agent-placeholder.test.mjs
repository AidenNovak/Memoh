/**
 * "当前 agent 是谁"那个位置的兜底文案（`src/features/bots/label.ts`）。
 *
 * 这一组钉的是**一句话的三种处境**——以前的实现把它们混成了一句：
 * `currentBot === null ? t('home.empty.title')`，于是 `/bots` 拉不到时，屏幕（和读屏）
 * 上出现的是"还没有会话"：名词错了（会话 ≠ agent），语气也错了（空态 ≠ 拉不到）。
 *
 * 判据：`docs/research/ios-error-and-feedback.md` R41（拉取失败时显示"还没有内容"是撒谎）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/api/client.ts';
import { agentPlaceholderKey } from '../src/features/bots/label.ts';
import { presentError } from '../src/features/errors/present.ts';

test('还没拉到：说"正在加载"，不许说"还没有 agent"', () => {
  assert.equal(agentPlaceholderKey({ loading: true, failure: null }), 'common.loading');
});

test('拉失败：说"没拉到"，也不许说"还没有 agent"', () => {
  const failure = presentError(new ApiError(500, 'HTTP 500'));
  assert.equal(agentPlaceholderKey({ loading: false, failure }), 'bots.loadFailed');
});

test('拉到了但一个都没有：这才是空态', () => {
  assert.equal(agentPlaceholderKey({ loading: false, failure: null }), 'bots.empty');
});

test('失败优先于加载：重试期间继续显示错误，不闪回空态/加载态', () => {
  // `sessionsLoading` 立的那条纪律在这里同样成立：点重试的那一瞬间界面不许变样，
  // 否则看起来像"错误没了"，其实只是又发了一次请求。
  const failure = presentError(new ApiError(0, 'Network request failed'));
  assert.equal(agentPlaceholderKey({ loading: true, failure }), 'bots.loadFailed');
});

test('凭据失效也是"没拉到"，不是"没有 agent"', () => {
  const failure = presentError(new ApiError(401, 'expired'));
  assert.equal(agentPlaceholderKey({ loading: false, failure }), 'bots.loadFailed');
});

test('三种处境三个不同的 key：不许有两条路共用一句话', () => {
  const keys = new Set([
    agentPlaceholderKey({ loading: true, failure: null }),
    agentPlaceholderKey({ loading: false, failure: presentError(new ApiError(500, 'x')) }),
    agentPlaceholderKey({ loading: false, failure: null }),
  ]);
  assert.equal(keys.size, 3);
});
