/**
 * ESLint 配置。**这是门禁的一部分**：`pnpm lint` 跑它，`pnpm check` 里也有它
 * （`.github/workflows/check.yml`）。写在这里而不是让 `expo lint` 自己生成，
 * 是因为下面那组规则要带解释——一条规则为什么降级、什么时候升回去。
 *
 * 规则集用 Expo 官方的 `eslint-config-expo/flat`（`expo lint` 默认那一套）：
 * react / react-hooks / import / @typescript-eslint 都覆盖到了。
 *
 * ## 为什么 `set-state-in-effect` 暂时是 warn
 *
 * React Compiler 语义规则报的是**真问题**，而这个 App `reactCompiler: true`
 *（见 `app.config.ts`）。`refs` / `purity` / `immutability` /
 * `preserve-manual-memoization` / `static-components` 已完成重构，继续按 error 卡门禁。
 *
 * 还剩 12 个 `set-state-in-effect`：都是“外部输入/路由/异步结果变化后重置本地状态”的
 * 生命周期边界。它们不能机械挪到 render；正确修法分别是 keyed state、派生视图或把事件
 * 收进 reducer，并且要带对应交互证据。当前先保持 warning，让债可见且不诱导一次危险的
 * 批量改写。
 *
 * 新增的其它 Compiler 语义问题会直接失败；12 条存量重置点仍逐条显示具体文件与行号。
 * 等它们各自有行为测试后，再把最后这一条升回 error。
 */
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      // prebuild 产物，从不手改（见 AGENTS.md）。
      'ios/**',
      '.expo/**',
      // 验收产物（截图/录屏/构建中间物），不是源码。
      'verification/.artifacts/**',
      'verification/**/out/**',
    ],
  },
  {
    /**
     * 验收基建、工具脚本、config plugin、单测都是 **Node** 程序
     * （`node verification/fixture/server.mjs`、`node --test tests/*.mjs`），
     * 而 Expo 的配置按 React Native 环境给全局量。不声明 Node 全局的话，
     * 光 `verification/fixture/server.mjs` 里的 `Buffer` 就会被报成 19 个 no-undef
     * ——那是环境没配对，不是代码有问题。
     */
    files: [
      'verification/**/*.{js,mjs}',
      'scripts/**/*.{js,mjs}',
      'tests/**/*.mjs',
      'plugins/*.js',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      'react-hooks/refs': 'error',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      'react-hooks/static-components': 'error',
    },
  },
]);
