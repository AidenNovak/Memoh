#!/usr/bin/env node
/**
 * config plugin：把 `locales/*.json` 投影成原生 `Localizable.xcstrings`。
 *
 * 为什么需要它：RN 侧有自己的 i18n，但系统控件（返回按钮、分享菜单、权限弹窗、
 * 文本选择）读的是原生字符串目录。两边各维护一份必然漂移，所以让 prebuild 从
 * 同一份 JSON 生成。
 *
 * 生成的 `ios/` 是 prebuild 产物、不入库；文案真源始终是 `locales/`。
 */
const { withXcodeProject, IOSConfig } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

/** 只有需要系统呈现的文案才投影到原生；其余交给 RN i18n。 */
const NATIVE_KEYS = [
  'app.name',
  'common.cancel',
  'common.done',
  'common.delete',
  'common.close',
  'common.retry',
  'settings.title',
  'settings.signOut',
  'login.title',
  'home.title',
  'chat.placeholder',
];

function readCatalog(projectRoot, file) {
  const filePath = path.join(projectRoot, 'locales', file);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildXcstrings(projectRoot) {
  const en = readCatalog(projectRoot, 'en.json');
  const zh = readCatalog(projectRoot, 'zh-Hans.json');

  /** @type {Record<string, unknown>} */
  const strings = {};
  for (const key of NATIVE_KEYS) {
    const enValue = en[key];
    const zhValue = zh[key];
    if (typeof enValue !== 'string') {
      throw new Error(`withLocales: locales/en.json is missing "${key}"`);
    }
    if (typeof zhValue !== 'string') {
      throw new Error(`withLocales: locales/zh-Hans.json is missing "${key}"`);
    }
    strings[key] = {
      extractionState: 'manual',
      localizations: {
        en: { stringUnit: { state: 'translated', value: enValue } },
        'zh-Hans': { stringUnit: { state: 'translated', value: zhValue } },
      },
    };
  }

  return {
    sourceLanguage: 'en',
    strings,
    version: '1.0',
  };
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withLocales = (config) =>
  withXcodeProject(config, (config) => {
    const projectRoot = config.modRequest.projectRoot;
    const iosRoot = config.modRequest.platformProjectRoot;

    const catalog = buildXcstrings(projectRoot);
    const outPath = path.join(iosRoot, config.name, 'Localizable.xcstrings');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

    // 把 xcstrings 挂进 Xcode 工程，否则不会参与本地化。
    const project = config.modResults;
    const groupName = config.name;
    const group = project.pbxGroupByName(groupName);
    const relativePath = `${groupName}/Localizable.xcstrings`;
    const alreadyAdded = Object.values(project.hash.project.objects.PBXFileReference ?? {}).some(
      (ref) => ref && ref.path === relativePath,
    );

    if (!alreadyAdded) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: relativePath,
        groupName,
        project,
        isBuildFile: true,
        verbose: false,
      });
    }

    if (!group) {
      // 只有真的没找到 group 才报错；addResourceFileToGroup 会在缺失时静默跳过。
      throw new Error(`withLocales: could not find Xcode group "${groupName}"`);
    }

    config.modResults = project;
    return config;
  });

module.exports = withLocales;
