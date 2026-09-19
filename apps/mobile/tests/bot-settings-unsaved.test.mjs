/**
 * bot 设置页「改动会静默丢失」这条（评审 F1）。
 *
 * ## 用户怎么丢的
 *
 * 保存键在**长表单最底**、写着 `Done`，而返回键一直在手边。改完第一栏想走人时，
 * 用户看到的是一句 iOS 语义里的"我看完了"；真按下去（或侧滑回去）**改动无声消失**——
 * 没有任何提示，他下次打开才发现名字没变回去。
 *
 * ## 为什么这一条要在这里（而不是只靠真机）
 *
 * 修法的每一半都是**结构性**的，而且每一半单独拆掉，用户看到的就正是那个失败形态：
 *
 * 1. 保存条**只在有改动时出现**、且**画在 ScrollView 外面**——拆掉它，保存键又回到
 *    "要滚十几屏才够得到"；
 * 2. 返回键与侧滑**都要先问一句**——拆掉它，改动又是静默丢失；
 * 3. "存完再走"**必须等保存真的成功**——拆掉它，保存失败也会走掉，用户以为存上了。
 *
 * 真机上这三条同时要一台设备 + 一次合成点击才能碰到（评审 §5.2 记过：`bot-settings-save`
 * 那条 flow 在 maestro 装 driver 时就挂了）。所以这里读源码把这些**接线**钉住，
 * 并配 `tests/mutation-check.sh` 的五条变异（改坏实现看它变红，`--list` 里带
 * `bot-settings-` 前缀的那几条）。
 *
 * ## 这一条**没有**真机证据（如实记）
 *
 * `verification/navigation/botsettings-flow.yaml` 只走到"按一下保存键、看固定服务端收到的
 * 差分"（它断言的是落库，不是这一条）。**"带着未保存改动离开"这一半在设备上没有验过**
 * ——2026-09-17 22:0x 那台模拟器被另一个 agent 占着（`Memoh` 进程跑在 8097 的 Metro 上），
 * 按"一次只跑一个重活"的纪律没有去抢。要补的话是一条新 flow：改一栏 → 按返回 → 断言弹窗
 * 出现、且选"放弃"之后列表里的名字还是旧的。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const SCREEN = join(MOBILE, 'src', 'screens', 'BotSettingsScreen.tsx');
const SOURCE = readFileSync(SCREEN, 'utf8');

/** 去掉注释：文件头与行内注释里正是在解释"为什么不用 Done"，那不算用法。 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function catalog(name) {
  return JSON.parse(readFileSync(join(MOBILE, 'locales', name), 'utf8'));
}

// ------------------------------------------------ ① 有未保存的改动，用户看得见

test('"脏"只有一个判据：patchFrom 说改了才算改（不许另立一套 state）', () => {
  assert.match(
    CODE,
    /const patch = useMemo\(\s*\(\) => \(bot === null \|\| draft === null \? null : patchFrom\(bot, settings, draft\)\)/,
  );
  assert.match(CODE, /const dirty = patch !== null;/);
});

test('保存条画在 ScrollView 外面：长表单滚到哪儿它都在', () => {
  const scrollEnd = CODE.indexOf('</ScrollView>');
  const bar = CODE.indexOf('testID="bot-settings-save-bar"');
  assert.ok(scrollEnd > 0, '找不到 ScrollView 的收尾——这一条断言的前提没了');
  assert.ok(bar > 0, '保存条不见了：保存键又回到长表单最底');
  assert.ok(
    bar > scrollEnd,
    '保存条被放进 ScrollView 里了：它又会跟着表单滚走，用户改第一栏时够不到它',
  );
});

test('保存条只在有改动（或刚存上）时出现，没改动时整条不画', () => {
  assert.match(
    CODE,
    /\{dirty \|\| savedAt !== null \? \([\s\S]{0,2000}?testID="bot-settings-save-bar"/,
    '保存条的出现条件变了：常驻的禁用按钮既占位又误导（改前那颗 Done 就是这样）',
  );
  // 出现条件是 dirty || savedAt，保存按钮自己的出现条件必须是 dirty ——
  // 否则"刚存上"那一档会挂着一颗能再点一次的保存键。
  assert.match(CODE, /\{dirty \? \(\s*<Pressable\s+testID="bot-settings-save"/);
});

test('条上两句话都说得出：有改动 / 刚存上（离开前最后看到的就是这一行）', () => {
  assert.match(CODE, /\{dirty \? t\('botSettings\.unsaved'\) : t\('botSettings\.saved'\)\}/);
});

test('保存键的措辞是"提交改动"，不是 iOS 语义里的 Done', () => {
  const saveButton = CODE.slice(CODE.indexOf('testID="bot-settings-save"'));
  assert.match(saveButton.slice(0, 1200), /t\('botSettings\.save'\)/);
  assert.ok(
    !CODE.includes("t('common.done')"),
    '这一屏又出现了 Done：它在 iOS 语义里是"我看完了"，不是"把改动存下去"',
  );
});

// ------------------------------------------- ② 走人前必须问，且不许静默丢

test('返回键带着闸门（有未保存改动时先问一句）', () => {
  assert.match(
    CODE,
    /<BackButton testID="bot-settings-back" fallback="\/settings" guard=\{guardLeave\} \/>/,
  );
});

test('侧滑返回在脏的时候关掉（原生手势不经过我们，是改动无声消失的第二条路）', () => {
  assert.match(CODE, /navigation\.setOptions\(\{ gestureEnabled: !dirty \}\)/);
});

test('闸门的三条出路齐：留下 / 放弃 / 存完再走；不脏就直接放行', () => {
  assert.match(CODE, /if \(!dirty\) return true;/);
  assert.match(CODE, /t\('botSettings\.unsaved\.title'\)/);
  assert.match(CODE, /t\('botSettings\.unsaved\.discard'\)/);
  assert.match(CODE, /t\('botSettings\.unsaved\.save'\)/);
  assert.match(CODE, /\{ text: t\('common\.cancel'\), style: 'cancel' \}/);
  // 返回 false = "这一下不让走"（弹窗来接管这一趟）。
  assert.match(CODE, /\n    return false;\n  \}, \[dirty, leave, runSave, t\]\);/);
});

test('"存完再走"等的是保存真的成功：失败就留在这一页把原因摆出来', () => {
  assert.match(CODE, /void runSave\(\)\.then\(\(saved\) => \{\s*if \(saved\) leave\(\);\s*\}\);/);
  // `runSave` 只有走完两条写请求 + refreshBots 才返回 true；catch 里返回 false 且**不**离开。
  const runSave = CODE.slice(
    CODE.indexOf('const runSave = useCallback'),
    CODE.indexOf('const save = useCallback'),
  );
  assert.match(runSave, /setSavedAt\(Date\.now\(\)\);\s*return true;/);
  assert.match(
    runSave,
    /setError\(\{ presentation: presentError\(caught\), kind: 'save' \}\);\s*return false;/,
  );
  assert.ok(!/catch[\s\S]{0,400}?leave\(\)/.test(runSave), '保存失败不许顺手离开');
});

// ------------------------------------------------------------------ 文案

test('这两句话在中英两份表里都存在且非空', () => {
  for (const name of ['en.json', 'zh-Hans.json']) {
    const strings = catalog(name);
    for (const key of [
      'botSettings.unsaved',
      'botSettings.unsaved.title',
      'botSettings.unsaved.body',
      'botSettings.unsaved.discard',
      'botSettings.unsaved.save',
      'botSettings.save',
      'botSettings.saved',
    ]) {
      assert.ok(
        typeof strings[key] === 'string' && strings[key].trim() !== '',
        `${name} 缺这条文案：${key}`,
      );
    }
  }
});

test('"放弃"这句话说清了后果（离开就是保持原样），不是一句空洞的确认', () => {
  for (const name of ['en.json', 'zh-Hans.json']) {
    const body = catalog(name)['botSettings.unsaved.body'];
    assert.match(
      body,
      /before|原来的设置|原样/,
      `${name} 的 unsaved.body 没说清"离开之后会怎样"：${body}`,
    );
  }
});
