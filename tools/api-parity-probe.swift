import Foundation

/// 真联调探针：用 **Swift 客户端**打一批端点，把结果按行（NDJSON）吐到 stdout。
///
/// 它只做一件事：让 `tools/api-parity-live.sh` 能把"同一批请求、同一批参数"分别交给
/// TS 客户端和 Swift 客户端，再逐字段比结果。所以调用清单**从环境变量来**
/// （`MEMOH_CALLS`，JSON），而不是写死在代码里——写死就会出现"TS 跑的是 A 清单、
/// Swift 跑的是 B 清单"，那样的对比是在比两份清单，不是在比两个客户端。
///
/// ## 凭据
///
/// token 只从环境变量 `MEMOH_TOKEN` 读（或 stdin 的第一行），**不走命令行参数**：
/// 参数会出现在 `ps` 的输出里，环境变量只对同用户可见。探针不打印 token，也不把它
/// 写进任何输出——输出的只有端点名、结果 JSON、错误字段。
///
/// ## 输出
///
/// 每行一个 JSON 对象：
///   `{"name":"me","ok":true,"result":{...}}`
///   `{"name":"stat-file-missing","ok":false,"error":{"status":404,"code":null,"message":"Not Found"}}`
///
/// **错误是数据不是失败**：端点回 404/400 时探针照样退出 0——"两边对同一个错误给出同样的
/// 映射"本身就是要验证的东西之一。唯一会非零退出的情况是环境变量/参数本身不对。
///
/// 用法（由 api-parity-live.sh 调用，一般不手跑）：
///   MEMOH_BASE_URL=http://127.0.0.1:18080 MEMOH_TOKEN=… MEMOH_CALLS='[…]' api-parity-probe
struct ProbeCall: Decodable {
  let name: String
  let call: String
  let args: [String: MemohJSONValue]?
}

@main
struct MemohAPIParityProbe {
  static func main() async {
    let env = ProcessInfo.processInfo.environment
    let baseURL = env["MEMOH_BASE_URL"] ?? "http://127.0.0.1:18080"

    var resolvedToken: String? = env["MEMOH_TOKEN"]
    if resolvedToken == nil, let line = readLine(strippingNewline: true), !line.isEmpty {
      resolvedToken = line
    }
    let token: String? = resolvedToken

    guard let callsJSON = env["MEMOH_CALLS"], let callsData = callsJSON.data(using: .utf8) else {
      FileHandle.standardError.write(Data("缺少 MEMOH_CALLS（JSON 数组）\n".utf8))
      exit(2)
    }
    let calls: [ProbeCall]
    do {
      calls = try JSONDecoder().decode([ProbeCall].self, from: callsData)
    } catch {
      FileHandle.standardError.write(Data("MEMOH_CALLS 解析失败：\(error)\n".utf8))
      exit(2)
    }

    let client = MemohAPIClient(baseURL: baseURL, tokenProvider: { token })

    for call in calls {
      let line = await run(call, client: client)
      FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
  }

  /// 跑一个调用，返回一行 JSON。这里不抛错：失败也编码成数据。
  static func run(_ call: ProbeCall, client: MemohAPIClient) async -> String {
    do {
      let value = try await dispatch(call, client: client)
      return encode(call, ok: true, value: value, error: nil)
    } catch let error as MemohAPIError {
      return encode(call, ok: false, value: nil,
                    error: ["status": error.status, "code": error.code as Any, "message": error.message])
    } catch {
      // 非 MemohAPIError：多半是解码失败（typed 模型与真响应不一致）。
      // 这类错误**必须报出来**——它正是"模型写错"的信号，吞掉就白跑联调了。
      return encode(call, ok: false, value: nil,
                    error: ["status": 0, "code": "decode", "message": "\(error)"])
    }
  }

  /// `args` 原样回显：比对脚本靠它识别"这个端点只比结构"（`volatile`）之类的元信息。
  static func encode(_ call: ProbeCall, ok: Bool, value: MemohJSONValue?, error: [String: Any]?) -> String {
    var object: [String: Any] = ["name": call.name, "ok": ok]
    object["args"] = call.args.map { $0.mapValues(jsonObject(from:)) } ?? [:]
    if ok {
      object["result"] = value.map(jsonObject(from:)) ?? NSNull()
    } else {
      object["error"] = error ?? [:]
    }
    let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return data.flatMap { String(data: $0, encoding: .utf8) }
      ?? "{\"name\":\"\(call.name)\",\"ok\":false,\"error\":{\"status\":0,\"code\":\"encode\",\"message\":\"结果无法序列化\"}}"
  }

  /// `MemohJSONValue` → `JSONSerialization` 能吃的对象（保持整数/浮点的区分）。
  static func jsonObject(from value: MemohJSONValue) -> Any {
    switch value {
    case let .string(v): return v
    case let .bool(v): return v
    case let .number(v):
      if v.rounded() == v, v >= -9.007199254740992e15, v <= 9.007199254740992e15 {
        return Int(v)
      }
      return v
    case let .array(items): return items.map(jsonObject(from:))
    case let .object(map): return map.mapValues(jsonObject(from:))
    case .null: return NSNull()
    }
  }

  // MARK: - 调用分发
  //
  // 与 `tools/api-parity-live.sh` 里 TS 侧的 `dispatch` 表一一对应：加端点要两边都加，
  // 只加一边会被比对表当成"一边缺这个端点"报出来。

  static func dispatch(_ call: ProbeCall, client: MemohAPIClient) async throws -> MemohJSONValue? {
    let args = call.args ?? [:]
    func text(_ key: String) -> String { args[key]?.stringValue ?? "" }
    func int(_ key: String) -> Int? { args[key]?.numberValue.map { Int($0) } }

    switch call.call {
    case "me":
      return try encodeValue(await client.me())
    case "listBots":
      return try encodeValue(await client.listBots())
    case "listSessions":
      return try encodeValue(await client.listSessions(botId: text("botId"), limit: int("limit")))
    case "getSession":
      return try encodeValue(await client.getSession(botId: text("botId"), sessionId: text("sessionId")))
    case "listMessages":
      return try encodeValue(await client.listMessages(botId: text("botId"),
                                                       sessionId: text("sessionId"),
                                                       limit: int("limit")))
    case "getSessionStatus":
      return try encodeValue(await client.getSessionStatus(botId: text("botId"), sessionId: text("sessionId")))
    case "sessionStatus":
      return try encodeOptional(await client.sessionStatus(botId: text("botId"), sessionId: text("sessionId")))
    case "getBotSettings":
      return try encodeValue(await client.getBotSettings(botId: text("botId")))
    case "getContainer":
      return try encodeValue(await client.getContainer(botId: text("botId")))
    case "getContainerMetrics":
      return try encodeValue(await client.getContainerMetrics(botId: text("botId")))
    case "getDisplay":
      return try encodeValue(await client.getDisplay(botId: text("botId")))
    case "listBotChecks":
      return try encodeValue(await client.listBotChecks(botId: text("botId")))
    case "listSkills":
      return try encodeValue(await client.listSkills(botId: text("botId")))
    case "listFiles":
      return try encodeOptional(await client.listFiles(botId: text("botId"), path: text("path")))
    case "readFile":
      return try encodeOptional(await client.readFile(botId: text("botId"), path: text("path")))
    case "statFile":
      return try encodeOptional(await client.statFile(botId: text("botId"), path: text("path")))
    case "listModels":
      return try encodeValue(await client.listModels())
    case "listProviders":
      return try encodeValue(await client.listProviders())
    case "listSchedules":
      return try encodeOptional(await client.listSchedules(botId: text("botId")))
    case "getSchedule":
      return try encodeOptional(await client.getSchedule(botId: text("botId"),
                                                         scheduleId: text("scheduleId")))
    case "listScheduleLogs":
      return try encodeOptional(await client.listScheduleLogs(botId: text("botId"), limit: int("limit")))
    case "checkBotNameAvailability":
      return try encodeValue(await client.checkBotNameAvailability(name: text("name")))
    case "getSessionQueue":
      return try encodeValue(await client.getSessionQueue(botId: text("botId"), sessionId: text("sessionId")))
    case "tokenUsage":
      return try encodeOptional(await client.tokenUsage(botId: text("botId")))
    case "createDeleteSession":
      return try await createDeleteSession(client: client, botId: text("botId"))
    default:
      throw MemohAPIError(status: 0, message: "探针没有实现这个调用：\(call.call)",
                          code: "unknown-call")
    }
  }

  /// 建一个临时会话再删掉——写路径唯一被覆盖的地方（GET 之外的东西）。
  ///
  /// 只回 `{id_found, deleted}`：两次运行拿到的会话 id 本来就不同，把 id 比进表里只会
  /// 得到一条永远红的差异。真正要比的是"两边都能从响应里取出 id、都能删掉"。
  static func createDeleteSession(client: MemohAPIClient, botId: String) async throws -> MemohJSONValue? {
    let created = try await client.createSession(
      botId: botId,
      body: ["title": .string("9B-1 联调临时会话（可删）")]
    )
    guard let id = createdSessionId(created) else {
      return .object(["id_found": .bool(false), "deleted": .bool(false)])
    }
    try await client.deleteSession(botId: botId, sessionId: id)
    return .object(["id_found": .bool(true), "deleted": .bool(true)])
  }

  /// `id` 优先，其次 `session_id`，都不是字符串 → nil（照抄 TS 的 `createdSessionId`）。
  static func createdSessionId(_ value: MemohJSONValue?) -> String? {
    guard case let .object(record)? = value else { return nil }
    if case let .string(id)? = record["id"] { return id }
    if case let .string(id)? = record["session_id"] { return id }
    return nil
  }

  /// 把可编码的值编成 `MemohJSONValue`：走 `JSONEncoder` → `JSONDecoder`，
  /// 于是输出里的键名就是 `CodingKeys` 的线上名（snake_case），能与 TS 的解析结果对齐。
  static func encodeValue<T: Encodable>(_ value: T) throws -> MemohJSONValue {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(MemohJSONValue.self, from: data)
  }

  /// 动态端点（返回 `[String: MemohJSONValue]?`）用这个：`nil`（204/空体）→ `.null`。
  /// 直接 `encodeValue` 一个顶层 Optional 会让 `JSONEncoder` 抛"顶层值没编码"。
  static func encodeOptional<T: Encodable>(_ value: T?) throws -> MemohJSONValue {
    guard let value else { return .null }
    return try encodeValue(value)
  }
}
