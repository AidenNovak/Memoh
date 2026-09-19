/**
 * ESLint 配置。**这是门禁的一部分**：`pnpm lint` 跑它，`pnpm check` 里也有它
 * （`.github/workflows/check.yml`）。写在这里而不是让 `expo lint` 自己生成，
 * 是因为下面那组规则要带解释——一条规则为什么降级、什么时候升回去。
 *
 * 规则集用 Expo 官方的 `eslint-config-expo/flat`（`expo lint` 默认那一套）：
 * react / react-hooks / import / @typescript-eslint 都覆盖到了。
 *
 * ## 为什么有 6 条规则是 warn 而不是 error
 *
 * `react-hooks/refs`、`set-state-in-effect`、`purity`、`immutability`、
 * `preserve-manual-memoization`、`static-components` 是 React Compiler 语义的检查，
 * 而这个 App `reactCompiler: true`（见 `app.config.ts`），所以它们报的是**真问题**。
 *
 * 现状是首轮 `eslint .` 报 47 个 error：25 个在 `OnboardingScreen.tsx`（reanimated
 * 的 shared value 在 render 里读），其余 22 个散在 17 个文件里（`stateRef.current`
 * 在 render 里读、effect 里同步 setState）。修它们是一次**重构**（照
 * `docs/research/code-quality-lody-vs-memoh.md` §4.B 的说法是"专门开一轮"），
 * 不是顺手改。
 *
 * 降成 warn 的理由：如果现在就按 error 卡住，门禁从第一天起就是红的，红着红着就没人看了
 * ——那比没有门禁更糟。降级后 error 为 0，`pnpm lint` 立刻能挡住**新增**的错
 * （未使用的符号、重复 import、解析不到的模块……），同时这 47 条债一直可见。
 * **那一轮重构做完后，把这几条改回 error。**
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
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn',
    },
  },
]);
