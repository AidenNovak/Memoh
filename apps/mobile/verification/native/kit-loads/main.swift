// native.py `kit-loads` 检查。
//
// 断言 `apps/mobile/modules/memoh-kit` 的 Swift 源码能按 app 的 deployment target
// 编译、并且原生入口 `MemohKitModule` 被链进同一个二进制（AGENTS.md：所有一方原生
// 能力都通过它注册）。这个引用是刻意写成编译期引用：类型改名、模块被拆出去、或
// deployment target 被改坏，这个检查都会失败，而不是静默变成空检查。
//
// 目前 memoh-kit 还没有 Swift 源码，native.py 会把这条检查报成 skipped —— skip
// 不是 pass。等 kit 落地后，把 native.py 里 kit-loads 的 sources 收敛成明确的
// 文件清单（参考实现就是这么做的），避免把依赖 ExpoModulesCore 的文件也拖进来。
import Foundation
import UIKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
}

let entryPoint: Any.Type = MemohKitModule.self
guard String(describing: entryPoint).contains("MemohKitModule") else {
    fail("MemohKitModule resolved to \(entryPoint) instead of the kit entry point")
}

// 原生能力要通过 bridge 暴露给 JS，所以它必须是 ObjC-visible 的类。
guard entryPoint is AnyObject.Type else {
    fail("MemohKitModule is not a class; the bridge cannot export a value type")
}

print("ok MemohKitModule linked on iOS \(UIDevice.current.systemVersion)")
