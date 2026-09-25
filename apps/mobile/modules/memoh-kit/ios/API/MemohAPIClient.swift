import Foundation

/// Memoh REST 客户端（`apps/mobile/src/api/client.ts` 的 Swift 版）。
///
/// 鉴权模型（务必记住，与 TS 版一致）：**没有 refresh token**。`/auth/refresh` 必须带
/// 未过期的 Bearer 才能续期；一旦过期只能重新登录。所以任意 401 都当成"会话结束"处理，
/// 通知上层清凭据回登录页——不要指望按 exp 判断就够，服务端每次请求还会查一次账号状态
/// （停用/删除会立刻 401，即使 token 未过期）。
public struct MemohAPIClient: Sendable {
  /// 去尾斜杠后的 baseURL。
  public let baseURL: String

  private let tokenProvider: @Sendable () -> String?
  private let onUnauthorized: (@Sendable () -> Void)?
  private let session: URLSession
  private let timeout: TimeInterval

  public init(
    baseURL: String,
    tokenProvider: @escaping @Sendable () -> String?,
    onUnauthorized: (@Sendable () -> Void)? = nil,
    session: URLSession = .shared,
    timeout: TimeInterval = 15
  ) {
    self.baseURL = MemohAPIClient.normalizeBaseURL(baseURL)
    self.tokenProvider = tokenProvider
    self.onUnauthorized = onUnauthorized
    self.session = session
    self.timeout = timeout
  }

  /// 去尾斜杠后的 baseURL（TS 的 `url` getter）。
  public var url: String {
    baseURL
  }

  /// 每次建连都要拿最新 token；不要在调用方缓存。
  public func token() -> String? {
    tokenProvider()
  }

  /// 把相对路径拼成绝对 URL。WebSocket 也用它。
  ///
  /// **不用** `URL(string:).appendingPathComponent`：它会做百分号编码与斜杠折叠，
  /// 与 TS 的裸字符串拼接不等价（`appendingPathComponent` 还会把 `//` 折成一个 `/`）。
  public func resolve(_ path: String) -> String {
    if path.hasPrefix("/") { return baseURL + path }
    return baseURL + "/" + path
  }

  /// 与 TS 的 `baseUrl.replace(/\/+$/, '')` 等价：去掉**所有**尾部斜杠。
  private static func normalizeBaseURL(_ raw: String) -> String {
    var value = raw
    while value.hasSuffix("/") { value.removeLast() }
    return value
  }
}

// MARK: - 逃生舱

extension MemohAPIClient {
  /// 打任意端点。给工具脚本与尚未成型的接口用。
  ///
  /// 有语义的接口都应该有具名方法——`request` 是逃生舱，不是主路。用它的时候顺手想一下
  /// "这个是不是该有个具名方法"。
  ///
  /// `body: nil` = **不发请求体**（也不带 `Content-Type`）；要发 JSON 的 `null` 就传 `.null`。
  public func request(
    _ method: String,
    _ path: String,
    body: MemohJSONValue? = nil
  ) async throws -> [String: MemohJSONValue]? {
    try await sendObject(method, path, body: body)
  }
}

// MARK: - 请求形状

/// query 的一个值。TS 那边是 `string | number`（`String(value)` 之后再编码）。
///
/// 数字只留 `Int`：TS 客户端里所有数值型 query（`limit` / `offset` / `before_message_id`）
/// 都是整数，而 `String(0.0)` 会写出 `"0.0"` —— 那不是 TS 的行为（`String(0)` 是 `"0"`），
/// 与其发一个服务端不认的值，不如让"要发小数"这件事在类型上就不可能。
public enum MemohQueryValue: Sendable, Equatable {
  case text(String)
  case number(Int)

  /// 编码前的原文（TS 的 `String(value)`）。
  var queryText: String {
    switch self {
    case let .text(value): return value
    case let .number(value): return String(value)
    }
  }
}

// 让调用点长得像 TS：`beforeMessageId: "msg-1"` / `beforeMessageId: 0` 都直接写。
extension MemohQueryValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral {
  public init(stringLiteral value: String) {
    self = .text(value)
  }

  public init(integerLiteral value: Int) {
    self = .number(value)
  }
}

/// query 的一对键值。
///
/// **用有序数组而不是字典**：TS 那边是对象字面量，`Object.entries` 按插入顺序拼 query，
/// 而顺序会进 URL（也进测试断言）；Swift 字典的顺序不稳定，用它等于把顺序变成偶然。
private typealias MemohQueryPair = (name: String, value: MemohQueryValue?)

/// 与 JS 的百分号编码等价的实现。
///
/// 为什么不直接用 `CharacterSet.urlQueryAllowed` / `.urlPathAllowed`：
/// - `urlQueryAllowed` **不转义 `+ & = ? %`**。用默认编码发一个含 `+` 的 cursor，服务端
///   （Go 的 `r.URL.Query()`）会把它解成空格 → **cursor 悄悄失效**，翻页永远翻不动，
///   而且没有任何报错。
/// - `.urlPathAllowed` 会**保留 `/`**，而 `encodeURIComponent` 不保留——拿它当替身会让
///   `/` 拼进路径段，等于换了个端点（`getBot("a/b")` 会打到 `/bots/a/b` 而不是 `/bots/a%2Fb`）。
///
/// 所以这里自己拼：只放行白名单里的 ASCII，其余一律 `%XX`（大写十六进制，UTF-8 字节）。
enum MemohPercentEncoding {
  /// `encodeURIComponent` 的等价集：`A-Za-z0-9-_.!~*'()`。
  private static let pathSegmentSafe = asciiSet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

  /// `URLSearchParams` 的等价集：字母数字 + `*-._`。
  ///
  /// 注意 `~` **不在**这里：WHATWG 的 urlencoded 序列化会把 `~` 写成 `%7E`，
  /// 而 `*` 是保留的（实测 node 的 `new URLSearchParams`）。
  private static let querySafe = asciiSet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._")

  /// 路径段（TS 里写了 `encodeURIComponent` 的地方）。
  static func pathSegment(_ value: String) -> String {
    encode(value, safe: pathSegmentSafe)
  }

  /// query 的键与值。
  ///
  /// **与 TS 的唯一已知差异**：空格编成 `%20`，而 `URLSearchParams` 用 `+`。
  /// 两者 Go 的 `r.URL.Query()` 都解成空格，但 `%20` 更不容易被中间层（代理、日志重写）
  /// 改写。契约测试里对这条差异有显式断言，见 `tools/test-api-contract.swift`。
  static func queryComponent(_ value: String) -> String {
    encode(value, safe: querySafe)
  }

  private static func asciiSet(_ characters: String) -> Set<UInt8> {
    Set(characters.utf8)
  }

  private static func encode(_ value: String, safe: Set<UInt8>) -> String {
    var out = ""
    out.reserveCapacity(value.utf8.count)
    for byte in value.utf8 {
      if safe.contains(byte) {
        out.append(Character(UnicodeScalar(byte)))
      } else {
        out += String(format: "%%%02X", Int(byte))
      }
    }
    return out
  }
}

// MARK: - 传输

extension MemohAPIClient {
  /// 一次请求的原始结果。`body == nil` 表示 204 或空响应体（对应 TS 的 `undefined`）。
  private func perform(
    _ method: String,
    _ path: String,
    body: MemohJSONValue?,
    query: [MemohQueryPair],
    authenticated: Bool
  ) async throws -> (status: Int, body: Data?) {
    var target = resolve(path)
    var pairs: [String] = []
    for item in query {
      guard let value = item.value else { continue }
      let text = value.queryText
      // TS：`value !== undefined && value !== ''` —— **空串被丢弃**，而 `0` 要发
      // （`String(0)` 是 `"0"`，别把它当假值丢掉）。
      if text.isEmpty { continue }
      pairs.append(
        "\(MemohPercentEncoding.queryComponent(item.name))=\(MemohPercentEncoding.queryComponent(text))"
      )
    }
    if !pairs.isEmpty { target += "?" + pairs.joined(separator: "&") }

    guard let url = URL(string: target) else {
      // TS 的 `new URL(...)` 会把路径里的空格之类自动编码，而 `URL(string:)` 直接返回 nil。
      // 这种 id 本来就不该出现（uuid / 数字），真出现时宁可当场报错，也不要拼一个
      // 与 TS 不一样的 URL 出去——那会打到另一个端点上。
      throw MemohAPIError(status: 0, message: "无法构造 URL：\(target)")
    }

    var request = URLRequest(url: url)
    request.httpMethod = method
    // 超时。没有它的话，一个半死不活的连接会让界面**永远转圈**，用户唯一的出路是杀 App。
    request.timeoutInterval = timeout

    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      // **只有**有体时才带 Content-Type（TS 同）。
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    if authenticated, let token = tokenProvider(), !token.isEmpty {
      // `if (token)`：空串 token 不发这个头（TS 同）。
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw MemohAPIError.transport(error, timeout: timeout)
    }

    guard let http = response as? HTTPURLResponse else {
      throw MemohAPIError(status: 0, message: "响应不是 HTTP 响应")
    }

    if !(200 ... 299 ~= http.statusCode) {
      let error = MemohAPIError.from(status: http.statusCode, body: data)
      // **只有这一处**触发 onUnauthorized，且只对"需要凭据的请求"触发：
      // `/auth/login` 自己回 401 是"密码错了"，不是"会话结束"，不能把用户踢回登录页。
      if error.isUnauthorized, authenticated { onUnauthorized?() }
      throw error
    }

    if http.statusCode == 204 { return (http.statusCode, nil) }
    if data.isEmpty { return (http.statusCode, nil) }
    return (http.statusCode, data)
  }

  /// 要 JSON 体并解成模型。
  private func sendDecoded<T: Decodable>(
    _ method: String,
    _ path: String,
    body: MemohJSONValue? = nil,
    query: [MemohQueryPair] = [],
    authenticated: Bool = true
  ) async throws -> T {
    let result = try await perform(method, path, body: body, query: query, authenticated: authenticated)
    guard let data = result.body else {
      throw MemohAPIError(status: result.status, message: "响应体为空，无法解码 \(T.self)")
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      // TS 那边响应体解不出 JSON 时抛的是原生 `SyntaxError`（不是 `ApiError`），形状不对时
      // 更是什么都不做（它是无类型的）。Swift 没有"非 Error 的解析异常"，所以折成
      // `status = HTTP 状态` 的 `MemohAPIError`：至少调用方能 catch 到、能打出文案，
      // 而 `isNetwork` / `isUnauthorized` 仍然是 false（没骗人）。
      throw MemohAPIError(status: result.status, message: "响应体解码失败：\(error)")
    }
  }

  /// 不要响应体的端点（`Promise<void>`）。
  private func sendVoid(
    _ method: String,
    _ path: String,
    body: MemohJSONValue? = nil,
    query: [MemohQueryPair] = [],
    authenticated: Bool = true
  ) async throws {
    _ = try await perform(method, path, body: body, query: query, authenticated: authenticated)
  }

  /// `Promise<Record<string, unknown>>` 的端点。空体 → `nil`（TS 的 `undefined`）。
  private func sendObject(
    _ method: String,
    _ path: String,
    body: MemohJSONValue? = nil,
    query: [MemohQueryPair] = [],
    authenticated: Bool = true
  ) async throws -> [String: MemohJSONValue]? {
    let result = try await perform(method, path, body: body, query: query, authenticated: authenticated)
    guard let data = result.body else { return nil }
    let value: MemohJSONValue
    do {
      value = try JSONDecoder().decode(MemohJSONValue.self, from: data)
    } catch {
      throw MemohAPIError(status: result.status, message: "响应体解码失败：\(error)")
    }
    switch value {
    case let .object(fields):
      return fields
    case .null:
      // TS 那边 `JSON.parse("null")` 得到 `null`，调用方一律当"没有"处理。这里折成
      // `nil`（"没有"），比抛一个形状错误更接近它的实际行为。
      return nil
    default:
      // TS 的类型说它是对象，运行时却可能是个数组/标量（类型是谎话）。这里当场报错，
      // 而不是悄悄返回一个空字典——后者会让"服务端换了形状"变成"这个 bot 没有设置"。
      throw MemohAPIError(status: result.status, message: "响应体不是 JSON 对象")
    }
  }

  /// `Promise<unknown>` 的端点。空体 → `nil`（TS 的 `undefined`）。
  private func sendUnknown(
    _ method: String,
    _ path: String,
    body: MemohJSONValue? = nil,
    query: [MemohQueryPair] = [],
    authenticated: Bool = true
  ) async throws -> MemohJSONValue? {
    let result = try await perform(method, path, body: body, query: query, authenticated: authenticated)
    guard let data = result.body else { return nil }
    do {
      return try JSONDecoder().decode(MemohJSONValue.self, from: data)
    } catch {
      throw MemohAPIError(status: result.status, message: "响应体解码失败：\(error)")
    }
  }
}

// MARK: - 会话信息 / 鉴权探针

extension MemohAPIClient {
  /// `GET /bots/{botId}/settings` —— bot 的运行时配置（模型、审批策略等）。
  ///
  /// **不转义 botId**：TS 这里就是裸插值（同一个端点的 `getBotSettings` 反而转义了）。
  /// 照抄，不要"顺手修正"——那会改变实际的请求路径。
  public func getSettings(botId: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject("GET", "/bots/\(botId)/settings")
  }

  public func updateSettings(
    botId: String,
    body: [String: MemohJSONValue]
  ) async throws -> [String: MemohJSONValue]? {
    try await sendObject("PUT", "/bots/\(botId)/settings", body: .object(body))
  }

  /// `GET /bots/{botId}/sessions/{sessionId}/status` —— 会话的消息数、上下文用量与
  /// cache 统计。
  ///
  /// 返回形状**按部署实测**（不是照上游类型抄）：这台部署只给 `used_tokens`，没有
  /// `context_window` / `budget_plan` / `compaction`。类型里把那些写成可选，界面据此
  /// 决定要不要显示百分比——**没有窗口就不算百分比**，算出来是编的。
  public func getSessionStatus(botId: String, sessionId: String) async throws -> SessionStatus {
    try await sendDecoded("GET", "/bots/\(botId)/sessions/\(sessionId)/status")
  }

  /// 凭据还有效吗？
  ///
  /// 只问一件事："服务端是不是明确说了 401"。返回 `true` = 凭据没了（要重新登录）。
  ///
  /// 为什么要它：WebSocket 握手失败时，**超时和 401 在客户端看起来一模一样**
  /// （都是一次没有升成 101 的失败），而两者的处置完全相反——超时要重试，401 重试到
  /// 天亮也没用。RN 把原生失败原因放在 close 事件的 `reason` 上，但那串文本是平台细节
  /// （不同实现给的内容不一样），不能当作唯一依据。所以再问一次这个有明确语义的 REST 端点：
  ///
  /// - 走到这里本身**没有副作用之外的意图**：401 会按既有契约触发 `onUnauthorized`
  ///   （清凭据回登录页），这正是我们想要的收敛点；
  /// - 网络断了的时候这次请求自己也会失败，返回 `false`——"问不出来"不等于"凭据坏了"，
  ///   宁可多试几次。
  public func probeAuth() async -> Bool {
    do {
      _ = try await sendObject("GET", "/users/me")
      return false
    } catch {
      guard let apiError = error as? MemohAPIError else { return false }
      return apiError.isUnauthorized
    }
  }
}

// MARK: - 会话队列

/// `GET .../queue` 的**线上形状**（TS `getSessionQueue` 里的内联类型）。
struct RawSessionQueue: Decodable {
  let followUp: [RawQueueItem]?
  let steer: [RawQueueItem]?
  /// **故意收成动态值**，不是 `Bool?`。
  ///
  /// TS 那边是 `raw.steer_supported === true`——一次**无类型**的比较：服务端发 `"true"`、
  /// `1` 或干脆不发，结果都是 `false`，而不是"解不出来"。写成 `Bool?` 会让 `"true"` 变成
  /// 整次解码失败（`typeMismatch`），那就把"这个部署不支持插话"说成了"接口坏了"。
  let steerSupported: MemohJSONValue?

  enum CodingKeys: String, CodingKey {
    case followUp = "follow_up"
    case steer
    case steerSupported = "steer_supported"
  }
}

extension MemohAPIClient {
  /// `GET /bots/{botId}/sessions/{sessionId}/queue` —— 两条队列一起拿。
  ///
  /// `steer_supported` 决定界面要不要给"插话"选项：不是所有运行形态都能被插话
  /// （服务端 `SteerSupported`）。宁可不给这个入口，也不要给了却必然失败。
  ///
  /// 这是**唯一一处**做了"线上形状 → 领域形状"转换的端点（见 `SessionQueue`）。
  public func getSessionQueue(botId: String, sessionId: String) async throws -> SessionQueue {
    let raw: RawSessionQueue = try await sendDecoded(
      "GET",
      "/bots/\(botId)/sessions/\(sessionId)/queue"
    )
    return SessionQueue(
      followUp: (raw.followUp ?? []).map { toQueueItem($0, kind: .followUp) },
      steer: (raw.steer ?? []).map { toQueueItem($0, kind: .steer) },
      // **严格等于 `true`**：`"true"` / `1` / 缺失都是 `false`（照抄 TS 的 `=== true`）。
      // 所以线上值先收成动态值再比，见 `RawSessionQueue.steerSupported` 的注释。
      steerSupported: raw.steerSupported == .bool(true)
    )
  }

  /// 照抄 TS 的 `toQueueItem`：缺字段用空串 / `0` 兜底，`kind` 由**所在数组**决定。
  private func toQueueItem(_ raw: RawQueueItem, kind: MemohQueueItemKind) -> QueueItem {
    QueueItem(
      itemId: raw.itemId ?? "",
      text: raw.text ?? "",
      position: raw.position ?? 0,
      status: raw.status ?? "",
      kind: kind
    )
  }

  /// `POST .../follow-up-queue` —— 这一轮跑完再跑（运行中发送的默认落点）。
  ///
  /// `invocationId` 是**幂等身份**：同一个发送手势重试必须带同一个 id，否则服务端会入两条。
  public func enqueueFollowUp(
    botId: String,
    sessionId: String,
    text: String,
    invocationId: String
  ) async throws -> RawQueueItem {
    try await sendDecoded(
      "POST",
      "/bots/\(botId)/sessions/\(sessionId)/follow-up-queue",
      body: .object(["invocation_id": .string(invocationId), "text": .string(text)])
    )
  }

  /// `POST .../steer-queue` —— 插进正在跑的那一轮，agent 立刻看到。
  public func enqueueSteer(
    botId: String,
    sessionId: String,
    text: String,
    invocationId: String
  ) async throws -> RawQueueItem {
    try await sendDecoded(
      "POST",
      "/bots/\(botId)/sessions/\(sessionId)/steer-queue",
      body: .object(["invocation_id": .string(invocationId), "text": .string(text)])
    )
  }

  /// 删掉一条还没被取用的队列项。**itemId 转义**（TS 同）。
  public func deleteQueueItem(
    botId: String,
    sessionId: String,
    kind: MemohQueueItemKind,
    itemId: String
  ) async throws -> MemohJSONValue? {
    let segment = kind == .steer ? "steer-queue" : "follow-up-queue"
    return try await sendUnknown(
      "DELETE",
      "/bots/\(botId)/sessions/\(sessionId)/\(segment)/\(MemohPercentEncoding.pathSegment(itemId))"
    )
  }

  /// 把一条 follow-up 提成 steer（"别等它跑完，现在就告诉它"）。**itemId 转义**（TS 同）。
  public func promoteQueueItem(
    botId: String,
    sessionId: String,
    itemId: String
  ) async throws -> RawQueueItem {
    try await sendDecoded(
      "POST",
      "/bots/\(botId)/sessions/\(sessionId)/follow-up-queue/\(MemohPercentEncoding.pathSegment(itemId))/steer"
    )
  }
}

// MARK: - 认证

extension MemohAPIClient {
  /// 唯一公开入口。成功后应把返回的 profile 落盘（refresh 不再返回这些字段）。
  public func login(username: String, password: String) async throws -> LoginResponse {
    try await sendDecoded(
      "POST",
      "/auth/login",
      body: .object(["username": .string(username), "password": .string(password)]),
      authenticated: false
    )
  }

  /// 需要当前 token 仍然有效。过期就救不回来了。
  public func refresh() async throws -> RefreshResponse {
    try await sendDecoded("POST", "/auth/refresh")
  }

  public func me() async throws -> Account {
    try await sendDecoded("GET", "/users/me")
  }
}

// MARK: - Bot

extension MemohAPIClient {
  public func listBots() async throws -> ListBotsResponse {
    try await sendDecoded("GET", "/bots")
  }

  /// 建一个 bot。
  ///
  /// ⚠️ **不要带 `wait_for_ready: true`**：服务端那条路会同步跑完整个容器生命周期
  /// （拉镜像 → 建工作区 → 就绪）才回响应，且服务端自己没有超时——任何一跳先超时都会让
  /// 客户端以为失败，而服务端其实还在建。所以这里发普通 JSON（拿 201 + `status: creating`），
  /// 再由调用方轮询到 `ready`。
  ///
  /// 另外注意路由：`POST /bots` 与 `GET /bots/name-availability` 都挂在 `/bots` 下，
  /// 但服务端的匹配是**精确**的，不会把 `name-availability` 当成 bot id。
  public func createBot(body: BotCreateRequest) async throws -> Bot {
    try await sendDecoded("POST", "/bots", body: try encodeBody(body))
  }

  /// 改 bot 的**本体**（`PUT /bots/{id}`）：显示名、头像、时区、启用状态。
  ///
  /// 只发要改的字段——服务端那边是 `Pointer` 语义（`*string` / `*bool`），没发的字段保持
  /// 原样。一次把全量字段回传会让"另一个客户端刚改过的字段"被覆盖掉。
  ///
  /// **botId 转义**（TS 同）。
  public func updateBot(botId: String, body: BotUpdateRequest) async throws -> Bot {
    try await sendDecoded(
      "PUT",
      "/bots/\(MemohPercentEncoding.pathSegment(botId))",
      body: try encodeBody(body)
    )
  }

  /// bot 的设置（`GET /bots/{id}/settings`）。**botId 转义**（TS 同）。
  ///
  /// 与 bot 本体分开：本体是身份（名字、头像），这里是行为（默认模型、语言、桌面开关）。
  /// 同端点的动态版是 `getSettings`（不转义）——TS 里两条都在，这里都留。
  public func getBotSettings(botId: String) async throws -> BotSettings {
    try await sendDecoded("GET", "/bots/\(MemohPercentEncoding.pathSegment(botId))/settings")
  }

  /// 改设置（`POST /bots/{id}/settings`）。**botId 转义**（TS 同）。
  ///
  /// 参考字段是**指针语义**：不传 = 保持，传 `""` = 清空。所以这里也尽量只发改过的字段。
  public func updateBotSettings(
    botId: String,
    body: [String: MemohJSONValue]
  ) async throws -> BotSettings {
    try await sendDecoded(
      "POST",
      "/bots/\(MemohPercentEncoding.pathSegment(botId))/settings",
      body: .object(body)
    )
  }

  /// 手动压缩上下文（**同步**执行）。**botId / sessionId 都转义**（TS 同）。
  ///
  /// 它真的会调一次模型把上下文写成摘要，所以调用方要给 loading，成功后**重拉一次会话
  /// 状态**（否则面板上还是压缩前的数字）。
  public func compactSession(botId: String, sessionId: String) async throws -> CompactSessionResponse {
    try await sendDecoded(
      "POST",
      "/bots/\(MemohPercentEncoding.pathSegment(botId))/sessions/\(MemohPercentEncoding.pathSegment(sessionId))/compact"
    )
  }

  /// bot 的运行时检查（"N 项未通过"的原文）。**botId 转义**（TS 同）。
  public func listBotChecks(botId: String) async throws -> BotChecksResponse {
    try await sendDecoded("GET", "/bots/\(MemohPercentEncoding.pathSegment(botId))/checks")
  }

  /// 单个 bot。新建后的进度轮询靠它。**botId 转义**（TS 同）。
  public func getBot(botId: String) async throws -> Bot {
    try await sendDecoded("GET", "/bots/\(MemohPercentEncoding.pathSegment(botId))")
  }

  /// 名字可用性。表单里 400ms 防抖调它。
  ///
  /// `reason` 的四态见 `BotNameAvailability`——别把它压成一个布尔。
  public func checkBotNameAvailability(
    name: String,
    excludeBotId: String? = nil
  ) async throws -> BotNameAvailability {
    try await sendDecoded(
      "GET",
      "/bots/name-availability",
      query: [("name", .text(name)), ("exclude_bot_id", excludeBotId.map { MemohQueryValue.text($0) })]
    )
  }

  /// **botId 转义**（TS 同）。
  public func deleteBot(botId: String) async throws -> MemohJSONValue? {
    try await sendUnknown("DELETE", "/bots/\(MemohPercentEncoding.pathSegment(botId))")
  }
}

// MARK: - 会话

extension MemohAPIClient {
  /// **botId 不转义**（TS 同——同一个 bot 的其它端点多转了义，这里就是没转）。
  public func listSessions(
    botId: String,
    limit: Int? = nil,
    cursor: String? = nil
  ) async throws -> ListSessionsResponse {
    try await sendDecoded(
      "GET",
      "/bots/\(botId)/sessions",
      query: [
        ("limit", limit.map { MemohQueryValue.number($0) }),
        ("cursor", cursor.map { MemohQueryValue.text($0) }),
      ]
    )
  }

  /// 单个会话的详情。**不转义**（TS 同）。
  ///
  /// 会话列表是分页的（默认 50 条），所以"当前会话不在已加载的那一页里"是常态——从通知、
  /// 深链或另一个 bot 切进来时都会这样。直接拿列表去查标题会查不到，标题就退化成占位文案。
  public func getSession(botId: String, sessionId: String) async throws -> Session {
    try await sendDecoded("GET", "/bots/\(botId)/sessions/\(sessionId)")
  }

  /// 列模型。用于「这个 bot 能用哪些模型」以及测试跨模型家族的行为差异。
  public func listModels() async throws -> ModelListResponse {
    try await sendDecoded("GET", "/models")
  }

  /// bot 的容器（只读）。**botId 转义**（TS 同）。
  public func getContainer(botId: String) async throws -> ContainerStatus {
    try await sendDecoded("GET", "/bots/\(MemohPercentEncoding.pathSegment(botId))/container")
  }

  /// 资源用量。**botId 转义**（TS 同）。后端可能说 `supported: false`——那时界面该说
  /// "读不到"，不是"0%"。
  public func getContainerMetrics(botId: String) async throws -> ContainerMetrics {
    try await sendDecoded("GET", "/bots/\(MemohPercentEncoding.pathSegment(botId))/container/metrics")
  }

  /// 桌面能力探针。**botId 转义**（TS 同）。
  ///
  /// 注意它**只说能力**，不代表能连上：画面是 WebRTC，媒体走 UDP，而本项目的 iOS 客户端
  /// 还没有接原生 WebRTC。所以这个探针的用途是"告诉用户这台机器的桌面是什么状态"，
  /// 不是"点这里就能看画面"。
  public func getDisplay(botId: String) async throws -> DisplayCapability {
    try await sendDecoded("GET", "/bots/\(MemohPercentEncoding.pathSegment(botId))/container/display")
  }

  /// 某个 bot 的**运行时可用**技能清单（斜杠菜单用）。**botId 转义**（TS 同）。
  ///
  /// 只列"能在这轮对话里激活"的技能——服务端已经筛过了（`state: effective`），
  /// 客户端不要再按自己的理解过滤一遍。
  public func listSkills(botId: String) async throws -> SkillCatalogResponse {
    try await sendDecoded("GET", "/bots/\(MemohPercentEncoding.pathSegment(botId))/skills/catalog")
  }

  /// 列 provider。**不转义**（这条没有参数）。
  ///
  /// 只为一个目的：模型选择器按 provider 分组时要有**名字**。取不到就退回一组平铺，
  /// 不拿 provider_id 冒充名字。
  public func listProviders() async throws -> ProviderListResponse {
    try await sendDecoded("GET", "/providers")
  }

  /// 建会话。**botId 不转义**（TS 同）。响应形状在 swagger 里是空的，
  /// 取 id 走 `createdSessionId(_:)`。
  public func createSession(
    botId: String,
    body: [String: MemohJSONValue]
  ) async throws -> MemohJSONValue? {
    try await sendUnknown("POST", "/bots/\(botId)/sessions", body: .object(body))
  }

  /// 改会话（`PATCH`）。目前只用来**重命名**（`{title}`）。**不转义**（TS 同）。
  public func updateSession(
    botId: String,
    sessionId: String,
    body: [String: MemohJSONValue]
  ) async throws -> MemohJSONValue? {
    try await sendUnknown("PATCH", "/bots/\(botId)/sessions/\(sessionId)", body: .object(body))
  }

  /// 从一个助手轮次分叉出新会话。**botId / sessionId 转义**（TS 同）。
  ///
  /// `turnId` 必须是**助手轮次**的 id（不是消息 id）：服务端按它找到那一轮，把这一轮连同
  /// 之前的消息复制到新会话里（`internal/chat/thread/service.go` 的 `ForkFromAssistantTurn`）。
  /// `title` 省略时服务端用 `<源标题> fork`。
  ///
  /// **不是所有会话都能分叉**：非 `chat` 类型（定时任务会话等）服务端回 409
  /// `only chat sessions can be forked`。所以调用方要先判类型，别给一个必然失败的入口。
  public func forkSession(
    botId: String,
    sessionId: String,
    turnId: String,
    title: String? = nil
  ) async throws -> ForkSessionResponse {
    var body: [String: MemohJSONValue] = ["turn_id": .string(turnId)]
    if let title { body["title"] = .string(title) }
    return try await sendDecoded(
      "POST",
      "/bots/\(MemohPercentEncoding.pathSegment(botId))/sessions/\(MemohPercentEncoding.pathSegment(sessionId))/fork",
      body: .object(body)
    )
  }

  /// **不转义**（TS 同）。返回 `Void`（对应 TS 的 `Promise<void>`）。
  public func deleteSession(botId: String, sessionId: String) async throws {
    try await sendVoid("DELETE", "/bots/\(botId)/sessions/\(sessionId)")
  }

  /// 会话历史。注意这是**轮次**（`UITurn`）列表，不是扁平消息列表。
  /// `beforeMessageId` 用于向前翻页。**不转义**（TS 同）。
  public func listMessages(
    botId: String,
    sessionId: String,
    limit: Int? = nil,
    beforeMessageId: MemohQueryValue? = nil
  ) async throws -> UIMessageListResponse {
    try await sendDecoded(
      "GET",
      "/bots/\(botId)/messages",
      query: [
        ("session_id", .text(sessionId)),
        ("limit", limit.map { MemohQueryValue.number($0) }),
        ("before_message_id", beforeMessageId),
      ]
    )
  }

  /// 会话上下文用量 / 缓存命中 / 技能列表。**不是**运行状态。**不转义**（TS 同）。
  ///
  /// 与 `getSessionStatus` 打的是**同一个端点**，两个都留是因为 TS 里也两个都有：
  /// 这条是"我还不知道形状"的动态版，那条是类型化的 `SessionStatus`。等 9B-3 把调用点
  /// 全部收敛到类型版之后再删动态版（现在删掉等于替 RN 侧做决定）。
  public func sessionStatus(botId: String, sessionId: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject("GET", "/bots/\(botId)/sessions/\(sessionId)/status")
  }
}

// MARK: - 用量

extension MemohAPIClient {
  /// **botId 不转义**（TS 同）。
  public func tokenUsage(botId: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject("GET", "/bots/\(botId)/token-usage")
  }
}

// MARK: - 工作区文件

extension MemohAPIClient {
  /// ⚠️ 这个端点的 JSON 是 camelCase（`modTime` / `isDir`），全仓唯一例外。
  /// **botId 不转义**（TS 同）。
  public func listFiles(botId: String, path: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject("GET", "/bots/\(botId)/container/fs/list", query: [("path", .text(path))])
  }

  /// ⚠️ 无大小限制，且二进制会有损。只用于小文本预览。**不转义**（TS 同）。
  public func readFile(botId: String, path: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject("GET", "/bots/\(botId)/container/fs/read", query: [("path", .text(path))])
  }

  /// 单个路径的 stat。**不转义**（TS 同）。
  ///
  /// **404 是"这个文件不存在"的唯一可靠信号**（服务端不返回别的形状），所以调用方要把
  /// `MemohAPIError.status == 404` 当作"不存在"而不是"网络坏了"。
  public func statFile(botId: String, path: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject("GET", "/bots/\(botId)/container/fs", query: [("path", .text(path))])
  }

  /// 下载用的绝对地址与请求头。
  ///
  /// `fs/download` 返回**原始字节**（目录会现打一个 tar.gz），走不了 `send` 的 JSON 通道，
  /// 而且**没有大小上限**——必须流式落盘，绝不能先 `await res.text()`。这里只把地址和鉴权头
  /// 拼出来交给原生侧，避免 token 在各处乱传。
  ///
  /// **不发请求**：所以它没有 `async`（TS 那边也是同步函数）。**botId 不转义**（TS 同）。
  public func downloadTarget(botId: String, path: String) -> (url: String, headers: [String: String]) {
    let target = resolve("/bots/\(botId)/container/fs/download")
      + "?path=" + MemohPercentEncoding.queryComponent(path)
    guard let token = tokenProvider(), !token.isEmpty else {
      return (target, [:])
    }
    return (target, ["Authorization": "Bearer \(token)"])
  }
}

// MARK: - 定时任务

extension MemohAPIClient {
  /// **botId 不转义**（TS 同）。
  public func listSchedules(botId: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject("GET", "/bots/\(botId)/schedule")
  }

  /// **scheduleId 转义**（TS 同）。
  public func getSchedule(botId: String, scheduleId: String) async throws -> [String: MemohJSONValue]? {
    try await sendObject(
      "GET",
      "/bots/\(botId)/schedule/\(MemohPercentEncoding.pathSegment(scheduleId))"
    )
  }

  /// 新建。返回 201，服务端补全 id 与时间戳后把整条还回来。**不转义**（TS 同）。
  public func createSchedule(
    botId: String,
    body: [String: MemohJSONValue]
  ) async throws -> [String: MemohJSONValue]? {
    try await sendObject("POST", "/bots/\(botId)/schedule", body: .object(body))
  }

  /// 改一条。**scheduleId 转义**（TS 同）。
  ///
  /// ⚠️ 这是 **patch** 语义（省略的字段=不改），但 `execution` 是**整块替换**：只改其中
  /// 一项也要先 GET 到整块再 PUT 回去，否则其余几项会被清空。
  /// ⚠️ `max_calls` 要"取消上限"必须显式发 `null`，省略它等于"不改"。
  public func updateSchedule(
    botId: String,
    scheduleId: String,
    body: [String: MemohJSONValue]
  ) async throws -> [String: MemohJSONValue]? {
    try await sendObject(
      "PUT",
      "/bots/\(botId)/schedule/\(MemohPercentEncoding.pathSegment(scheduleId))",
      body: .object(body)
    )
  }

  /// **scheduleId 转义**（TS 同）。
  public func deleteSchedule(botId: String, scheduleId: String) async throws -> MemohJSONValue? {
    try await sendUnknown(
      "DELETE",
      "/bots/\(botId)/schedule/\(MemohPercentEncoding.pathSegment(scheduleId))"
    )
  }

  /// 跨任务的执行日志（一次调用拿全，别再按任务 N 次请求）。**不转义**（TS 同）。
  ///
  /// 列表行要的"最近一次结果"只能从这里取——任务本身**没有** `next_run` / `last_run` 字段。
  public func listScheduleLogs(
    botId: String,
    limit: Int? = nil,
    offset: Int? = nil
  ) async throws -> [String: MemohJSONValue]? {
    try await sendObject(
      "GET",
      "/bots/\(botId)/schedule/logs",
      query: [
        ("limit", limit.map { MemohQueryValue.number($0) }),
        ("offset", offset.map { MemohQueryValue.number($0) }),
      ]
    )
  }
}

// MARK: - 请求体编码

extension MemohAPIClient {
  /// 把请求体模型编成动态 JSON。
  ///
  /// 为什么不给 `send` 一个 `any Encodable` 的口子：那样每个端点都能塞任意形状进去，
  /// 而请求体是**要过服务端校验**的东西——类型化模型是这一层唯一的护栏。这里只把已经
  /// 类型化的模型转成 `MemohJSONValue` 再交给同一条通道。
  ///
  /// 可选字段靠 `JSONEncoder` 的默认行为省略（合成的编码走 `encodeIfPresent`），
  /// 与 TS 的 `JSON.stringify` 一致：`undefined` 的键根本不出现在 JSON 里。
  private func encodeBody<T: Encodable>(_ value: T) throws -> MemohJSONValue {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(MemohJSONValue.self, from: data)
  }
}
