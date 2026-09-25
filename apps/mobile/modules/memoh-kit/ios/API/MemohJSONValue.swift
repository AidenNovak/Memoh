import Foundation

/// 动态 JSON 值——TS 里 `unknown` / `Record<string, unknown>` 的诚实镜像。
///
/// 为什么需要它：REST 里有一批端点**故意没有类型**（`tokenUsage`、`getSettings`、
/// `listSchedules`、`listFiles`…），TS 那边它们就是 `Record<string, unknown>`，RN 侧只把
/// 它们当"能显示的东西"透出去。给这些字段**发明**一个类型比保留动态更危险：猜出来的形状
/// 一旦和服务端不一致，解码整次失败（真机上是整屏红），而动态值至少能原样交给上层。
///
/// 保留未知键也是刻意的：它同时充当 parity 比对的载体——丢掉一个键就等于悄悄放过一处
/// 与 TS 的差异（见 `tools/test-api-contract.swift`）。
public enum MemohJSONValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: MemohJSONValue])
  case array([MemohJSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      // JSON 的 `null` 是**值**，不是"键不存在"。TS 那边 `JSON.parse` 也是这个语义；
      // 混掉之后 `{"a": null}` 与 `{}` 就分不出来了，而服务端的 omitempty 与显式 null
      // 恰好是两件事。
      self = .null
      return
    }
    // 顺序有意义：**Bool 必须在 Double 之前**。JSONDecoder 不会把 `1` 解成 `true`
    // （实测 `decode(Bool.self, from: "1")` 抛 typeMismatch），但先试 Double 的写法
    // 会把 `true` 交给数字那条路，依赖"它会抛"这个细节太脆。
    if let value = try? container.decode(Bool.self) {
      self = .bool(value)
      return
    }
    // 整数也走 `.number(Double)`：JSON 没有 int/double 之分，这里不发明区别。
    // 要不要写成整数形式是**编码**时的事（见 `encode(to:)`）。
    if let value = try? container.decode(Double.self) {
      self = .number(value)
      return
    }
    if let value = try? container.decode(String.self) {
      self = .string(value)
      return
    }
    if let value = try? container.decode([MemohJSONValue].self) {
      self = .array(value)
      return
    }
    if let value = try? container.decode([String: MemohJSONValue].self) {
      self = .object(value)
      return
    }
    throw DecodingError.dataCorruptedError(
      in: container,
      debugDescription: "不是可识别的 JSON 值（既不是 null/布尔/数字/字符串，也不是数组/对象）"
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case let .string(value):
      try container.encode(value)
    case let .number(value):
      // 整数值写成整数形式：把 `1` 编成 `1.0` 会让"往返相等"的比对全是噪声，
      // 而服务端与 TS 都不这么写。`Int64(exactly:)` 同时管住了"超出 Int64 范围"与
      // "不是整数"两种情况——放不下就老老实实按浮点写。
      if let integer = Int64(exactly: value) {
        try container.encode(integer)
      } else {
        try container.encode(value)
      }
    case let .bool(value):
      try container.encode(value)
    case let .object(value):
      try container.encode(value)
    case let .array(value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

// MARK: - 便利取值

extension MemohJSONValue {
  /// 以下是**不做隐式转换**的取值口：类型不对就是 `nil`，不把 `1` 当 `true`、也不把
  /// `"1"` 当 `1`。协议字段上做隐式转换正是 `avatar_url` 那次整屏红的同类错误——
  /// 猜出来的值比没有值更难查。
  public var stringValue: String? {
    if case let .string(value) = self { return value }
    return nil
  }

  public var numberValue: Double? {
    if case let .number(value) = self { return value }
    return nil
  }

  public var boolValue: Bool? {
    if case let .bool(value) = self { return value }
    return nil
  }

  public var objectValue: [String: MemohJSONValue]? {
    if case let .object(value) = self { return value }
    return nil
  }

  public var arrayValue: [MemohJSONValue]? {
    if case let .array(value) = self { return value }
    return nil
  }

  public var isNull: Bool {
    if case .null = self { return true }
    return false
  }
}
