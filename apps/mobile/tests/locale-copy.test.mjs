/**
 * 两份文案表本身要守住的不变量（`locales/{en,zh-Hans}.json`）。
 *
 * `check-locales.mjs` 管的是"键对齐"，管不了"句子对不对"（键齐、值非空，
 * `1 items` 照样是错的）。这里补的那条，是**只有英文会踩、中文看不出来**的坑：
 *
 * **这个仓库刻意不引复数库**（`src/lib/i18n/index.ts`：中英都用 `{{count}}` 直接插值）。
 * 代价是英文句子不能把可数名词直接跟在数字后面——`1 items`、`1 messages`
 * 是最容易被当成机翻的细节，而且它只在参数恰好是 1 的那一次出现，人肉 review 抓不住。
 *
 * 判据是**形状**不是措辞：`count = 1` 时译文里不许出现 `1 + 复数名词`（`/\b1 \w+s\b/`）。
 * 中文不受影响（没有词形变化），所以这条只对英文有约束力，对中文是顺带跑一遍。
 *
 * 第二条（下面那条）反过来只盯中文：**中文值里不许出现英文单词**。两条合起来覆盖了
 * 本地化最常翻车的两个方向——"英文句子不合语法"和"中文句子没翻干净"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'locales');
const NAMES = ['en.json', 'zh-Hans.json'];

/** `1 items` / `1 messages` / `1 tasks` 这种形状。 */
const PLURAL_SHAPE = /\b1 \w+s\b/;

function catalogs() {
  return NAMES.map((name) => [name, JSON.parse(readFileSync(join(LOCALES, name), 'utf8'))]);
}

/** 只把 `{{count}}` 换成给定值，别的占位符原样留着（这条测试只关心 count）。 */
function renderCount(template, count) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name === 'count' ? String(count) : match,
  );
}

test('含 {{count}} 的句子在 count=1 时不许出现复数形状（我们没有复数规则）', () => {
  const problems = [];
  for (const [name, catalog] of catalogs()) {
    for (const [key, template] of Object.entries(catalog)) {
      if (!template.includes('{{count}}')) continue;
      const rendered = renderCount(template, 1);
      if (PLURAL_SHAPE.test(rendered)) problems.push(`${name}: ${key} → "${rendered}"`);
    }
  }
  assert.deepEqual(problems, [], `count=1 时读起来是病句：\n  ${problems.join('\n  ')}`);
});

/**
 * 第二条：**中文值里不许出现英文单词**。
 *
 * 为什么加这条：2026-09-17 这一轮修的问题集中在两类——"服务端/代码里的英文原值直接上屏"
 * （`Steering`、`Send now`、裸的 `Cron`）和"同一件事中英不一致"。两类**机器都能扫**：
 * 中文文案里出现一个连续 ≥2 个拉丁字母的词，只可能是三种情况——
 *
 *   1. 漏翻了（英文原值/半翻的句子留在中文表里）——要改文案；
 *   2. 专有名词或技术术语（产品名、协议名、代码符号）——进白名单，**逐条写明为什么**；
 *   3. 该统一却忘了统一（中英混着说同一件事）——要改文案。
 *
 * 判据是"词"不是"句子"：全大写的缩写（`URL` / `PDF` / `CPU` / `UDP` / `OLED`）**不算违规**。
 * 中文技术文案里写缩写是常态，禁掉它只会让人往白名单里塞垃圾，把这条测试变成噪音。
 * 同理，先剔除三类"不是人读的句子"的内容：`{{占位符}}` 名（`count` / `size` 是 key）、
 * URL 与协议示例（`https://…`）、路径段（`/data`）。
 */
const LATIN_WORD = /[A-Za-z][A-Za-z_]+/g;

/**
 * 白名单：这些英文词出现在中文表里是**对的**，附理由。新增一条前先问自己——
 * "这是专有名词/代码符号，还是我们没翻？"后者不该进这里。
 */
const ALLOWED_LATIN = new Map([
  ['Memoh', '产品名，中文句子里的品牌名不翻译'],
  ['App', 'iOS 自己的说法（苹果中文文档里就是「App」），全表 10 处一致'],
  ['iOS', '平台名，苹果自己不译'],
  ['Office', '文件格式名（`files.preview.kind.sheet`＝「Office 文档」）'],
  ['WebRTC', '协议名，写「实时画面传输协议」用户反而对不上号'],
  ['cron', '定时表达式的通行叫法（`schedule.field.pattern`＝「cron 表达式」）'],
  ['shell', '命令行术语（「不是一条 shell 命令」），译成「外壳」是错的'],
  [
    'token',
    'LLM 计量的通行叫法；中文表里「令牌」专指凭据（`onboarding.selfHosted.body`），两者不是一回事',
  ],
  ['workspace_read', '权限标识符，桌面端设置里就是这个字面量，改了用户搜不到'],
]);

/** 去掉"不是文案"的部分，剩下的才是人读的句子。 */
function prose(value) {
  return value
    .replace(/\{\{[^}]*\}\}/g, ' ') // 占位符名（count / size / time…）
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, ' ') // URL 与协议示例
    .replace(/\/[\w.-]+/g, ' '); // 路径段（/data）
}

test('中文值里不许出现英文单词（全大写缩写与白名单除外）', () => {
  const zhHans = JSON.parse(readFileSync(join(LOCALES, 'zh-Hans.json'), 'utf8'));
  const problems = [];
  for (const [key, value] of Object.entries(zhHans)) {
    for (const word of prose(value).match(LATIN_WORD) ?? []) {
      if (word === word.toUpperCase()) continue; // 缩写：URL / PDF / CPU…
      if (ALLOWED_LATIN.has(word)) continue;
      problems.push(`${key} → "${value}"（英文词：${word}）`);
    }
  }
  assert.deepEqual(problems, [], `中文表里混进了英文单词：\n  ${problems.join('\n  ')}`);
});
