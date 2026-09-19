// native.py `simulator-toolchain` 检查。
//
// 这是所有别的原生检查的前置条件：证明这台机器能按 app 的 deployment target
// 编译并运行 iOS 模拟器 Swift。它不碰产品代码，只在租约设备里断言运行时确实是
// iOS 26、UIKit 与 SF Symbols 可用、Dynamic Type 能算出字号。挂掉说明工具链或
// 目标写错了，而不是产品错了。
//
// 注意：这段代码跑在 `simctl spawn` 起来的裸进程里，没有 UIApplication 实例，
// 所以只用进程内可用的 UIKit API。
import Foundation
import UIKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
}

let version = UIDevice.current.systemVersion
guard version.hasPrefix("26.") else {
    fail("Simulator runtime is iOS \(version); this project targets iOS 26")
}

let body = UIFont.preferredFont(forTextStyle: .body)
guard body.pointSize > 0 else {
    fail("UIFont.preferredFont(forTextStyle: .body) has no size")
}

let family = UIFont.systemFont(ofSize: 17).familyName
guard !family.isEmpty else {
    fail("the system font has no family name")
}

guard UIImage(systemName: "checkmark") != nil else {
    fail("SF Symbols are unavailable in this runtime")
}

print("ok ios \(version) \(UIDevice.current.model) body \(body.pointSize)pt font \(family)")
