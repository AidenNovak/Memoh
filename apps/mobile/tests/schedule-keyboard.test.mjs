/**
 * 定时编辑页的"键盘挡住必填项 → 字悄悄进错栏"（评审 B1 / §7.2）。
 *
 * ## 为什么这一条要在这里（而不是只靠真机）
 *
 * 用户侧的失败是**几何**：键盘升起时 `TextView` 那一栏有一截留在键盘底下，点它等于点在
 * 键盘上 → 焦点没换 → 接着打的字被追加进上一层仍是焦点的**描述**框，底部却挂着
 * `Can't save yet — Tell the agent what to do`。它在真机上复现了两次（e2e 的
 * `every wednesday at tenecho weekly` 与评审那条只读探针），而**门禁一直是绿的**——
 * 因为没有一条断言看得见"这一栏被挡住"这件事。
 *
 * 所以这里分两层：
 *
 * 1. **算术**（`features/schedule/keyboard.ts`）：还差多少才露出来——这是失败本身，
 *    边界一条条钉住（有/无键盘、刚好贴着、被盖一半、已经露全）。
 * 2. **接线**（读屏幕源码）：每一栏都必须能被聚焦、必填那一栏必须排在前面、校验失败必须
 *    **把人送到缺的那一栏**、点击必须落在输入框上而不是"块"上。这一层是**回归网**：
 *    这些线任何一条断了，用户看到的就是"点了没反应"或"字进了上一栏"，而屏幕上不会有
 *    任何报错。它是结构断言，不是行为断言的替代。
 *
 * ## 这一条**没有**真机证据（如实记）
 *
 * 评审 §7.2 那次最小复现用的是一条**一次性探针**（`b1-schedule-probe.yaml`，抄在
 * `verification/navigation/out/20260917-ux-review-round2/flows/`，`out/` 不进 Git），
 * 仓库里**没有**对应的常驻 flow。2026-09-17 22:0x 那台模拟器被另一个 agent 占着
 * （`Memoh` 跑在 8097 的 Metro 上），按"一次只跑一个重活"的纪律没有去抢，所以这一轮
 * 拿到的是断言级证据 + 变异（`tests/mutation-check.sh --list` 里 `schedule-` 前缀那两条），
 * **不是**一张新截图。要补的 flow：填完 description（键盘不收）→ 点 `What to do` →
 * 断言焦点真的换了、接着打的字进的是这一栏。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scrollOverlap, visibleBottom } from '../src/features/schedule/keyboard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN = join(HERE, '..', 'src', 'screens', 'ScheduleEditScreen.tsx');
const SOURCE = readFileSync(SCREEN, 'utf8');

/** 一部 iPhone 的窗口高度与安全区（值本身不重要，重要的是两个量之间的关系）。 */
const PHONE = { windowHeight: 852, bottomInset: 34 };
const SCREEN_BOTTOM = PHONE.windowHeight - PHONE.bottomInset; // 818

test('没有键盘：看得见的下边界是屏幕底（安全区以上）', () => {
  assert.equal(visibleBottom({ keyboardTop: null, ...PHONE }), SCREEN_BOTTOM);
});

test('键盘升起：下边界压到键盘顶边', () => {
  assert.equal(visibleBottom({ keyboardTop: 583, ...PHONE }), 583);
});

test('键盘只有一小条 / 外接键盘把屏幕让开了：仍是屏幕底说了算（不白滚一段）', () => {
  // 键盘顶边（820）在屏幕底（818）之下 —— 取更靠上的那一个。
  assert.equal(visibleBottom({ keyboardTop: 820, ...PHONE }), SCREEN_BOTTOM);
  assert.equal(visibleBottom({ keyboardTop: SCREEN_BOTTOM, ...PHONE }), SCREEN_BOTTOM);
});

test('这一栏整个在键盘上面：不滚（用户会看到页面自己动一下）', () => {
  assert.equal(scrollOverlap({ inputTop: 400, inputHeight: 44, limit: 583, gap: 12 }), 0);
});

test('这一栏下缘刚好贴着键盘顶边：滚一行间距，让边框不贴着键盘', () => {
  // 539 + 44 = 583 = 键盘顶边 → 只差那行间距。
  assert.equal(scrollOverlap({ inputTop: 539, inputHeight: 44, limit: 583, gap: 12 }), 12);
});

test('这一栏被键盘盖住一半：滚"被盖住的那一截 + 间距"（评审那条：框 500–588、键盘 583）', () => {
  // 500 + 88 = 588，比键盘顶边低 5pt —— 这正是评审探针量到的形状。
  assert.equal(scrollOverlap({ inputTop: 500, inputHeight: 88, limit: 583, gap: 12 }), 17);
});

test('滚完之后一定是整个露出来（不变量：贴着也要有间距）', () => {
  const cases = [
    { inputTop: 100, inputHeight: 88, limit: 583, gap: 12 },
    { inputTop: 500, inputHeight: 88, limit: 583, gap: 12 },
    { inputTop: 700, inputHeight: 88, limit: 583, gap: 12 },
    { inputTop: 700, inputHeight: 44, limit: SCREEN_BOTTOM, gap: 12 },
  ];
  for (const c of cases) {
    const overlap = scrollOverlap(c);
    assert.ok(overlap >= 0, '滚动量不能是负数');
    assert.ok(
      c.inputTop + c.inputHeight + c.gap - overlap <= c.limit + 0.001,
      `滚了 ${overlap} 之后仍贴在 ${c.limit} 之下：${JSON.stringify(c)}`,
    );
  }
});

test('每一栏都有句柄、都有焦点入口（少一处 = 那一栏点不动 / 收不到字）', () => {
  for (const field of ['name', 'description', 'command', 'pattern', 'maxCalls']) {
    assert.match(
      SOURCE,
      new RegExp(`inputs\\.current\\.${field} = node;`),
      `${field} 没有登记句柄：校验失败时送不过去、也没法滚到它`,
    );
  }
  // 单行那四栏走同一个 `Field`，它的 `onFocus` 把自己交回屏幕；
  // 多行的命令栏自己接（`onFieldFocus(inputs.current.command)`）。
  const singleLine = SOURCE.match(/onFocus=\{onFieldFocus\}/g) ?? [];
  assert.equal(singleLine.length, 4, `单行栏里接上焦点回调的应有 4 处，实际 ${singleLine.length}`);
  assert.match(SOURCE, /onFocus=\{\(\) => onFieldFocus\(inputs\.current\.command\)\}/);
});

test('必填的"What to do"排在其他栏前面（首屏可见 → 键盘弹起时它在键盘上面）', () => {
  const command = SOURCE.indexOf('inputs.current.command = node;');
  const pattern = SOURCE.indexOf('inputs.current.pattern = node;');
  assert.ok(command > 0 && pattern > 0, '两栏都该在源码里');
  assert.ok(command < pattern, '命令栏被挪到后面去了：键盘弹起时它又会被盖住（评审 B1 的原形）');
  // 它必须是**可聚焦的整块**：块本身不进无障碍树，否则里面的输入框会被整个折掉
  // （实测过：折掉之后 `schedule-field-command` 从视图树里消失）。
  assert.match(SOURCE, /testID="schedule-command-block"[\s\S]{0,400}?accessible=\{false\}/);
});

test('Return 键串联：名称 → 说明 → 要它做什么（换框不靠手指落在哪一帧的坐标上）', () => {
  assert.match(SOURCE, /returnKeyType="next"/);
  assert.match(SOURCE, /onSubmitEditing=\{\(\) => focusField\('description'\)\}/);
  assert.match(SOURCE, /onSubmitEditing=\{\(\) => focusField\('command'\)\}/);
});

test('每条校验失败都把人送到它说的那一栏（"缺哪一栏"和"改哪儿"必须是同一栏）', () => {
  const pairs = [
    ...SOURCE.matchAll(/t\('schedule\.error\.(\w+)'\)\);\n\s*focusField\('(\w+)'\);/g),
  ];
  assert.ok(pairs.length >= 4, `校验分支应至少 4 条，实际 ${pairs.length}`);
  for (const [, key, field] of pairs) {
    assert.equal(field, key, `schedule.error.${key} 把人送到了 '${field}' 那一栏`);
  }
});

test('不许用 automaticallyAdjustKeyboardInsets（它会让整块 sheet 点按失效）', () => {
  // 只查**代码**：文件头那段注释正是在解释"为什么不用它"，注释不算用法。
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !code.includes('automaticallyAdjustKeyboardInsets'),
    'ui/ApprovalPage.tsx 记过这个属性的坑：要用也只能在那一页单独验',
  );
});
