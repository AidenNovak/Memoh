import Foundation

/// 一次 REST 调用失败的原因。对应 TS 的 `ApiError`。
///
/// 为什么 `status: 0` 表示"传输层失败"而不是"没有状态码"：TS 那边就是这么定义的
/// （`isNetwork` 判 `status === 0`），超时与连不上都落到这里；401 与 500 是 HTTP 层的事。
/// 这个区别是调用方分流的唯一依据——"重试有用"（0）与"重试到天亮也没用"（401）
/// 处置完全相反，别把它们合并。
public struct MemohAPIError: Error, Equatable, Sendable {
  /// HTTP 状态码；**0 = 请求没走到 HTTP 层**（连不上 / 超时）。
  public let status: Int
  /// 服务端给的 `code`，或超时那条路的 `"timeout"`。
  public let code: String?
  public let message: String

  public init(status: Int, message: String, code: String? = nil) {
    self.status = status
    self.message = message
    self.code = code
  }

  /// 401 = 凭据失效，调用方应清凭据回登录页。
  public var isUnauthorized: Bool {
    status == 401
  }

  /// 传输层失败（连不上 / 超时），重试有意义。
  public var isNetwork: Bool {
    status == 0
  }
}

// MARK: - 映射

extension MemohAPIError {
  /// 超时的错误形状：`status: 0` + `code: "timeout"`。文案里带上毫秒数——"服务器没响应"
  /// 与"没有网络"在用户眼里是两句话，界面要能分开说。
  public static func timedOut(timeout: TimeInterval) -> MemohAPIError {
    let milliseconds = Int((timeout * 1000).rounded())
    return MemohAPIError(
      status: 0,
      message: "request timed out after \(milliseconds)ms",
      code: "timeout"
    )
  }

  /// 把网络层异常折成 `ApiError`（对齐 TS `send` 的 catch 分支）。
  ///
  /// TS 用的是 `error.message`；Swift 这边对应 `localizedDescription`——两者都是
  /// "平台给的原文"，不要去解析它（语言、措辞都随系统变），只用来显示。
  public static func transport(_ error: Error, timeout: TimeInterval) -> MemohAPIError {
    if isTimeout(error) { return timedOut(timeout: timeout) }
    return MemohAPIError(status: 0, message: error.localizedDescription)
  }

  /// 判断底层错误是不是"超时"。URLSession 抛的是 `URLError.timedOut`，但错误可能
  /// 已经被桥成 `NSError` 走过一圈，所以两条路都查。
  public static func isTimeout(_ error: Error) -> Bool {
    if let urlError = error as? URLError { return urlError.code == .timedOut }
    let nsError = error as NSError
    return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut
  }

  /// 响应体 → 错误（对齐 TS 的 `toApiError`）。
  ///
  /// 逐条：`message` 非空字符串优先，否则 `error`，都没有就是 `"HTTP <status>"`；
  /// `code` 只要响应体里有 `code` 字符串就用它（**空串也算**，TS 那边就是这个语义）。
  /// 响应体不是 JSON（网关的 HTML 错误页）时**保持默认文案**，不要在这里再抛一个
  /// 解码错误——那会把"服务端 500"说成"响应格式不对"，把真正的原因藏起来。
  public static func from(status: Int, body: Data) -> MemohAPIError {
    var message = "HTTP \(status)"
    var code: String?
    if let value = try? JSONDecoder().decode(MemohJSONValue.self, from: body),
       case let .object(fields) = value {
      if case let .string(text)? = fields["message"], !text.isEmpty {
        message = text
      } else if case let .string(text)? = fields["error"], !text.isEmpty {
        message = text
      }
      if case let .string(raw)? = fields["code"] {
        code = raw
      }
    }
    return MemohAPIError(status: status, message: message, code: code)
  }
}
