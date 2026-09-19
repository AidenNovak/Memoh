// @ts-check
import vueParser from 'vue-eslint-parser'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

export default [
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  // internal/**/protocolref holds vendored protocol reference snapshots
  // (pinned verbatim; a freshness test diffs them against upstream).
  // apps/mobile is excluded: the iOS client ships its own config
  // (apps/mobile/eslint.config.js — Expo's rules plus React Native and Node
  // globals), which is not the Vue ruleset below. Scanning RN sources with it
  // only produces false positives; the iOS side runs through `pnpm ios:check`.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/cache/**', '**/target/**', '**/.toolkit/**', 'packages/sdk/src/**', 'internal/**/protocolref/**', 'apps/mobile/**'] },
  {
    files: ['packages/**/*.{js,jsx,ts,tsx}', 'apps/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        projectService: true,
      },
    },
    rules: {
      quotes: ['error', 'single'],
      semi: ['error', 'never'],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['apps/web/src/store/**/*.ts'],
    ignores: [
      'apps/web/src/store/workspace-tabs.ts',
      'apps/web/src/store/**/*.test.ts',
    ],
    rules: {
      'max-lines': ['error', {
        max: 600,
        skipBlankLines: true,
        skipComments: true,
      }],
    },
  },
  {
    files: ['packages/**/*.vue', 'apps/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parser: {
          js: 'espree',
          ts: tseslint.parser,
        },
      },
    },
    rules: {
      quotes: ['error', 'single'],
      semi: ['error', 'never'],
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      'vue/no-required-prop-with-default':'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
]
