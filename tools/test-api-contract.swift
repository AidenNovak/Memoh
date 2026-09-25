import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// REST 数据层的契约测试（`apps/mobile/modules/memoh-kit/ios/API/*`）。
///
/// 与 `tools/test-auth-contract.swift` 同一套做法：`@main` + 手写 `expect`，编译成二进制直接跑。
/// **不用 XCTest**——本机与 CI 的快速通道只有 Command Line Tools，没有 XCTest。
///
/// 覆盖四层，缺一层就不算完：
///
/// 1. **请求形状**：method / 完整 URL（含 query 顺序与百分号编码）/ 头 / 体。用 `URLProtocol`
///    子类做桩，离线跑——"服务端到底收到了什么"只有桩能逐字回答。
/// 2. **响应处理**：204 与空体、错误体映射、非 JSON 错误页、401、网络错误、超时。
/// 3. **解码与规范化**：跑 `tools/api-fixtures/manifest.json` 里的每一个夹具，把
///    raw → Swift 解码 → 规范化，与 **TS 客户端**产出的 `expected` 做语义比较。
/// 4. **编码往返**：`MemohJSONValue` 编解码相等，整数 `1` 不会变成 `1.0`。
///
/// 用法：
///     tools/typecheck-foundation.sh
///     # 或
///     swiftc -parse-as-library <4 个 API 文件> tools/test-api-contract.swift -o /tmp/t && /tmp/t
@main
enum APIContractTests {
  static func main() async throws {
    queryEncodingMatchesURLSearchParams()
    pathSegmentEncodingMatchesEncodeURIComponent()
    try urlResolution()
    await requestShapes()
    await responseHandling()
    await probeAuthShapes()
    errorMapping()
    try jsonValueRoundTrip()
    try await queueNormalization()
    try modelDecoding()
    try await fixtures()
    print("API contract tests passed")
  }

  // MARK: - 百分号编码

  /// query 的编码必须与 JS 的 `URLSearchParams` 等价。
  ///
  /// 为什么较真：`CharacterSet.urlQueryAllowed` **不转义 `+ & = ? %`**。用它发一个含 `+`
  /// 的 cursor，Go 的 `r.URL.Query()` 会把 `+` 解成空格 → **cursor 悄悄失效**，翻页永远
  /// 翻不动，而且没有任何报错。
  ///
  /// **已知差异**：空格我们发 `%20`，而 `URLSearchParams` 发 `+`。两者 Go 都解成空格，
  /// `%20` 更不容易被中间层改写。所以这一组断言写成两步：先钉死我们的编码，再证明它与
  /// node 的输出只差这一处、且两者解出来是同一个值。
  private static func queryEncodingMatchesURLSearchParams() {
    let value = "a+b/c=d&e?f#g%h i"
    let ours = MemohPercentEncoding.queryComponent(value)
    // node: new URLSearchParams({ q: value }).toString() === "q=a%2Bb%2Fc%3Dd%26e%3Ff%23g%25h+i"
    let node = "a%2Bb%2Fc%3Dd%26e%3Ff%23g%25h+i"
    expect(ours == "a%2Bb%2Fc%3Dd%26e%3Ff%23g%25h%20i", "query 编码：得到 \(ours)")
    expect(
      ours.replacingOccurrences(of: "%20", with: "+") == node,
      "除空格外必须与 node 的 URLSearchParams 逐字符相同：得到 \(ours)"
    )
    expect(decodeFormURLEncoded(ours) == value, "自解码要能回到原值")
    expect(decodeFormURLEncoded(node) == value, "node 的写法解出同一个值")

    // WHATWG 的等价集是"字母数字 + `*` + `-` + `.` + `_`"：`~` 要转义（与 encodeURIComponent 不同）。
    expect(MemohPercentEncoding.queryComponent("~*") == "%7E*", "~ 转义、* 保留")
    expect(MemohPercentEncoding.queryComponent("") == "", "空串还是空串")
    expect(MemohPercentEncoding.queryComponent("café") == "caf%C3%A9", "非 ASCII 走 UTF-8 字节")
    expect(MemohPercentEncoding.queryComponent("/a b") == "%2Fa%20b", "路径当 query 值时要转义 /")
  }

  /// 路径段的编码必须与 JS 的 `encodeURIComponent` 等价。
  ///
  /// 不能用 `.urlPathAllowed` 当替身：它**保留 `/`**，于是 `getBot("a/b")` 会打到
  /// `/bots/a/b`——那是另一个端点。
  private static func pathSegmentEncodingMatchesEncodeURIComponent() {
    // node: encodeURIComponent("a/b c+d=e&f?g#h%i~!*()'-._") === "a%2Fb%20c%2Bd%3De%26f%3Fg%23h%25i~!*()'-._"
    expect(MemohPercentEncoding.pathSegment("a/b") == "a%2Fb", "`/` 必须转义")
    expect(MemohPercentEncoding.pathSegment("a b") == "a%20b", "空格")
    expect(MemohPercentEncoding.pathSegment("~!*()'-._") == "~!*()'-._", "encodeURIComponent 保留的这 9 个")
    expect(
      MemohPercentEncoding.pathSegment("a+b/c=d&e?f#g%h i") == "a%2Bb%2Fc%3Dd%26e%3Ff%23g%25h%20i",
      "整串"
    )
    expect(MemohPercentEncoding.pathSegment("café") == "caf%C3%A9", "非 ASCII 走 UTF-8 字节")
    expect(MemohPercentEncoding.pathSegment("100%") == "100%25", "`%` 必须转义")
  }

  /// 把 `application/x-www-form-urlencoded` 解回原值（`+` 与 `%20` 都算空格）。
  private static func decodeFormURLEncoded(_ value: String) -> String {
    let bytes = Array(value.utf8)
    var out: [UInt8] = []
    var index = 0
    while index < bytes.count {
      let byte = bytes[index]
      if byte == UInt8(ascii: "+") {
        out.append(UInt8(ascii: " "))
        index += 1
        continue
      }
      if byte == UInt8(ascii: "%"), index + 2 < bytes.count,
         let hex = UInt8(String(decoding: bytes[(index + 1) ... (index + 2)], as: UTF8.self), radix: 16) {
        out.append(hex)
        index += 3
        continue
      }
      out.append(byte)
      index += 1
    }
    return String(decoding: out, as: UTF8.self)
  }

  // MARK: - URL 拼接

  private static func urlResolution() throws {
    let client = MemohAPIClient(baseURL: "https://memoh.example.com", tokenProvider: { nil })
    expect(client.url == "https://memoh.example.com", "尾斜杠去掉")
    expect(client.resolve("/bots") == "https://memoh.example.com/bots", "绝对路径")
    expect(client.resolve("bots") == "https://memoh.example.com/bots", "不以 / 开头要补一个")
    expect(client.token() == nil, "没有 token 时是 nil")

    let slashes = MemohAPIClient(baseURL: "https://memoh.example.com///", tokenProvider: { nil })
    expect(slashes.url == "https://memoh.example.com", "**所有**尾斜杠都要去掉")

    let withPath = MemohAPIClient(baseURL: "https://memoh.example.com/api", tokenProvider: { nil })
    expect(withPath.resolve("/ping") == "https://memoh.example.com/api/ping", "带路径的 baseURL")
  }

  // MARK: - 请求形状

  /// 逐端点断言"发出去的请求"。这一组**不看返回值**，所以桩回 `{}` 就够——解码失败
  /// （`MemohAPIError`）在这里是正常的，被吞掉；别的错误照旧抛。
  private static func requestShapes() async {
    let client = makeClient()

    await expectShape(
      "getBot：路径段转义",
      method: "GET",
      url: "https://memoh.example.com/bots/a%2Fb",
      contentType: false,
      call: { _ = try await client.getBot(botId: "a/b") }
    )

    await expectShape(
      "getSession：**不**转义（照抄 TS 的不对称）",
      method: "GET",
      url: "https://memoh.example.com/bots/a/b/sessions/c/d",
      contentType: false,
      call: { _ = try await client.getSession(botId: "a/b", sessionId: "c/d") }
    )

    await expectShape(
      "getSettings：不转义（与 getBotSettings 同端点、不同转义）",
      method: "GET",
      url: "https://memoh.example.com/bots/a/b/settings",
      contentType: false,
      call: { _ = try await client.getSettings(botId: "a/b") }
    )

    await expectShape(
      "getBotSettings：转义",
      method: "GET",
      url: "https://memoh.example.com/bots/a%2Fb/settings",
      contentType: false,
      call: { _ = try await client.getBotSettings(botId: "a/b") }
    )

    await expectShape(
      "updateSettings：PUT + 体",
      method: "PUT",
      url: "https://memoh.example.com/bots/b1/settings",
      contentType: true,
      body: #"{"display_enabled":true}"#,
      call: { _ = try await client.updateSettings(botId: "b1", body: ["display_enabled": .bool(true)]) }
    )

    await expectShape(
      "getSessionStatus",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/sessions/s1/status",
      contentType: false,
      call: { _ = try await client.getSessionStatus(botId: "b1", sessionId: "s1") }
    )

    // query：顺序（limit 在前、cursor 在后）与编码都要与 TS 的对象字面量一致；
    // `0` 必须发出去（`String(0)` = "0"，别把它当假值丢掉）。
    await expectShape(
      "listSessions：query 顺序 + 编码 + limit=0 要发",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/sessions?limit=0&cursor=a%2Bb%2Fc%3Dd%26e%3Ff%23g%25h%20i",
      contentType: false,
      call: {
        _ = try await client.listSessions(botId: "b1", limit: 0, cursor: "a+b/c=d&e?f#g%h i")
      }
    )

    await expectShape(
      "listSessions：空串 cursor 被丢弃（一个 query 都不发）",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/sessions",
      contentType: false,
      call: { _ = try await client.listSessions(botId: "b1", limit: nil, cursor: "") }
    )

    await expectShape(
      "listMessages：beforeMessageId=0 要发",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/messages?session_id=s1&before_message_id=0",
      contentType: false,
      call: { _ = try await client.listMessages(botId: "b1", sessionId: "s1", beforeMessageId: 0) }
    )

    await expectShape(
      "checkBotNameAvailability：可选参数缺省就不发",
      method: "GET",
      url: "https://memoh.example.com/bots/name-availability?name=my%20bot",
      contentType: false,
      call: { _ = try await client.checkBotNameAvailability(name: "my bot") }
    )

    await expectShape(
      "checkBotNameAvailability：带上 exclude_bot_id",
      method: "GET",
      url: "https://memoh.example.com/bots/name-availability?name=x&exclude_bot_id=b9",
      contentType: false,
      call: { _ = try await client.checkBotNameAvailability(name: "x", excludeBotId: "b9") }
    )

    await expectShape(
      "login：不带 Authorization（唯一公开入口）",
      method: "POST",
      url: "https://memoh.example.com/auth/login",
      contentType: true,
      authorization: .absent,
      body: #"{"username":"u","password":"p"}"#,
      call: { _ = try await client.login(username: "u", password: "p") }
    )

    await expectShape(
      "me：带 Authorization、不带 Content-Type",
      method: "GET",
      url: "https://memoh.example.com/users/me",
      contentType: false,
      call: { _ = try await client.me() }
    )

    await expectShape(
      "deleteQueueItem（steer）：itemId 转义",
      method: "DELETE",
      url: "https://memoh.example.com/bots/b1/sessions/s1/steer-queue/a%2Fb",
      contentType: false,
      call: { _ = try await client.deleteQueueItem(botId: "b1", sessionId: "s1", kind: .steer, itemId: "a/b") }
    )

    await expectShape(
      "deleteQueueItem（follow-up）：段名由 kind 决定",
      method: "DELETE",
      url: "https://memoh.example.com/bots/b1/sessions/s1/follow-up-queue/x%20y",
      contentType: false,
      call: { _ = try await client.deleteQueueItem(botId: "b1", sessionId: "s1", kind: .followUp, itemId: "x y") }
    )

    await expectShape(
      "promoteQueueItem：itemId 转义",
      method: "POST",
      url: "https://memoh.example.com/bots/b1/sessions/s1/follow-up-queue/i%2Fd/steer",
      contentType: false,
      call: { _ = try await client.promoteQueueItem(botId: "b1", sessionId: "s1", itemId: "i/d") }
    )

    await expectShape(
      "enqueueFollowUp：幂等身份进体",
      method: "POST",
      url: "https://memoh.example.com/bots/b1/sessions/s1/follow-up-queue",
      contentType: true,
      body: #"{"invocation_id":"inv-1","text":"hello"}"#,
      call: {
        _ = try await client.enqueueFollowUp(botId: "b1", sessionId: "s1", text: "hello", invocationId: "inv-1")
      }
    )

    // 指针语义：只发改过的字段（`display_name` 在体里，别的键**不出现**）。
    await expectShape(
      "updateBot：只发要改的字段",
      method: "PUT",
      url: "https://memoh.example.com/bots/a%2Fb",
      contentType: true,
      body: #"{"display_name":"N"}"#,
      call: { _ = try await client.updateBot(botId: "a/b", body: BotUpdateRequest(displayName: "N")) }
    )

    await expectShape(
      "createBot：**不带** wait_for_ready",
      method: "POST",
      url: "https://memoh.example.com/bots",
      contentType: true,
      body: #"{"name":"n1","display_name":"N1"}"#,
      call: { _ = try await client.createBot(body: BotCreateRequest(name: "n1", displayName: "N1")) }
    )

    await expectShape(
      "listFiles：path 作为 query 值（/ 与空格都要转义）",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/container/fs/list?path=%2Fa%20b%2Fc",
      contentType: false,
      call: { _ = try await client.listFiles(botId: "b1", path: "/a b/c") }
    )

    await expectShape(
      "statFile：path 走 query",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/container/fs?path=x",
      contentType: false,
      call: { _ = try await client.statFile(botId: "b1", path: "x") }
    )

    await expectShape(
      "getSchedule：scheduleId 转义",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/schedule/a%2Fb",
      contentType: false,
      call: { _ = try await client.getSchedule(botId: "b1", scheduleId: "a/b") }
    )

    await expectShape(
      "listScheduleLogs：offset=5 要发、limit 缺省不发",
      method: "GET",
      url: "https://memoh.example.com/bots/b1/schedule/logs?offset=5",
      contentType: false,
      call: { _ = try await client.listScheduleLogs(botId: "b1", offset: 5) }
    )

    await expectShape(
      "forkSession：title 缺省就不进体",
      method: "POST",
      url: "https://memoh.example.com/bots/b1/sessions/s1/fork",
      contentType: true,
      body: #"{"turn_id":"t1"}"#,
      call: { _ = try await client.forkSession(botId: "b1", sessionId: "s1", turnId: "t1") }
    )

    await expectShape(
      "deleteSession：204 空体不抛错",
      response: MemohStubProtocol.Response(status: 204, body: nil),
      method: "DELETE",
      url: "https://memoh.example.com/bots/b1/sessions/s1",
      contentType: false,
      call: { try await client.deleteSession(botId: "b1", sessionId: "s1") }
    )

    await expectShape(
      "compactSession：两端都转义",
      method: "POST",
      url: "https://memoh.example.com/bots/a%2Fb/sessions/c%2Fd/compact",
      contentType: false,
      call: { _ = try await client.compactSession(botId: "a/b", sessionId: "c/d") }
    )

    await expectShape(
      "getDisplay：转义",
      method: "GET",
      url: "https://memoh.example.com/bots/a%2Fb/container/display",
      contentType: false,
      call: { _ = try await client.getDisplay(botId: "a/b") }
    )

    // downloadTarget **不发请求**：只拼地址与鉴权头。
    MemohStubProtocol.reset([])
    let target = client.downloadTarget(botId: "b1", path: "/a b")
    expect(MemohStubProtocol.recorded().isEmpty, "downloadTarget 不许发请求")
    expect(
      target.url == "https://memoh.example.com/bots/b1/container/fs/download?path=%2Fa%20b",
      "downloadTarget 的 URL：得到 \(target.url)"
    )
    expect(target.headers == ["Authorization": "Bearer contract-token"], "downloadTarget 的头")

    let anonymous = MemohAPIClient(
      baseURL: "https://memoh.example.com",
      tokenProvider: { nil },
      session: stubSession()
    )
    expect(anonymous.downloadTarget(botId: "b1", path: "x").headers.isEmpty, "没有 token 时没有头")

    // 空串 token 不发 Authorization（TS 的 `if (token)`）。
    let blank = MemohAPIClient(
      baseURL: "https://memoh.example.com",
      tokenProvider: { "" },
      session: stubSession()
    )
    await expectShape(
      "空串 token 不发 Authorization",
      method: "GET",
      url: "https://memoh.example.com/users/me",
      contentType: false,
      authorization: .absent,
      call: { _ = try await blank.me() }
    )
  }

  /// `expectShape` 对 `Authorization` 头的期望。
  ///
  /// 为什么做成枚举而不是 `String?`：默认必须能表达"**该带** Bearer（客户端有 token）"，
  /// 而 `nil` 得留给"**不该有**这个头"——用 `String?` 的话默认值会把所有带 token 的端点
  /// 都判成失败，或者反过来让"token 没带上"这件事静默通过。
  private enum StubAuthorization {
    /// 带 `Bearer contract-token`（`makeClient` 给的 token）。
    case bearerToken
    /// 不该有这个头。
    case absent
    case value(String)
  }

  /// 断言一次调用发出的**唯一**一个请求的形状。
  ///
  /// `call` 里抛出来的 `MemohAPIError` 被吞掉：桩回的是 `{}`，类型化端点解不出来是正常的，
  /// 这一组只关心"服务端收到了什么"。
  private static func expectShape(
    _ label: String,
    response: MemohStubProtocol.Response = MemohStubProtocol.Response(),
    method: String,
    url: String,
    contentType: Bool,
    authorization: StubAuthorization = .bearerToken,
    body: String? = nil,
    call: () async throws -> Void
  ) async {
    let expectedAuthorization: String?
    switch authorization {
    case .bearerToken: expectedAuthorization = "Bearer contract-token"
    case .absent: expectedAuthorization = nil
    case let .value(raw): expectedAuthorization = raw
    }

    MemohStubProtocol.reset([response])
    do {
      try await call()
    } catch is MemohAPIError {
      // 这一组不看返回值。
    } catch {
      fail("\(label)：调用抛了非 MemohAPIError：\(error)")
    }

    guard let recorded = MemohStubProtocol.recorded().first else {
      fail("\(label)：桩没有收到请求")
    }
    expect(recorded.method == method, "\(label)：method 是 \(recorded.method)，期望 \(method)")
    expect(recorded.url == url, "\(label)：URL 是 \(recorded.url)，期望 \(url)")
    expect(header(recorded, "Accept") == "application/json", "\(label)：Accept 头")
    expect(
      (header(recorded, "Content-Type") != nil) == contentType,
      "\(label)：Content-Type \(contentType ? "该有" : "不该有")"
    )
    expect(header(recorded, "Authorization") == expectedAuthorization, "\(label)：Authorization 头")
    if let body {
      guard let data = recorded.body else { fail("\(label)：没有请求体") }
      let actual = (try? JSONDecoder().decode(MemohJSONValue.self, from: data)) ?? .null
      let expected = (try? JSONDecoder().decode(MemohJSONValue.self, from: Data(body.utf8))) ?? .null
      let printed = String(decoding: data, as: UTF8.self)
      expect(actual == expected, "\(label)：体是 \(printed)，期望 \(body)")
    }
    MemohStubProtocol.reset([])
  }

  private static func header(_ call: MemohStubProtocol.Call, _ name: String) -> String? {
    for (key, value) in call.headers where key.lowercased() == name.lowercased() {
      return value
    }
    return nil
  }

  // MARK: - 响应处理

  private static func responseHandling() async {
    let flags = FlagBox()
    let client = makeClient(onUnauthorized: { flags.raise() })

    // 204 → nil（TS 的 undefined）。**不要**发明"空响应"错误。
    MemohStubProtocol.reset([MemohStubProtocol.Response(status: 204, body: nil)])
    do {
      let value = try await client.tokenUsage(botId: "b1")
      expect(value == nil, "204 要返回 nil")
    } catch {
      fail("204 不该抛错：\(error)")
    }

    // 200 + 空体 → nil。
    MemohStubProtocol.reset([MemohStubProtocol.Response(status: 200, body: Data())])
    do {
      let value = try await client.tokenUsage(botId: "b1")
      expect(value == nil, "空响应体要返回 nil")
    } catch {
      fail("空响应体不该抛错：\(error)")
    }

    // 错误体的字段映射。
    await expectAPIError(
      "message + code",
      response: MemohStubProtocol.Response(status: 400, body: Data(#"{"message":"x","code":"y"}"#.utf8)),
      call: { _ = try await client.tokenUsage(botId: "b1") },
      status: 400,
      message: "x",
      code: "y"
    )

    await expectAPIError(
      "message 为空串时退到 error",
      response: MemohStubProtocol.Response(status: 422, body: Data(#"{"message":"","error":"fallback"}"#.utf8)),
      call: { _ = try await client.tokenUsage(botId: "b1") },
      status: 422,
      message: "fallback",
      code: nil
    )

    await expectAPIError(
      "只有 error",
      response: MemohStubProtocol.Response(status: 500, body: Data(#"{"error":"boom"}"#.utf8)),
      call: { _ = try await client.tokenUsage(botId: "b1") },
      status: 500,
      message: "boom",
      code: nil
    )

    await expectAPIError(
      "网关的 HTML 错误页：保持 HTTP 500 文案，不抛解码错误",
      response: MemohStubProtocol.Response(status: 500, body: Data("<html>502 Bad Gateway</html>".utf8)),
      call: { _ = try await client.tokenUsage(botId: "b1") },
      status: 500,
      message: "HTTP 500",
      code: nil
    )

    await expectAPIError(
      "空错误体：HTTP <status>",
      response: MemohStubProtocol.Response(status: 503, body: Data()),
      call: { _ = try await client.tokenUsage(botId: "b1") },
      status: 503,
      message: "HTTP 503",
      code: nil
    )

    // 401：抛错 + 触发 onUnauthorized（**只有这一处**触发）。
    flags.reset()
    await expectAPIError(
      "401：isUnauthorized + onUnauthorized",
      response: MemohStubProtocol.Response(status: 401, body: Data(#"{"message":"expired"}"#.utf8)),
      call: { _ = try await client.me() },
      status: 401,
      message: "expired",
      code: nil
    )
    expect(flags.value, "401 要触发 onUnauthorized")
    expect(flags.count == 1, "onUnauthorized 只该触发一次")

    // `/auth/login` 自己回 401 是"密码错了"，不是"会话结束"——不能把用户踢回登录页。
    flags.reset()
    await expectAPIError(
      "login 的 401 不触发 onUnauthorized",
      response: MemohStubProtocol.Response(status: 401, body: Data(#"{"message":"bad credentials"}"#.utf8)),
      call: { _ = try await client.login(username: "u", password: "p") },
      status: 401,
      message: "bad credentials",
      code: nil
    )
    expect(!flags.value, "login 的 401 不该触发 onUnauthorized")

    // 网络错误 → status 0、没有 code。
    await expectAPIError(
      "网络错误",
      response: MemohStubProtocol.Response(failure: URLError(.cannotConnectToHost)),
      call: { _ = try await client.tokenUsage(botId: "b1") },
      status: 0,
      message: nil,
      code: nil
    )
    MemohStubProtocol.reset([MemohStubProtocol.Response(failure: URLError(.cannotConnectToHost))])
    do {
      _ = try await client.tokenUsage(botId: "b1")
      fail("网络错误该抛")
    } catch let error as MemohAPIError {
      expect(error.isNetwork, "status 0 = isNetwork")
      expect(!error.isUnauthorized, "网络错误不是 401")
    } catch {
      fail("网络错误要折成 MemohAPIError：\(error)")
    }

    // 超时：客户端 0.2 秒、桩延迟 1 秒 → `code: "timeout"`。
    let impatient = MemohAPIClient(
      baseURL: "https://memoh.example.com",
      tokenProvider: { "contract-token" },
      session: stubSession(),
      timeout: 0.2
    )
    MemohStubProtocol.reset([MemohStubProtocol.Response(delay: 1)])
    do {
      _ = try await impatient.tokenUsage(botId: "b1")
      fail("超时该抛")
    } catch let error as MemohAPIError {
      expect(error.status == 0, "超时是 status 0：得到 \(error.status)")
      expect(error.code == "timeout", "超时 code 是 timeout：得到 \(error.code ?? "nil")")
      expect(error.message == "request timed out after 200ms", "超时文案：得到 \(error.message)")
    } catch {
      fail("超时该折成 MemohAPIError：\(error)")
    }

    // 200 但响应体不是 JSON：解码错误（**不是** network，也不是 unauthorized）。
    MemohStubProtocol.reset([MemohStubProtocol.Response(status: 200, body: Data("not json".utf8))])
    do {
      _ = try await client.me()
      fail("非 JSON 的 200 该抛")
    } catch let error as MemohAPIError {
      expect(error.status == 200, "解码失败要带 HTTP 状态：得到 \(error.status)")
      expect(!error.isNetwork, "解码失败不是网络错误")
      expect(!error.isUnauthorized, "解码失败不是 401")
    } catch {
      fail("解码失败要折成 MemohAPIError：\(error)")
    }

    // 200 但是数组、而端点声明是对象：当场报错，不要悄悄返回空字典。
    MemohStubProtocol.reset([MemohStubProtocol.Response(status: 200, body: Data("[1,2]".utf8))])
    do {
      _ = try await client.tokenUsage(botId: "b1")
      fail("对象端点收到数组该抛")
    } catch let error as MemohAPIError {
      expect(error.status == 200, "形状不对也是带状态的错误")
    } catch {
      fail("形状不对要折成 MemohAPIError：\(error)")
    }
  }

  /// 断言一次调用抛出的错误形状。
  private static func expectAPIError(
    _ label: String,
    response: MemohStubProtocol.Response,
    call: () async throws -> Void,
    status: Int,
    message: String?,
    code: String?
  ) async {
    MemohStubProtocol.reset([response])
    do {
      try await call()
      fail("\(label)：该抛错却成功了")
    } catch let error as MemohAPIError {
      expect(error.status == status, "\(label)：status 是 \(error.status)，期望 \(status)")
      if let message {
        expect(error.message == message, "\(label)：message 是 \(error.message)，期望 \(message)")
      }
      expect(error.code == code, "\(label)：code 是 \(error.code ?? "nil")，期望 \(code ?? "nil")")
    } catch {
      fail("\(label)：抛的不是 MemohAPIError：\(error)")
    }
    MemohStubProtocol.reset([])
  }

  /// `probeAuth`：成功 → false；401 → true；网络错误 → false。
  ///
  /// 这三条对应 TS 那段注释："超时和 401 在客户端看起来一样，但处置相反"——
  /// 所以只有**明确说了 401** 才算凭据坏了。
  private static func probeAuthShapes() async {
    let flags = FlagBox()
    let client = makeClient(onUnauthorized: { flags.raise() })

    MemohStubProtocol.reset([MemohStubProtocol.Response(status: 200, body: Data(#"{"id":"u"}"#.utf8))])
    let healthy = await client.probeAuth()
    expect(healthy == false, "200 → 凭据还有效")

    MemohStubProtocol.reset([MemohStubProtocol.Response(status: 401, body: Data(#"{"message":"expired"}"#.utf8))])
    let expired = await client.probeAuth()
    expect(expired, "401 → 凭据没了")
    expect(flags.value, "probeAuth 的 401 也要按契约触发 onUnauthorized（这正是收敛点）")

    MemohStubProtocol.reset([MemohStubProtocol.Response(failure: URLError(.notConnectedToInternet))])
    let unreachable = await client.probeAuth()
    expect(unreachable == false, "问不出来 ≠ 凭据坏了")
  }

  // MARK: - 错误映射

  private static func errorMapping() {
    let value = MemohAPIError.from(
      status: 500,
      body: Data(#"{"message":"m","error":"e","code":"c"}"#.utf8)
    )
    expect(value.message == "m", "message 优先")
    expect(value.code == "c", "code 取 code 字段")
    expect(!value.isUnauthorized, "500 不是 401")

    let emptyCode = MemohAPIError.from(status: 400, body: Data(#"{"code":""}"#.utf8))
    expect(emptyCode.code == "", "空串 code 也算 code（TS 同）")
    expect(emptyCode.message == "HTTP 400", "没有 message/error 时用 HTTP <status>")

    let html = MemohAPIError.from(status: 502, body: Data("<html>bad gateway</html>".utf8))
    expect(html.message == "HTTP 502", "非 JSON 保持默认文案")
    expect(html.code == nil, "非 JSON 没有 code")

    let array = MemohAPIError.from(status: 400, body: Data(#"["nope"]"#.utf8))
    expect(array.message == "HTTP 400", "顶层不是对象时也是默认文案")

    let timeout = MemohAPIError.timedOut(timeout: 15)
    expect(timeout.status == 0, "超时 status 0")
    expect(timeout.isNetwork, "超时算网络类")
    expect(timeout.code == "timeout", "超时 code")
    expect(timeout.message == "request timed out after 15000ms", "默认 15 秒的文案")
  }

  // MARK: - JSON 值

  private static func jsonValueRoundTrip() throws {
    let raw = #"{"n":1,"f":1.5,"s":"x","b":true,"z":null,"a":[1,"two"],"o":{"k":"v"}}"#
    let decoded = try JSONDecoder().decode(MemohJSONValue.self, from: Data(raw.utf8))
    let encoded = try JSONEncoder().encode(decoded)
    let reDecoded = try JSONDecoder().decode(MemohJSONValue.self, from: encoded)
    expect(decoded == reDecoded, "编解码往返相等")

    let text = String(decoding: encoded, as: UTF8.self)
    expect(text.contains(#""n":1"#), "整数 1 不许写成 1.0：\(text)")
    expect(text.contains(#""f":1.5"#), "小数照写")
    expect(text.contains(#""z":null"#), "null 是值，不是缺失")
    expect(text.contains(#""a":[1,"two"]"#), "数组里的整数也不许写成 1.0")

    // 字典顺序不影响相等（`.object` 天然如此）。
    let a = try JSONDecoder().decode(MemohJSONValue.self, from: Data(#"{"x":1,"y":2}"#.utf8))
    let b = try JSONDecoder().decode(MemohJSONValue.self, from: Data(#"{"y":2,"x":1}"#.utf8))
    expect(a == b, "键序无关")

    // 取值口不做隐式转换。
    expect(decoded.objectValue?["n"]?.numberValue == 1, "numberValue")
    expect(decoded.objectValue?["n"]?.stringValue == nil, "数字不隐式变成字符串")
    expect(decoded.objectValue?["b"]?.boolValue == true, "boolValue")
    expect(decoded.objectValue?["s"]?.stringValue == "x", "stringValue")
    expect(decoded.objectValue?["a"]?.arrayValue?.count == 2, "arrayValue")
    expect(decoded.objectValue?["z"]?.isNull == true, "isNull")
    expect(decoded.objectValue?["missing"] == nil, "缺键与 null 是两件事")

    // 超出 Int64 的整数值按浮点写（别崩、别截断）。
    let huge = try JSONDecoder().decode(MemohJSONValue.self, from: Data("1e30".utf8))
    let hugeEncoded = try JSONEncoder().encode(huge)
    expect(hugeEncoded.count > 0, "大数照样能编")
  }

  // MARK: - 队列规范化

  private static func queueNormalization() async throws {
    let raw = #"""
    {"follow_up":[{"item_id":"i1","text":"t1","position":0,"status":"accepted"},{}],
     "steer":[{"item_id":"i2","text":"t2","position":1,"status":"claimed"}],
     "steer_supported":true}
    """#
    MemohStubProtocol.reset([MemohStubProtocol.Response(body: Data(raw.utf8))])
    let queue = try await makeClient().getSessionQueue(botId: "b1", sessionId: "s1")
    expect(queue.followUp.count == 2, "follow_up 两项")
    expect(queue.followUp[0].itemId == "i1" && queue.followUp[0].kind == .followUp, "第一项")
    expect(
      queue.followUp[1].itemId == "" && queue.followUp[1].text == "" && queue.followUp[1].position == 0
        && queue.followUp[1].status == "",
      "缺字段用空串 / 0 兜底（照抄 TS 的 toQueueItem）"
    )
    expect(queue.steer.count == 1 && queue.steer[0].kind == .steer, "steer 的 kind 由数组决定")
    expect(queue.steerSupported, "steer_supported === true")

    // 规范化后的形状要能编成 TS 那份：camelCase 键 + `kind: "follow-up" / "steer"`。
    let encoded = String(decoding: try JSONEncoder().encode(queue), as: UTF8.self)
    expect(encoded.contains(#""followUp":"#), "规范化输出是 camelCase：\(encoded)")
    expect(encoded.contains(#""steerSupported":true"#), "steerSupported")
    expect(encoded.contains(#""kind":"follow-up""#), "kind 的线上取值")
    expect(encoded.contains(#""kind":"steer""#), "kind 的线上取值")

    // `steer_supported` 必须**严格等于 true**：`"true"` / `1` / 缺失都是 false。
    let loose: [(String, String)] = [
      ("字符串 \"true\"", #"{"steer_supported":"true"}"#),
      ("数字 1", #"{"steer_supported":1}"#),
      ("缺失", #"{}"#),
    ]
    for (label, body) in loose {
      MemohStubProtocol.reset([MemohStubProtocol.Response(body: Data(body.utf8))])
      let value = try await makeClient().getSessionQueue(botId: "b1", sessionId: "s1")
      expect(!value.steerSupported, "steer_supported 是 \(label) 时必须是 false")
      expect(value.followUp.isEmpty && value.steer.isEmpty, "缺数组 → 空数组")
    }
  }

  // MARK: - 模型解码

  private static func modelDecoding() throws {
    let decoder = JSONDecoder()

    // `avatar_url` / `timezone` / `current_user_permissions` 都是 omitempty：
    // 整个 key 不存在时**必须**解出来（这正是 avatar_url 炸过一次的地方）。
    let minimalBot = #"{"id":"b1","name":"n","display_name":"N","owner_user_id":"u","status":"ready","is_active":true,"check_state":"ok","check_issue_count":0,"created_at":"t","updated_at":"t"}"#
    let bot = try decoder.decode(Bot.self, from: Data(minimalBot.utf8))
    expect(bot.avatarURL == nil, "缺 avatar_url 要能解（String?）")
    expect(bot.timezone == nil, "缺 timezone 要能解")
    expect(bot.currentUserPermissions == nil, "缺 current_user_permissions 要能解（不是空数组）")

    let fullBot = #"{"id":"b1","name":"n","display_name":"N","avatar_url":"https://a/x.png","owner_user_id":"u","status":"ready","timezone":"Asia/Tokyo","is_active":true,"check_state":"ok","check_issue_count":0,"created_at":"t","updated_at":"t","metadata":{"k":1},"current_user_permissions":["chat"]}"#
    let rich = try decoder.decode(Bot.self, from: Data(fullBot.utf8))
    expect(rich.avatarURL == "https://a/x.png" && rich.timezone == "Asia/Tokyo", "有值时正常")
    expect(rich.currentUserPermissions == ["chat"], "权限数组")

    // Account 的 avatar_url / title_model_id 在 TS 里写成**非可选**，但真响应
    // （tools/api-fixtures/raw/me.json）里这两个键**根本不存在**——照抄成非可选会在真机上
    // 整次解码失败（就是 avatar_url 那一类）。所以这里反过来断言：**缺这两个键必须能解出来**，
    // 而且解成 nil。这条有第三方对照：tools/check-api-models.py 把非可选的写法报成不一致，
    // tools/api-parity-live.sh 的 me 行也复现。
    let account = #"{"id":"u1","username":"u","email":"e@x.co","role":"admin","display_name":"U","timezone":"UTC","is_active":true,"principal_is_active":true,"membership_is_active":true,"metadata":{},"created_at":"t","updated_at":"t","joined_at":"t","membership_updated_at":"t","last_login_at":"t"}"#
    let sparseAccount = try decoder.decode(Account.self, from: Data(account.utf8))
    expect(sparseAccount.avatarURL == nil, "缺 avatar_url 要能解（真响应就没有这个键）")
    expect(sparseAccount.titleModelID == nil, "缺 title_model_id 要能解（真响应就没有这个键）")

    // 名字可用性：**可用时服务端只发 `{"available": true}`**，`reason` 整个键不存在
    // （raw/name-availability-available.json）。四态里的第 4 态就是这个形状。
    let available = try decoder.decode(
      BotNameAvailability.self,
      from: Data(#"{"available":true}"#.utf8)
    )
    expect(available.reason == nil, "可用时没有 reason 键")
    let taken = try decoder.decode(
      BotNameAvailability.self,
      from: Data(#"{"available":false,"reason":"taken"}"#.utf8)
    )
    expect(taken.reason == "taken", "被占用时有 reason")

    // `createdSessionId` 的窄化规则。
    let idOnly = try decoder.decode(MemohJSONValue.self, from: Data(#"{"id":"x"}"#.utf8))
    expect(createdSessionId(idOnly) == "x", "id 优先")
    let sessionIdOnly = try decoder.decode(MemohJSONValue.self, from: Data(#"{"session_id":"y"}"#.utf8))
    expect(createdSessionId(sessionIdOnly) == "y", "其次 session_id")
    let both = try decoder.decode(MemohJSONValue.self, from: Data(#"{"id":"x","session_id":"y"}"#.utf8))
    expect(createdSessionId(both) == "x", "两个都有时 id 优先")
    let numericId = try decoder.decode(MemohJSONValue.self, from: Data(#"{"id":1}"#.utf8))
    expect(createdSessionId(numericId) == nil, "id 不是字符串 → nil")
    let array = try decoder.decode(MemohJSONValue.self, from: Data("[]".utf8))
    expect(createdSessionId(array) == nil, "数组 → nil")
    expect(createdSessionId(nil) == nil, "nil → nil")

    // 字面量联合：未知值要兜底，不许整次解码失败。
    let message = try decoder.decode(UIMessage.self, from: Data(#"{"id":1,"type":"brand_new"}"#.utf8))
    expect(message.type == .unknown("brand_new"), "未知 type 落到 .unknown")
    let unknownRole = try decoder.decode(UITurn.self, from: Data(#"{"turn_id":"t","role":"tool"}"#.utf8))
    expect(unknownRole.role == .unknown("tool"), "未知 role 落到 .unknown")
    let knownRole = try decoder.decode(UITurn.self, from: Data(#"{"turn_id":"t","role":"assistant"}"#.utf8))
    expect(knownRole.role == .assistant, "已知 role")

    // 联合形状：两种都要接受，且**不许拍平**（哪种是哪种要看得出来）。
    let bare = try decoder.decode(
      ModelListResponse.self,
      from: Data(#"[{"id":"m1","model_id":"x","name":"X","provider_id":"p1"}]"#.utf8)
    )
    guard case let .bare(bareItems) = bare else { fail("裸数组该走 .bare") }
    expect(bareItems.first?.id == "m1", "裸数组解出来了")
    let wrapped = try decoder.decode(
      ModelListResponse.self,
      from: Data(#"{"items":[{"id":"m1","model_id":"x","name":"X","provider_id":"p1"}]}"#.utf8)
    )
    guard case let .wrapped(wrappedItems) = wrapped else { fail("带 items 该走 .wrapped") }
    expect(wrappedItems.first?.modelId == "x", "包装形状解出来了")
    let emptyWrapper = try decoder.decode(ModelListResponse.self, from: Data("{}".utf8))
    guard case let .wrapped(none) = emptyWrapper else { fail("{} 该走 .wrapped（items 缺省 = 空）") }
    expect(none.isEmpty, "{} → 空列表")

    let providers = try decoder.decode(ProviderListResponse.self, from: Data(#"[{"id":"p1","name":"P"}]"#.utf8))
    guard case let .bare(providerItems) = providers else { fail("providers 裸数组该走 .bare") }
    expect(providerItems.first?.name == "P", "providers 解出来了")

    // 索引签名（`TokenUsage`）：未知键不许丢。
    let usage = try decoder.decode(
      TokenUsage.self,
      from: Data(#"{"input_tokens":10,"cost":0.5,"weird":{"deep":[1,null]}}"#.utf8)
    )
    expect(usage.inputTokens == 10 && usage.cost == 0.5, "已知字段")
    expect(usage.extra["weird"] != nil, "未知键收进 extra")
    let usageText = String(decoding: try JSONEncoder().encode(usage), as: UTF8.self)
    expect(usageText.contains(#""weird""#), "未知键要能编回去：\(usageText)")

    // 部署实测的最小 status 形状。
    let status = try decoder.decode(
      SessionStatus.self,
      from: Data(#"{"context_usage":{"used_tokens":42},"skills":["a"]}"#.utf8)
    )
    expect(status.contextUsage?.usedTokens == 42, "used_tokens")
    expect(status.contextUsage?.contextWindow == nil, "这台部署没有 context_window")
    expect(status.skills == ["a"], "skills 是字符串数组")

    // FileEntry 是全仓唯一的 camelCase 例外。
    let entry = try decoder.decode(
      FileEntry.self,
      from: Data(#"{"name":"a","path":"/a","isDir":false,"size":1,"modTime":"t"}"#.utf8)
    )
    expect(!entry.isDir && entry.size == 1 && entry.mode == nil, "FileEntry 的 camelCase 字段")

    // `RawQueueItem` 的解码（线上形状）。
    let rawItem = try decoder.decode(
      RawQueueItem.self,
      from: Data(#"{"item_id":"i","text":"t","position":2,"status":"accepted"}"#.utf8)
    )
    expect(rawItem.itemId == "i" && rawItem.position == 2, "RawQueueItem")
  }

  // MARK: - 夹具（raw → 解码 → 规范化 → 与 TS 的 expected 比）

  /// 夹具由并行的 agent 生成：`raw/<name>.json` 是原始响应，`expected/<name>.json` 是
  /// **TS 客户端**对同一 raw 的规范化输出（golden）。
  ///
  /// **目录不存在、manifest 为空、或某个夹具没跑到，都算失败**——静默跳过比失败更糟：
  /// 那会让人以为"解码与规范化已验证"，而实际上一条都没跑。
  private static func fixtures() async throws {
    let directory = toolsDirectory.appendingPathComponent("api-fixtures")
    guard FileManager.default.fileExists(atPath: directory.path) else {
      fail(
        """
        夹具目录不存在：\(directory.path)
        这一层（raw → Swift 解码 → 规范化 → 与 TS 的 expected 比）**没有跑**，
        所以解码与规范化的行为目前是未验证状态。夹具由另一个 agent 生成，
        落地后重跑本测试即可。
        """
      )
    }

    let manifestURL = directory.appendingPathComponent("manifest.json")
    guard let manifestData = try? Data(contentsOf: manifestURL) else {
      fail("读不到 \(manifestURL.path)")
    }
    let entries = try JSONDecoder().decode([FixtureEntry].self, from: manifestData)
    guard !entries.isEmpty else {
      fail("\(manifestURL.path) 里一个夹具都没有：这一层等于没跑")
    }

    let runnable = entries.filter { $0.source != "unavailable" }
    let unavailable = entries.filter { $0.source == "unavailable" }
    guard !runnable.isEmpty else {
      fail("manifest 里没有一个能跑的夹具（全被标成 unavailable）")
    }

    // raw/ 里多出来的文件说明"有人生成了夹具但没登记"——同样是"没被跑到"。
    let names = Set(runnable.map { $0.name })
    let rawNames = try fixtureFileNames(in: directory.appendingPathComponent("raw"))
    let orphaned = rawNames.subtracting(names).sorted()
    guard orphaned.isEmpty else {
      fail("这些 raw 夹具没有被 manifest 覆盖，等于没被跑到：\(orphaned.joined(separator: ", "))")
    }

    let client = MemohAPIClient(
      baseURL: "https://fixture.invalid",
      tokenProvider: { "contract-token" },
      session: stubSession()
    )

    // `source: unavailable` 的条目没有样本（例如这台部署的上游镜像比源码旧，没有 `/queue`
    // 路由）。跳过它们，但先断言"确实没有文件"——否则 unavailable 会变成把夹具藏起来的借口。
    for entry in unavailable {
      for kind in ["raw", "expected"] {
        let path = directory.appendingPathComponent("\(kind)/\(entry.name).json")
        guard !FileManager.default.fileExists(atPath: path.path) else {
          fail("夹具 \(entry.name) 标了 source=unavailable，却存在 \(kind) 文件——两者只能有一个是真的")
        }
      }
    }
    if !unavailable.isEmpty {
      print("跳过 \(unavailable.count) 个取不到真样本的夹具（source=unavailable）：")
      for entry in unavailable {
        print("  · \(entry.name)：\(entry.reason ?? "（manifest 没写理由）")")
      }
    }

    var dropReport: [String] = []
    var unexplained: [String] = []
    for entry in runnable {
      let rawURL = directory.appendingPathComponent("raw/\(entry.name).json")
      let expectedURL = directory.appendingPathComponent("expected/\(entry.name).json")
      guard let raw = try? Data(contentsOf: rawURL) else {
        fail("夹具 \(entry.name)：读不到 \(rawURL.path)")
      }
      guard let expected = try? Data(contentsOf: expectedURL) else {
        fail("夹具 \(entry.name)：读不到 \(expectedURL.path)")
      }

      MemohStubProtocol.reset([MemohStubProtocol.Response(status: 200, body: raw)])
      let actual: Data
      do {
        actual = try await normalizedJSON(endpoint: entry.endpoint, call: entry.call, client: client)
      } catch {
        fail("夹具 \(entry.name)（\(entry.endpoint)）：Swift 侧解码/规范化抛错：\(error)")
      }
      let dropped = try compareSemantically(
        label: "夹具 \(entry.name)（\(entry.endpoint)）",
        actual: actual,
        expected: expected
      )
      if !dropped.isEmpty {
        // 丢键**不是**静默通过：它在这里被点名，而且必须能在 `unmodeledKeys` 里找到理由。
        guard let reason = unmodeledKeys[entry.endpoint] else {
          unexplained.append("  · \(entry.name)（\(entry.endpoint)）：\(dropped.joined(separator: ", "))")
          continue
        }
        dropReport.append(
          "  · \(entry.name)（\(entry.endpoint)）丢了 \(dropped.count) 个键：\(dropped.joined(separator: ", "))"
        )
        dropReport.append("      理由：\(reason)")
      }
    }

    if !unexplained.isEmpty {
      fail(
        """
        Swift 的规范化输出丢了这些键，而这些端点不在 `unmodeledKeys` 里
        （也就没人解释过为什么可以丢）：
        \(unexplained.joined(separator: "\n"))
        要么把字段补进模型，要么在 tools/test-api-contract.swift 的 `unmodeledKeys` 里写理由。
        """
      )
    }

    print("夹具比对通过：\(runnable.count) 个（raw → Swift 解码 → 规范化 → 与 TS 的 expected 逐字段比）")
    if !dropReport.isEmpty {
      print("其中 typed 模型**故意未建模**的键（是收窄视图，不是差异；逐条有理由）：")
      for line in dropReport { print(line) }
    }
  }

  /// "Swift 的 typed 模型故意没有这些键"的端点 → 理由。
  ///
  /// 为什么需要这张表：typed 模型是**收窄视图**（只列界面真会读写的字段；`tools/check-api-models.py`
  /// 的 ALLOWLIST 是同一件事的另一份表述）。于是"规范化输出"必然比 raw 少几个键——这是设计，
  /// 不是差异。但"少了一个没人解释过的键"很可能是模型漏字段，那种必须当场失败。
  ///
  /// 放行的只有"expected 有、Swift 没有"这一种情况；这些端点的**已知字段仍然逐字段严格比对**
  /// （值不等、Swift 多出键、数组长度不等都会失败）。
  private static let unmodeledKeys: [String: String] = [
    "getBotSettings":
      "TS 的 BotSettings 只建模界面用到的子集（模型/语言/时区/显示开关）；"
      + "其余 19 个键是服务端设置项（压缩、记忆、TTS、overlay、provider 引用…），本片不发明字段",
    "getContainer":
      "TS 的 ContainerStatus 只要 container_id/status/namespace/container_path/image/task_running；"
      + "其余（created_at/updated_at/has_preserved_data/legacy/runtime_backend/workspace_backend）是容器后端细节",
    "getContainerMetrics":
      "TS 的 ContainerMetrics 未建模 sampled_at / status / unsupported_reason，"
      + "也没建模 metrics.* 与 resource_limits.* 里除 cpu.usage_percent / memory.usage_bytes / "
      + "storage.used_bytes / *.limit 之外的读数（nanoseconds、nanocores、applied、desired、observed…）——"
      + "界面只画百分比与配额，那些是容器后端的原始读数",
    "listProviders":
      "TS 的 ProviderSummary 只要 id/name/client_type/enable；"
      + "config（含密钥，夹具已删）/created_at/updated_at/icon/metadata/provider_template_id 是管理面字段",
    "getDisplay":
      "TS 的 DisplayCapability 未建模 prepare_system（桌面准备用的系统标识，界面不显示）",
  ]

  /// manifest 里的一条。
  private struct FixtureEntry: Decodable {
    let name: String
    let endpoint: String
    let call: [String: MemohJSONValue]
    /// `dev-instance`（有样本）或 `unavailable`（取不到真样本，没有 raw/expected）。
    let source: String
    /// `unavailable` 的原因（原样打出来，别让"跳过"变成无声）。
    let reason: String?

    enum CodingKeys: String, CodingKey {
      case name
      case endpoint
      case call
      case source
      case reason
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      name = try container.decode(String.self, forKey: .name)
      endpoint = try container.decode(String.self, forKey: .endpoint)
      call = try container.decodeIfPresent([String: MemohJSONValue].self, forKey: .call) ?? [:]
      source = try container.decodeIfPresent(String.self, forKey: .source) ?? "dev-instance"
      reason = try container.decodeIfPresent(String.self, forKey: .reason)
    }
  }

  private static func fixtureFileNames(in directory: URL) throws -> Set<String> {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else {
      fail("读不到夹具目录：\(directory.path)")
    }
    var out: Set<String> = []
    for name in names where name.hasSuffix(".json") {
      out.insert(String(name.dropLast(".json".count)))
    }
    return out
  }

  /// JSON 语义比较：键序无关（字典天然如此）、`1` 与 `1.0` 等价（两者都落到 `.number(Double)`）。
  ///
  /// 返回值是"expected 有、Swift 没有"的键路径（**丢键**）——调用方负责判断这些键有没有
  /// 被解释过（见 `unmodeledKeys`）。丢键不在这里判死，是因为 typed 模型本来就是收窄视图；
  /// 但**值不相等、Swift 多出键、数组长度不等**都在这里当场失败：那些是行为差异。
  @discardableResult
  private static func compareSemantically(label: String, actual: Data, expected: Data) throws -> [String] {
    let decoder = JSONDecoder()
    guard let actualValue = try? decoder.decode(MemohJSONValue.self, from: actual) else {
      fail("\(label)：Swift 的输出不是合法 JSON：\(String(decoding: actual, as: UTF8.self))")
    }
    guard let expectedValue = try? decoder.decode(MemohJSONValue.self, from: expected) else {
      fail("\(label)：expected 不是合法 JSON")
    }
    if actualValue == expectedValue { return [] }

    var differences: [String] = []
    var dropped: [String] = []
    collectDifferences(
      path: "$",
      actual: actualValue,
      expected: expectedValue,
      differences: &differences,
      dropped: &dropped
    )
    if !differences.isEmpty {
      fail("\(label)：规范化结果与 TS 不一致\n" + differences.prefix(8).joined(separator: "\n"))
    }
    return dropped
  }

  private static func collectDifferences(
    path: String,
    actual: MemohJSONValue,
    expected: MemohJSONValue,
    differences: inout [String],
    dropped: inout [String]
  ) {
    if actual == expected { return }
    if case let .object(actualFields) = actual, case let .object(expectedFields) = expected {
      for key in Set(actualFields.keys).union(expectedFields.keys).sorted() {
        let here = "\(path).\(key)"
        guard let actualValue = actualFields[key] else {
          dropped.append(here)
          continue
        }
        guard let expectedValue = expectedFields[key] else {
          differences.append("  \(here)：Swift 多出这个键")
          continue
        }
        collectDifferences(
          path: here,
          actual: actualValue,
          expected: expectedValue,
          differences: &differences,
          dropped: &dropped
        )
      }
      return
    }
    if case let .array(actualItems) = actual, case let .array(expectedItems) = expected {
      if actualItems.count != expectedItems.count {
        differences.append("  \(path)：数组长度 \(actualItems.count) vs \(expectedItems.count)")
        return
      }
      for index in actualItems.indices {
        collectDifferences(
          path: "\(path)[\(index)]",
          actual: actualItems[index],
          expected: expectedItems[index],
          differences: &differences,
          dropped: &dropped
        )
      }
      return
    }
    // 形状不同（一边是对象一边是标量、数字与字符串…）也算差异：这不是"收窄"，是解错了。
    if dropped.isEmpty {
      differences.append("  \(path)：Swift=\(describe(actual)) TS=\(describe(expected))")
    }
  }

  private static func describe(_ value: MemohJSONValue) -> String {
    if let data = try? JSONEncoder().encode(value) {
      return String(decoding: data, as: UTF8.self)
    }
    return "<无法编码>"
  }

  /// 动态端点返回 `nil`（空体 / JSON `null`）时，规范化输出按 `null` 落盘。
  private static func encodeOptionalObject(_ value: [String: MemohJSONValue]?) throws -> Data {
    guard let value else { return Data("null".utf8) }
    return try JSONEncoder().encode(value)
  }

  private static func encodeOptionalValue(_ value: MemohJSONValue?) throws -> Data {
    guard let value else { return Data("null".utf8) }
    return try JSONEncoder().encode(value)
  }

  /// 按 manifest 的 `endpoint` 派发到 Swift 的对应方法，返回**规范化后的 JSON**。
  ///
  /// 未知 endpoint 直接失败：漏掉一个夹具比报错更糟。
  private static func normalizedJSON(
    endpoint: String,
    call: [String: MemohJSONValue],
    client: MemohAPIClient
  ) async throws -> Data {
    let encoder = JSONEncoder()
    switch endpoint {
    case "getSessionQueue":
      return try encoder.encode(
        try await client.getSessionQueue(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id")
        )
      )
    case "getSettings":
      return try encodeOptionalObject(try await client.getSettings(botId: text(call, "botId", "bot_id")))
    case "updateSettings":
      return try encodeOptionalObject(
        try await client.updateSettings(botId: text(call, "botId", "bot_id"), body: body(call))
      )
    case "getSessionStatus":
      return try encoder.encode(
        try await client.getSessionStatus(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id")
        )
      )
    case "sessionStatus":
      return try encodeOptionalObject(
        try await client.sessionStatus(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id")
        )
      )
    case "me":
      return try encoder.encode(try await client.me())
    case "listBots":
      return try encoder.encode(try await client.listBots())
    case "getBot":
      return try encoder.encode(try await client.getBot(botId: text(call, "botId", "bot_id")))
    case "createBot":
      return try encoder.encode(
        try await client.createBot(
          body: BotCreateRequest(
            name: text(call, "name"),
            displayName: text(call, "displayName", "display_name")
          )
        )
      )
    case "updateBot":
      return try encoder.encode(
        try await client.updateBot(botId: text(call, "botId", "bot_id"), body: BotUpdateRequest())
      )
    case "getBotSettings":
      return try encoder.encode(try await client.getBotSettings(botId: text(call, "botId", "bot_id")))
    case "updateBotSettings":
      return try encoder.encode(
        try await client.updateBotSettings(botId: text(call, "botId", "bot_id"), body: body(call))
      )
    case "listBotChecks":
      return try encoder.encode(try await client.listBotChecks(botId: text(call, "botId", "bot_id")))
    case "checkBotNameAvailability":
      return try encoder.encode(
        try await client.checkBotNameAvailability(
          name: text(call, "name"),
          excludeBotId: optionalText(call, "excludeBotId", "exclude_bot_id")
        )
      )
    case "listSessions":
      return try encoder.encode(
        try await client.listSessions(
          botId: text(call, "botId", "bot_id"),
          limit: optionalNumber(call, "limit"),
          cursor: optionalText(call, "cursor")
        )
      )
    case "getSession":
      return try encoder.encode(
        try await client.getSession(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id")
        )
      )
    case "listModels":
      return try encoder.encode(try await client.listModels())
    case "listProviders":
      return try encoder.encode(try await client.listProviders())
    case "getContainer":
      return try encoder.encode(try await client.getContainer(botId: text(call, "botId", "bot_id")))
    case "getContainerMetrics":
      return try encoder.encode(try await client.getContainerMetrics(botId: text(call, "botId", "bot_id")))
    case "getDisplay":
      return try encoder.encode(try await client.getDisplay(botId: text(call, "botId", "bot_id")))
    case "listSkills":
      return try encoder.encode(try await client.listSkills(botId: text(call, "botId", "bot_id")))
    case "listMessages":
      return try encoder.encode(
        try await client.listMessages(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id"),
          limit: optionalNumber(call, "limit"),
          beforeMessageId: queryValue(call, "beforeMessageId", "before_message_id")
        )
      )
    case "createSession":
      return try encodeOptionalValue(
        try await client.createSession(botId: text(call, "botId", "bot_id"), body: body(call))
      )
    case "updateSession":
      return try encodeOptionalValue(
        try await client.updateSession(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id"),
          body: body(call)
        )
      )
    case "forkSession":
      return try encoder.encode(
        try await client.forkSession(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id"),
          turnId: text(call, "turnId", "turn_id"),
          title: optionalText(call, "title")
        )
      )
    case "deleteSession":
      // `Void`：规范化输出就是"没有体"。
      try await client.deleteSession(
        botId: text(call, "botId", "bot_id"),
        sessionId: text(call, "sessionId", "session_id")
      )
      return Data("null".utf8)
    case "compactSession":
      return try encoder.encode(
        try await client.compactSession(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id")
        )
      )
    case "tokenUsage":
      return try encodeOptionalObject(try await client.tokenUsage(botId: text(call, "botId", "bot_id")))
    case "listFiles":
      return try encodeOptionalObject(
        try await client.listFiles(botId: text(call, "botId", "bot_id"), path: text(call, "path"))
      )
    case "readFile":
      return try encodeOptionalObject(
        try await client.readFile(botId: text(call, "botId", "bot_id"), path: text(call, "path"))
      )
    case "statFile":
      return try encodeOptionalObject(
        try await client.statFile(botId: text(call, "botId", "bot_id"), path: text(call, "path"))
      )
    case "listSchedules":
      return try encodeOptionalObject(try await client.listSchedules(botId: text(call, "botId", "bot_id")))
    case "getSchedule":
      return try encodeOptionalObject(
        try await client.getSchedule(
          botId: text(call, "botId", "bot_id"),
          scheduleId: text(call, "scheduleId", "schedule_id")
        )
      )
    case "createSchedule":
      return try encodeOptionalObject(
        try await client.createSchedule(botId: text(call, "botId", "bot_id"), body: body(call))
      )
    case "updateSchedule":
      return try encodeOptionalObject(
        try await client.updateSchedule(
          botId: text(call, "botId", "bot_id"),
          scheduleId: text(call, "scheduleId", "schedule_id"),
          body: body(call)
        )
      )
    case "deleteSchedule":
      return try encodeOptionalValue(
        try await client.deleteSchedule(
          botId: text(call, "botId", "bot_id"),
          scheduleId: text(call, "scheduleId", "schedule_id")
        )
      )
    case "listScheduleLogs":
      return try encodeOptionalObject(
        try await client.listScheduleLogs(
          botId: text(call, "botId", "bot_id"),
          limit: optionalNumber(call, "limit"),
          offset: optionalNumber(call, "offset")
        )
      )
    case "enqueueFollowUp":
      return try encoder.encode(
        try await client.enqueueFollowUp(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id"),
          text: text(call, "text"),
          invocationId: text(call, "invocationId", "invocation_id")
        )
      )
    case "enqueueSteer":
      return try encoder.encode(
        try await client.enqueueSteer(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id"),
          text: text(call, "text"),
          invocationId: text(call, "invocationId", "invocation_id")
        )
      )
    case "promoteQueueItem":
      return try encoder.encode(
        try await client.promoteQueueItem(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id"),
          itemId: text(call, "itemId", "item_id")
        )
      )
    case "deleteQueueItem":
      return try encodeOptionalValue(
        try await client.deleteQueueItem(
          botId: text(call, "botId", "bot_id"),
          sessionId: text(call, "sessionId", "session_id"),
          kind: queueKind(text(call, "kind")),
          itemId: text(call, "itemId", "item_id")
        )
      )
    case "deleteBot":
      return try encodeOptionalValue(try await client.deleteBot(botId: text(call, "botId", "bot_id")))
    case "login":
      return try encoder.encode(
        try await client.login(username: text(call, "username"), password: text(call, "password"))
      )
    case "refresh":
      return try encoder.encode(try await client.refresh())
    default:
      fail(
        """
        夹具里出现了未知 endpoint：\(endpoint)
        在 tools/test-api-contract.swift 的 normalizedJSON 里补上它对应的 Swift 调用——
        没有这一支，这个夹具就等于没被跑到。
        """
      )
    }
  }

  // MARK: - 夹具参数取值

  /// 从 manifest 的 `call` 里取一个字符串。缺了就失败——不猜默认值（猜出来的参数会让
  /// 夹具打到一个不是它本意的端点上，然后"通过"）。
  private static func text(_ call: [String: MemohJSONValue], _ names: String...) -> String {
    for name in names {
      if case let .string(value)? = call[name] { return value }
    }
    fail("夹具的 call 里缺少字符串参数 \(names.joined(separator: " / "))")
  }

  private static func optionalText(_ call: [String: MemohJSONValue], _ names: String...) -> String? {
    for name in names {
      if case let .string(value)? = call[name] { return value }
    }
    return nil
  }

  private static func optionalNumber(_ call: [String: MemohJSONValue], _ names: String...) -> Int? {
    for name in names {
      if case let .number(value)? = call[name] { return Int(value) }
    }
    return nil
  }

  private static func queryValue(
    _ call: [String: MemohJSONValue],
    _ names: String...
  ) -> MemohQueryValue? {
    for name in names {
      if case let .string(value)? = call[name] { return .text(value) }
      if case let .number(value)? = call[name] { return .number(Int(value)) }
    }
    return nil
  }

  /// 写操作夹具的请求体；`call` 里没有 `body` 就发空对象。
  private static func body(_ call: [String: MemohJSONValue]) -> [String: MemohJSONValue] {
    if case let .object(fields)? = call["body"] { return fields }
    return [:]
  }

  private static func queueKind(_ raw: String) -> MemohQueueItemKind {
    if raw == "steer" { return .steer }
    return .followUp
  }

  // MARK: - 桩与工具

  private static let toolsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

  private static func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MemohStubProtocol.self]
    return URLSession(configuration: configuration)
  }

  private static func makeClient(
    onUnauthorized: (@Sendable () -> Void)? = nil
  ) -> MemohAPIClient {
    MemohAPIClient(
      baseURL: "https://memoh.example.com",
      tokenProvider: { "contract-token" },
      onUnauthorized: onUnauthorized,
      session: stubSession()
    )
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fail(message) }
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("API contract failure: \(message)\n".utf8))
    exit(1)
  }
}

/// `onUnauthorized` 被调了几次。闭包是 `@Sendable` 的，所以用一个带锁的盒子装计数。
private final class FlagBox: @unchecked Sendable {
  private let lock = NSLock()
  private var raised = 0

  func raise() {
    lock.lock()
    raised += 1
    lock.unlock()
  }

  func reset() {
    lock.lock()
    raised = 0
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return raised
  }

  var value: Bool {
    count > 0
  }
}

/// 请求桩：记下每个 `URLRequest`，回预置响应。
///
/// 为什么不用一个本地 HTTP 服务：契约测试必须**离线**跑得起来（CI 上没有 dev 实例），
/// 而且"服务端到底收到了什么"这件事只有桩能逐字回答。
///
/// 坑：`URLProtocol` 里 `request.httpBody` **是 nil**，体只留在 `httpBodyStream` 上——
/// 实测确认过。所以这里要把流读出来，否则所有"体对不对"的断言都会变成"没有体"。
final class MemohStubProtocol: URLProtocol {
  struct Response {
    var status = 200
    var body: Data? = Data("{}".utf8)
    var delay: TimeInterval = 0
    var failure: Error?

    init(status: Int = 200, body: Data? = Data("{}".utf8), delay: TimeInterval = 0, failure: Error? = nil) {
      self.status = status
      self.body = body
      self.delay = delay
      self.failure = failure
    }
  }

  struct Call {
    let method: String
    let url: String
    let headers: [String: String]
    let body: Data?
  }

  private static let lock = NSLock()
  private static var responses: [Response] = []
  private static var calls: [Call] = []

  static func reset(_ next: [Response]) {
    lock.lock()
    responses = next
    calls = []
    lock.unlock()
  }

  static func recorded() -> [Call] {
    lock.lock()
    defer { lock.unlock() }
    return calls
  }

  private static func takeResponse() -> Response {
    lock.lock()
    defer { lock.unlock() }
    if responses.isEmpty { return Response() }
    return responses.removeFirst()
  }

  private static func record(_ call: Call) {
    lock.lock()
    calls.append(call)
    lock.unlock()
  }

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    let body = MemohStubProtocol.drain(request.httpBodyStream)
    MemohStubProtocol.record(
      Call(
        method: request.httpMethod ?? "GET",
        url: request.url?.absoluteString ?? "",
        headers: request.allHTTPHeaderFields ?? [:],
        body: body
      )
    )

    let response = MemohStubProtocol.takeResponse()
    let targetURL = request.url ?? URL(string: "https://memoh.example.com")!
    let send = {
      if let failure = response.failure {
        self.client?.urlProtocol(self, didFailWithError: failure)
        return
      }
      let http = HTTPURLResponse(
        url: targetURL,
        statusCode: response.status,
        httpVersion: nil,
        headerFields: nil
      )!
      self.client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
      if let body = response.body, !body.isEmpty {
        self.client?.urlProtocol(self, didLoad: body)
      }
      self.client?.urlProtocolDidFinishLoading(self)
    }

    if response.delay > 0 {
      DispatchQueue.global().asyncAfter(deadline: .now() + response.delay, execute: send)
    } else {
      send()
    }
  }

  override func stopLoading() {}

  private static func drain(_ stream: InputStream?) -> Data? {
    guard let stream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read <= 0 { break }
      data.append(buffer, count: read)
    }
    return data.isEmpty ? nil : data
  }
}
