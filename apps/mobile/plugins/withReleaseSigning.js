#!/usr/bin/env node
/**
 * config plugin：去掉 Expo 模板在 **Release** 配置里写死的开发签名身份。
 *
 * ## 问题是什么
 *
 * `expo prebuild` 生成的 `Memoh.xcodeproj` 里，Release 配置带着这一行：
 *
 *     "CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";
 *
 * 于是 `xcodebuild archive` 会去找一份 **iOS App Development** 描述文件。开发描述文件
 * 必须绑定已注册设备，而这个团队**一台设备都没有**，所以命令行归档一律死在这条：
 *
 *     error: No profiles for 'ai.memoh.ios' were found: Xcode couldn't find any
 *            iOS App Development provisioning profiles matching …
 *
 * 用 Xcode 的 GUI 归档碰不到它（GUI 会在 Archive 动作里自己换成发行身份），所以这个坑
 * 只在 CLI / CI 上出现——正是我们上传 TestFlight 走的那条路。
 *
 * ## 为什么是"删掉"而不是"改成 Apple Distribution"
 *
 * 直接写 `CODE_SIGN_IDENTITY = "Apple Distribution"` 会和**自动签名**打架，实测报：
 *
 *     error: Memoh has conflicting provisioning settings. Memoh is automatically signed
 *            for development, but a conflicting code signing identity Apple Distribution
 *            has been manually specified.
 *
 * 自动签名的语义是"身份由描述文件决定"，此时再钉一个身份就是自相矛盾。把这一行**删掉**
 * 才是对的：Release 配置不再断言一个和团队现状（0 台设备）对不上的开发身份。
 *
 * ## 说清楚它**没有**解决什么（实测）
 *
 * 删掉之后，**裸跑 `xcodebuild archive` 仍然会要 iOS App Development 描述文件**、仍然
 * 失败——因为命令行不会像 Xcode GUI 的 Archive 动作那样自动切发行身份。CLI 必须在
 * archive 阶段显式给 `CODE_SIGN_STYLE=Manual`、发行身份、team 与 profile，然后再用同一
 * profile 导出。**不能先做未签名 archive 再指望 export 补齐**：那样 Xcode 会签出一个
 * 能安装但丢失 `aps-environment` 的 App。见仓库根 `memoh-ios-dev.md` 的「TestFlight 发布」。
 *
 * 所以这个插件的作用是**把工程里那句错的断言去掉**，不是修好 CLI 归档。
 *
 * ## 为什么不动 Debug
 *
 * `[sdk=iphoneos*]` 只作用于**真机/归档**；模拟器构建走 iphonesimulator SDK，根本读不到
 * 这个键。所以这个改动不影响模拟器构建路径，也不需要 Debug 那份
 * （本地真机调试就该用开发身份）。
 *
 * ## 签名本身怎么走
 *
 * 证书与描述文件不在这里生成，也不入库：命令行归档用 App Store Connect API key 现建
 * （`tools/asc-api.py`），签名材料放独立钥匙串。完整流程与判据见仓库根
 * `memoh-ios-dev.md` 的「TestFlight 发布」。
 */
const { withXcodeProject } = require('expo/config-plugins');

// pbxproj 里带 `[`/`*` 的 key 会被 xcode 库**连引号一起**当成 key 名（实测：
// `"CODE_SIGN_IDENTITY[sdk=iphoneos*]"`），所以两种写法都要认，否则会静默匹配不上。
const DEVELOPMENT_IDENTITY_KEYS = [
  'CODE_SIGN_IDENTITY[sdk=iphoneos*]',
  '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"',
];
const RELEASE = 'Release';

const withReleaseSigning = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults;
    const configurations = project.pbxXCBuildConfigurationSection();
    let touched = 0;

    // 这一行落在**工程级**配置（`83CBBA21…` 那类，没有 PRODUCT_BUNDLE_IDENTIFIER），
    // 不是 app target 自己的配置里——所以这里不按 target 过滤：工程里任何 Release 配置
    // 带着它就删掉。Debug 不动（本地真机调试就该用开发身份）。
    for (const key of Object.keys(configurations)) {
      const configuration = configurations[key];
      const settings = configuration.buildSettings;
      if (settings === undefined) continue;
      const name = String(configuration.name ?? '').replace(/^"|"$/g, '');
      if (name !== RELEASE) continue;
      const present = DEVELOPMENT_IDENTITY_KEYS.find((candidate) => candidate in settings);
      if (present === undefined) continue;
      delete settings[present];
      touched += 1;
    }

    // 找不到就失败：这条设置一旦在模板里改名/挪位置，静默跳过会表现成"归档时又去找开发
    // 描述文件"，而那个错误离这里很远、很难联想到 prebuild。
    if (touched === 0) {
      throw new Error(
        `withReleaseSigning: 工程里没有任何 ${RELEASE} 配置带 ${DEVELOPMENT_IDENTITY_KEYS[0]}——` +
          '模板可能变了，请确认这一行是否还需要清掉（见本文件头注释）',
      );
    }
    return config;
  });

module.exports = withReleaseSigning;
module.exports.DEVELOPMENT_IDENTITY_KEYS = DEVELOPMENT_IDENTITY_KEYS;
