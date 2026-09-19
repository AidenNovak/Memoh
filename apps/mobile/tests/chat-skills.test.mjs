/**
 * 技能清单的取数（`src/features/chat/skills.ts`）。
 *
 * 这一组盯的是**一件很容易做错的事**：拉失败时 `skills` 也是空数组，于是"没拉到"和
 * "这台 bot 没有技能"在界面上长得一模一样——用户会以为自己的技能被删了。
 * 所以失败必须留下痕迹（`failure`），而**失败还不能进缓存**（否则一次网络抖动会把这台
 * bot 的技能永久判死）。
 *
 * 判据出处：`docs/research/ios-error-and-feedback.md` R41 / R19。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/api/client.ts';
import { loadSkills, resetSkillCache } from '../src/features/chat/skills.ts';

const BOT = 'bot-skills-test';

function clientOf(handler) {
  return { listSkills: handler };
}

test('拿到了：技能进菜单，failure 为 null', async () => {
  resetSkillCache();
  const catalog = await loadSkills(
    clientOf(async () => ({
      skills: [{ name: 'pdf', description: '读 PDF' }],
    })),
    BOT,
  );
  assert.deepEqual(catalog.skills, [{ name: 'pdf', description: '读 PDF' }]);
  assert.equal(catalog.failure, null);
});

test('拿到了但是空清单：failure 也是 null（"这台 bot 没有技能"是真话）', async () => {
  resetSkillCache();
  const catalog = await loadSkills(
    clientOf(async () => ({})),
    BOT,
  );
  assert.deepEqual(catalog.skills, []);
  assert.equal(catalog.failure, null);
});

test('拉失败：skills 是空的，但 failure 说得出原因——不许当成"没有技能"', async () => {
  resetSkillCache();
  const catalog = await loadSkills(
    clientOf(async () => {
      throw new ApiError(500, 'HTTP 500');
    }),
    BOT,
  );
  assert.deepEqual(catalog.skills, []);
  assert.deepEqual(catalog.failure, { key: 'error.server', recovery: 'retry' });
});

test('没权限（403）：说了原因，但**不可重试**（重试一百次还是 403）', async () => {
  resetSkillCache();
  const catalog = await loadSkills(
    clientOf(async () => {
      throw new ApiError(403, 'forbidden');
    }),
    BOT,
  );
  assert.equal(catalog.failure?.recovery, 'none');
});

test('凭据失效（401）：动作是重新登录，不是重试', async () => {
  resetSkillCache();
  const catalog = await loadSkills(
    clientOf(async () => {
      throw new ApiError(401, 'expired');
    }),
    BOT,
  );
  assert.equal(catalog.failure?.recovery, 'signin');
});

test('失败不进缓存：下一次调用真的会再打一次服务端', async () => {
  resetSkillCache();
  let calls = 0;
  const flaky = clientOf(async () => {
    calls += 1;
    if (calls === 1) throw new ApiError(0, 'Network request failed');
    return { skills: [{ name: 'pdf', description: '' }] };
  });

  const first = await loadSkills(flaky, BOT);
  assert.equal(first.failure?.key, 'error.network');

  const second = await loadSkills(flaky, BOT);
  assert.equal(calls, 2, '失败不该被缓存住，否则一次抖动等于永久没有技能');
  assert.equal(second.failure, null);
  assert.equal(second.skills.length, 1);
});

test('成功进缓存：同一个 bot 不重复打服务端', async () => {
  resetSkillCache();
  let calls = 0;
  const client = clientOf(async () => {
    calls += 1;
    return { skills: [{ name: 'pdf', description: '' }] };
  });

  await loadSkills(client, BOT);
  await loadSkills(client, BOT);
  assert.equal(calls, 1);
});

test('没有名字的条目被丢掉：菜单里不许出现一个空白的 "/"', async () => {
  resetSkillCache();
  const catalog = await loadSkills(
    clientOf(async () => ({
      skills: [
        { name: '  ', description: '空名字' },
        { name: 'pdf', description: '' },
      ],
    })),
    BOT,
  );
  assert.deepEqual(
    catalog.skills.map((skill) => skill.name),
    ['pdf'],
  );
});

test('形状不对（skills 不是数组）：当作空清单，但**不**编造失败', async () => {
  resetSkillCache();
  const catalog = await loadSkills(
    clientOf(async () => ({ skills: 'oops' })),
    BOT,
  );
  assert.deepEqual(catalog.skills, []);
  assert.equal(catalog.failure, null);
});

test('没有 client / 没有 bot：什么都不发，也不算失败', async () => {
  resetSkillCache();
  const catalog = await loadSkills(null, BOT);
  assert.deepEqual(catalog, { skills: [], failure: null });
  const noBot = await loadSkills(
    clientOf(async () => ({ skills: [] })),
    null,
  );
  assert.deepEqual(noBot, { skills: [], failure: null });
});
