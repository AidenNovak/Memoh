#!/usr/bin/env node
/**
 * config plugin：往生成的 Xcode 工程里加一个 **hosted 单元测试 target**（MemohKitTests）。
 *
 * 为什么需要它：`modules/memoh-kit/verification/MessageListTests.swift` 里 UIKit 那一半
 * 断言（cell 复用、颜色映射、无障碍、贴底）只在 iOS 模拟器上能跑，但没有任何 target
 * 编译它们——一直是死代码。加一个 hosted target 让 `xcodebuild test` 能真正跑到。
 *
 * 为什么是 hosted（TEST_HOST = App）而不是独立 bundle：
 * - 测试要的 UIKit/XCTest 环境由宿主 App 提供，不用另起一份工程或 pod 图；
 * - hosted 测试跑在 App 进程里，行为最接近真实。
 *
 * 为什么源码直接编进测试 bundle、而不是依赖 MemohKit pod：
 * - MemohKit pod 通过 Expo autolinking 挂到 App target；再挂一份到测试 target 需要
 *   改 Podfile + 重新 pod install，而 Podfile 也是 prebuild 生成的，会来回打架；
 * - 直接编译 4 个 UIKit 源文件 + 测试文件，零 pod 依赖，prebuild 幂等。
 *
 * 为什么排除 `Chat/NativeMessageList.swift`：
 * - 它 `import ExpoModulesCore`（整棵 RN pod 图），独立编译不成立；
 * - 与 `tools/typecheck-kit.sh` 排除它的先例一致；它的贴底/锚点**数值**已由
 *   `MessageListMetrics` 的 17 个纯逻辑测试覆盖（`pnpm test:swift`）。
 *
 * `ios/` 是 prebuild 产物；本插件的改动随每次 prebuild 重新应用。
 */
const { withXcodeProject } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const TEST_TARGET = 'MemohKitTests';
const TEST_BUNDLE_ID = 'ai.memoh.kit-tests';

/**
 * 源文件按**目录**取，不写死清单。
 *
 * 踩过：清单是手写的，`MessageListFrameProbe.swift` 不在里面；只要往
 * `MessageCells.swift` 或测试里加一行引用探针符号的代码，`test:hosted` 就报
 * `cannot find 'MessageListFrameProbe' in scope`——红的是测试 target，不是真 Bug，
 * 但每次都要有人去手改清单。清单与实际文件不一致这件事本身就该被机制挡住。
 *
 * 现在的规则只有两条：
 * 1. `modules/memoh-kit/ios/**（递归）` 下所有 `.swift` 都编进来，**除了**文件里
 *    写了 `import ExpoModulesCore` 的——那些要整棵 RN pod 图，独立编译不成立
 *    （`NativeMessageList.swift` / `MemohKitModule.swift` / 通知的 AppDelegate 桥）。
 *    这条按**文件内容**判定，不维护例外名单，加了新文件也不会漏。
 * 2. `modules/memoh-kit/verification/**` 下的 `.swift` 都编进来，除了下表里显式
 *    写明"这属于别的套件"的。表里的条目如果在磁盘上已经不存在，prebuild 直接报错，
 *    免得它悄悄过期。
 *
 * 顺序无关。
 */
const SOURCE_ROOT = 'modules/memoh-kit/ios';
const TEST_ROOT = 'modules/memoh-kit/verification';

/** 编进测试 bundle 需要 `import ExpoModulesCore` 的文件，用这个判据自动排除。 */
const POD_ONLY_IMPORT = /^\s*import\s+ExpoModulesCore\b/m;

/** 属于**别的套件**的测试文件：键是相对 apps/mobile/ 的路径，值是为什么不上模拟器。 */
const OTHER_SUITES = {
  'modules/memoh-kit/verification/NotificationContractTests.swift':
    'Foundation-only 的纯逻辑层，跑 `pnpm test:swift`（vultr-sg 的 swift 镜像），不需要模拟器',
};

/** 源清单与磁盘不一致时，由测试 target 的 Run Script 阶段报出来。 */
const MANIFEST_DIR = '.memoh-kit-tests';
const MANIFEST_FILE = 'manifest.txt';
const REPORT_FILE = 'sources.txt';
const GUARD_PHASE_NAME = 'MemohKitSourcesGuard';

/** 递归取某个目录下的 `.swift`，返回按字节序排好的、相对 apps/mobile/ 的路径。 */
function swiftFilesUnder(mobileRoot, relativeRoot) {
  const absoluteRoot = path.join(mobileRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) {
    throw new Error(`withKitTests: ${relativeRoot} 不存在`);
  }
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.name.endsWith('.swift')) {
        found.push(path.relative(mobileRoot, absolute).split(path.sep).join('/'));
      }
    }
  };
  walk(absoluteRoot);
  // 交给 shell 的 `LC_ALL=C sort` 比对，所以这里用默认（码元序）排序，两边一致。
  return found.sort();
}

/** 按内容把源文件分成"能编进测试 bundle"和"要 ExpoModulesCore"两堆。 */
function classifySources(mobileRoot) {
  const compile = [];
  const excluded = new Map();
  for (const relative of swiftFilesUnder(mobileRoot, SOURCE_ROOT)) {
    const source = fs.readFileSync(path.join(mobileRoot, relative), 'utf8');
    if (POD_ONLY_IMPORT.test(source)) {
      excluded.set(relative, 'import ExpoModulesCore，独立编译不成立');
    } else {
      compile.push(relative);
    }
  }
  for (const relative of swiftFilesUnder(mobileRoot, TEST_ROOT)) {
    if (OTHER_SUITES[relative]) {
      excluded.set(relative, OTHER_SUITES[relative]);
    } else {
      compile.push(relative);
    }
  }
  for (const relative of Object.keys(OTHER_SUITES)) {
    if (!fs.existsSync(path.join(mobileRoot, relative))) {
      throw new Error(
        `withKitTests: 例外名单里的 ${relative} 已经不在磁盘上（${OTHER_SUITES[relative]}），把它从 OTHER_SUITES 删掉`,
      );
    }
  }
  return { compile, excluded };
}

/**
 * 落盘两份清单：
 * - `manifest.txt`：两个源目录下**所有** `.swift`（含被排除的），按字节序。构建时用
 *   同一套 `find` 重算一遍，不一致就说明 prebuild 之后有人动过文件，测试编的还是旧清单。
 * - `sources.txt`：给人看的，这份进测试 bundle、那份为什么没进。
 */
function writeManifests(iosRoot, onDisk, compile, excluded) {
  const directory = path.join(iosRoot, MANIFEST_DIR);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, MANIFEST_FILE), `${onDisk.join('\n')}\n`, 'utf8');
  const compiled = new Set(compile);
  const report = [
    '# 由 plugins/withKitTests.js 在 prebuild 时生成，不要手改。',
    '# compile = 编进 MemohKitTests 的源文件；exclude = 没编进去的，后面是原因。',
    ...onDisk.map((relative) =>
      compiled.has(relative)
        ? `compile  ${relative}`
        : `exclude  ${relative}  (${excluded.get(relative)})`,
    ),
    '',
  ];
  fs.writeFileSync(path.join(directory, REPORT_FILE), report.join('\n'), 'utf8');
}

/**
 * 测试 target 的第一个 build phase：把清单跟磁盘对一遍，不一致就红。
 *
 * 为什么需要它：prebuild 只在 `ios/` 不存在时才会跑（`verification/build.py`），
 * 所以"新加了一个 Swift 文件、但没重跑 prebuild"是常态。那时测试 bundle 编的还是
 * 旧清单，症状是 `cannot find 'X' in scope` 这种**看不出原因**的编译错。这里把它换成
 * 一句能照做的提示。
 */
function guardScript() {
  const manifest = `$SRCROOT/${MANIFEST_DIR}/${MANIFEST_FILE}`;
  return [
    'set -eu',
    'cd "$SRCROOT/.."   # apps/mobile',
    `manifest="${manifest}"`,
    'drift="${TMPDIR:-/tmp}/memoh-kit-tests-drift.txt"',
    'current="${TMPDIR:-/tmp}/memoh-kit-tests-current.txt"',
    'if [ ! -f "$manifest" ]; then',
    '  echo "error: 找不到 MemohKit 测试源清单 $manifest —— 先跑 pnpm prebuild。" >&2',
    '  exit 1',
    'fi',
    `find ${SOURCE_ROOT} ${TEST_ROOT} -type f -name '*.swift' | LC_ALL=C sort > "$current"`,
    'if ! diff -u "$manifest" "$current" > "$drift" 2>&1; then',
    '  echo "error: MemohKit 的 Swift 文件集在 prebuild 之后变了，MemohKitTests 编的还是旧清单。" >&2',
    '  echo "       跑 pnpm prebuild 让 plugins/withKitTests.js 重新取源文件，再重跑这次测试。" >&2',
    '  echo "       差异（- 清单里有 / + 只在磁盘上）：" >&2',
    '  cat "$drift" >&2',
    '  exit 1',
    'fi',
    'echo "MemohKitTests 源清单与磁盘一致（$(wc -l < "$manifest" | tr -d \' \') 个 Swift 文件）"',
  ].join('\n');
}

/** 把清单校验阶段插到测试 target 的**最前面**（在编译之前就该报出来）。 */
function addSourceGuardPhase(project, targetUuid) {
  const objects = project.hash.project.objects;
  objects.PBXShellScriptBuildPhase = objects.PBXShellScriptBuildPhase ?? {};
  const before = new Set(Object.keys(objects.PBXShellScriptBuildPhase));
  project.addBuildPhase([], 'PBXShellScriptBuildPhase', GUARD_PHASE_NAME, targetUuid, {
    shellPath: '/bin/sh',
    shellScript: guardScript(),
  });
  // 工程里本来就有别的 Run Script 阶段（Metro 打包那一类），所以按"新出现的 uuid"取，
  // 不能按 isa 扫第一个。
  const uuid = Object.keys(objects.PBXShellScriptBuildPhase).find(
    (key) => !key.endsWith('_comment') && !before.has(key),
  );
  if (!uuid) {
    throw new Error('withKitTests: 源清单校验阶段没建起来');
  }
  // 没有 outputPaths，Xcode 默认会因为"没有产物可判断"而每次都跑——正是我们要的。
  objects.PBXShellScriptBuildPhase[uuid].alwaysOutOfDate = 1;
  const phases = project.pbxNativeTargetSection()[targetUuid].buildPhases;
  const guard = phases.findIndex((entry) => (entry.value ?? entry) === uuid);
  phases.unshift(phases.splice(guard, 1)[0]);
}

/** 把 scheme 里 Testables 换成真实存在的测试 target（Expo 模板残留的 MemohTests 是幽灵）。 */
function rewriteTestables(schemePath, blueprintId) {
  const xml = fs.readFileSync(schemePath, 'utf8');
  const testable = [
    '<Testables>',
    '      <TestableReference',
    '         skipped = "NO">',
    '         <BuildableReference',
    '            BuildableIdentifier = "primary"',
    `            BlueprintIdentifier = "${blueprintId}"`,
    '            BuildableName = "MemohKitTests.xctest"',
    '            BlueprintName = "MemohKitTests"',
    '            ReferencedContainer = "container:Memoh.xcodeproj">',
    '         </BuildableReference>',
    '      </TestableReference>',
    '   </Testables>',
  ].join('\n');

  const replaced = xml.replace(/<Testables>[\s\S]*?<\/Testables>/, testable);
  if (replaced === xml) {
    throw new Error('withKitTests: scheme 里找不到 <Testables> 块，无法注入测试 target');
  }
  fs.writeFileSync(schemePath, replaced, 'utf8');
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withKitTests = (config) =>
  withXcodeProject(config, (config) => {
    const iosRoot = config.modRequest.platformProjectRoot;
    const mobileRoot = path.dirname(iosRoot);

    if (config.modResults.pbxTargetByName(TEST_TARGET)) {
      return config; // 幂等：prebuild 重跑不会重复加
    }

    const project = config.modResults;
    project.addTarget(TEST_TARGET, 'unit_test_bundle', null, TEST_BUNDLE_ID);
    // xcode 包的 addTarget 把 name 存成带引号（'"MemohKitTests"'），pbxTargetByName
    // 查不到；直接扫 section 取 uuid。
    const targetUuid = Object.keys(project.pbxNativeTargetSection()).find(
      (key) =>
        key.endsWith('_comment') === false &&
        String(project.pbxNativeTargetSection()[key].name).includes(TEST_TARGET),
    );
    if (!targetUuid) {
      throw new Error('withKitTests: 找不到新建的测试 target');
    }

    // 1) 先给 target 建 Sources phase——xcode 包 addTarget 建出来的 target
    //    buildPhases 是空的；不建的话 addSourceFile 会把文件塞进**第一个**
    //    匹配的 Sources phase（也就是 App target 的），测试文件就被编进 App 了。
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', targetUuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', targetUuid);

    // TEST_HOST 只设了路径，不构成显式依赖——不加这条，xcodebuild test 会
    // 在 App 二进制还没链接时就先链测试 bundle（实测：`library 'Memoh' not found`）。
    const appTargetUuid = Object.keys(project.pbxNativeTargetSection()).find(
      (key) =>
        key.endsWith('_comment') === false &&
        String(project.pbxNativeTargetSection()[key].name).replace(/^"|"$/g, '') === config.name,
    );
    if (appTargetUuid) {
      // xcode 包的 addTargetDependency 在 section 不存在时会静默跳过；
      // 这个工程没有 PBXContainerItemProxy（pods 用），先建空 section。
      const objects = project.hash.project.objects;
      objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};
      objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
      project.addTargetDependency(targetUuid, [appTargetUuid]);
    }

    // 2) 源码直接编进测试 bundle（不用 pod 依赖，见文件头说明）。
    //    清单按目录取（见文件头），取到什么编什么，不再有手写列表。
    const onDisk = [
      ...swiftFilesUnder(mobileRoot, SOURCE_ROOT),
      ...swiftFilesUnder(mobileRoot, TEST_ROOT),
    ].sort();
    const { compile, excluded } = classifySources(mobileRoot);
    writeManifests(iosRoot, onDisk, compile, excluded);
    const group = project.addPbxGroup([], TEST_TARGET, null);
    for (const rel of compile) {
      const relFromIos = path.relative(iosRoot, path.join(mobileRoot, rel));
      project.addSourceFile(relFromIos, { target: targetUuid }, group.uuid);
    }
    console.log(
      `withKitTests: ${compile.length} 个文件进测试 bundle，排除 ${excluded.size} 个（原因见 ios/${MANIFEST_DIR}/${REPORT_FILE}）`,
    );
    // 2b) 最前面插一道校验：清单和磁盘不一致就红（prebuild 之后动过源文件的话，
    //     测试 bundle 编的还是旧清单，那时候报错会让人看不出原因）。
    addSourceGuardPhase(project, targetUuid);

    // 3) hosted 测试的关键 build settings
    const configList =
      project.pbxXCConfigurationList()[
        project.pbxNativeTargetSection()[targetUuid].buildConfigurationList
      ];
    const confUuids = configList.buildConfigurations.map((entry) =>
      typeof entry === 'string' ? entry : entry.value,
    );
    for (const confUuid of confUuids) {
      const conf = project.pbxXCBuildConfigurationSection()[confUuid];
      Object.assign(conf.buildSettings, {
        GENERATE_INFOPLIST_FILE: 'YES',
        SWIFT_VERSION: '6.0',
        IPHONEOS_DEPLOYMENT_TARGET: '26.0',
        TEST_HOST: '"$(BUILT_PRODUCTS_DIR)/Memoh.app/Memoh"',
        BUNDLE_LOADER: '"$(TEST_HOST)"',
        TEST_TARGET_NAME: 'Memoh',
        PRODUCT_BUNDLE_IDENTIFIER: TEST_BUNDLE_ID,
        LD_RUNPATH_SEARCH_PATHS:
          '"$(inherited) @executable_path/Frameworks @loader_path/Frameworks"',
        FRAMEWORK_SEARCH_PATHS: '"$(inherited) $(PLATFORM_DIR)/Developer/Library/Frameworks"',
        OTHER_LDFLAGS: '"$(inherited) -framework XCTest"',
      });
      // addTarget 默认指向一个不存在的 Info.plist；用 GENERATE_INFOPLIST_FILE 代替。
      delete conf.buildSettings.INFOPLIST_FILE;
    }

    // 3) scheme：把幽灵 MemohTests 换成 MemohKitTests
    const schemePath = path.join(
      iosRoot,
      'Memoh.xcodeproj',
      'xcshareddata',
      'xcschemes',
      'Memoh.xcscheme',
    );
    rewriteTestables(schemePath, targetUuid);

    config.modResults = project;
    return config;
  });

module.exports = withKitTests;
