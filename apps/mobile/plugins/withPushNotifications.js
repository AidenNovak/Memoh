#!/usr/bin/env node
/**
 * config plugin：声明推送需要的 entitlement（`aps-environment` + Time Sensitive）。
 *
 * ## 为什么必须走插件
 *
 * `apps/mobile/ios/` 是 `expo prebuild` 的产物且被 gitignore：手改
 * `Memoh/Memoh.entitlements` 会在下次 prebuild 时丢掉。而 `aps-environment` 是
 * **拿到 device token 的前提**（没有它 `registerForRemoteNotifications` 一律失败），
 * 所以它必须落在 app config 这一侧。
 *
 * ## `aps-environment` 为什么是两份文件
 *
 * 这个键的值就是 APNs 的服务器环境：`development` = sandbox、`production` = 生产。
 * 它**不能**按 `#if DEBUG` 在运行时改（entitlement 在签名时就烧进二进制了），也没有
 * "构建配置条件"可写在 plist 里，所以只有一条可靠做法：**一份 Debug 用、一份 Release 用**，
 * 靠 `CODE_SIGN_ENTITLEMENTS` 按配置切换。
 *
 * 只写 `development` 一份也能跑起来（Xcode 归档时会用 distribution profile 把值换成
 * production），但那样"生产环境"就是一件**碰巧**的事：本地 Release 构建会带着 development
 * 去连 sandbox。`aps-environment` 错了不报错，只是收不到——所以这里宁可变显式。
 *
 * ## 为什么不用 `withEntitlementsPlist`
 *
 * 它的文件路径取自**工程里已经写好的** `CODE_SIGN_ENTITLEMENTS`（默认看 Release 配置），
 * 而那个 setter（`ensureApplicationTargetEntitlementsFileConfigured`）是在 entitlements
 * 这个 base mod **被求值时**才跑的——也就是说 `ios.xcodeproj` 那一批 mod 跑的时候，工程里
 * 还没有这个设置（本轮实测：插件在 xcodeproj 阶段拿不到路径，prebuild 直接失败）。
 * 依赖 base mod 的求值顺序是脆的，所以这里自己写两份文件、自己设两个配置的设置：
 * 不依赖顺序，跑几遍结果都一样。
 *
 * 代价说清楚：另一个插件若用 `withEntitlementsPlist`，按 expo 的默认它会写到 **Release**
 * 那份（production）去。现在没有别的插件碰 entitlements；将来要加，请一并改这里。
 *
 * ## `UIBackgroundModes` 为什么**不**加 `remote-notification`
 *
 * 加了它就等于声明"我们会用静默推送在后台刷新内容"。契约里**没有**静默推送：三类事件
 * （审批等待 / 跑完 / 失败）都是用户可见的 alert + badge，`content-available` 一帧都不用。
 * 声明一个用不到的 background mode 有两个实际代价：App 审核会问它用来做什么，而这个能力
 * 一旦打开就不容易解释回去。
 *
 * 什么时候该加：服务端开始发 `content-available: 1` 的静默推送，并能说清它在后台要做什么。
 * 那时来这里加一项，并在 `docs/research/push-contract.md` 里写明白。
 */
const { withXcodeProject } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const APS_KEY = 'aps-environment';
/**
 * Time Sensitive 是**服务端远程推送**要用的键：payload 里的
 * `interruption-level: time-sensitive` 只有在 App 带着这个 entitlement、且 App ID 上
 * 开了「Time Sensitive Notifications」能力时才会被 APNs 认账。
 *
 * 依据（不是"顺手加一个"）：`src/features/notifications/policy.ts` 的
 * `interruptionLevelFor` 给"审批等待"定的就是 `timeSensitive`；App ID `ai.memoh.ios`
 * 已经开启该能力，Distribution profile 的 entitlements 里也确实带着这个键（真值）。
 * 少这一个键的表现同样是"不报错但收不到"——等级被系统降成 active。
 */
const TIME_SENSITIVE_KEY = 'com.apple.developer.usernotifications.time-sensitive';
/** 两份 entitlements：路径是相对 `ios/` 的（Xcode 的写法）。 */
const ENTITLEMENTS = {
  Debug: 'Memoh/Memoh.entitlements',
  Release: 'Memoh/Memoh.Release.entitlements',
};
const APS_ENVIRONMENT = { Debug: 'development', Release: 'production' };

function entitlementsFile(environment) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>${APS_KEY}</key>`,
    `  <string>${environment}</string>`,
    `  <key>${TIME_SENSITIVE_KEY}</key>`,
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withPushNotifications = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults;
    const iosRoot = config.modRequest.platformProjectRoot;

    // 1) 两份 entitlements 文件（值直接写死，不做变量替换：`aps-environment` 的值错了
    //    不报错，只是收不到，所以宁可它是字面量）。
    for (const [configuration, relative] of Object.entries(ENTITLEMENTS)) {
      const file = path.join(iosRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entitlementsFile(APS_ENVIRONMENT[configuration]), 'utf8');
    }

    // 2) 按配置把设置指过去。只改 App target：测试 target 不需要推送能力，
    //    给它一份 entitlements 只会多一个签名要维护的东西。
    const appTargetName = config.name;
    const configurations = project.pbxXCBuildConfigurationSection();
    const touched = new Set();
    for (const key of Object.keys(configurations)) {
      if (key.endsWith('_comment')) continue;
      const configuration = configurations[key];
      const settings = configuration.buildSettings;
      if (settings === undefined) continue;
      const name = String(configuration.name ?? '').replace(/^"|"$/g, '');
      const isAppTarget =
        String(settings.PRODUCT_BUNDLE_IDENTIFIER ?? '').includes('ai.memoh') ||
        String(settings.PRODUCT_NAME ?? '').replace(/^"|"$/g, '') === appTargetName;
      if (!isAppTarget) continue;
      const relative = ENTITLEMENTS[name];
      if (relative === undefined) continue;
      settings.CODE_SIGN_ENTITLEMENTS = relative;
      touched.add(name);
    }

    // 两个配置都必须被指到：少一个的表现是"生产构建带着 development 的 entitlement"
    // 或者"Debug 根本没有推送能力"，而这两种都不会在构建时报错。
    for (const name of Object.keys(ENTITLEMENTS)) {
      if (!touched.has(name)) {
        throw new Error(
          `withPushNotifications: 没找到 App target 的 ${name} 配置——` +
            '这样 aps-environment 会缺一个环境，而缺失不会在构建时报错，所以这里直接失败',
        );
      }
    }
    return config;
  });

module.exports = withPushNotifications;
module.exports.ENTITLEMENTS = ENTITLEMENTS;
module.exports.APS_ENVIRONMENT = APS_ENVIRONMENT;
