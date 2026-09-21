import Foundation

/// The session shape shared by native authentication and the temporary RN application bridge.
/// Property names intentionally match the existing `memoh.session.v1` JSON payload.
struct AuthSession: Codable, Equatable, Sendable {
  let baseUrl: String
  let token: String
  let expiresAt: String
  let userId: String
  let username: String
  let displayName: String
  let role: String
  let timezone: String

  var isValid: Bool {
    !baseUrl.isEmpty && !token.isEmpty && !expiresAt.isEmpty && !userId.isEmpty && !username.isEmpty
  }

  static func decode(_ json: String) throws -> AuthSession {
    let session = try JSONDecoder().decode(AuthSession.self, from: Data(json.utf8))
    guard session.isValid else { throw AuthContractError.invalidSession }
    return session
  }

  func json() throws -> String {
    let data = try JSONEncoder().encode(self)
    guard let value = String(data: data, encoding: .utf8) else {
      throw AuthContractError.invalidSession
    }
    return value
  }
}

/// `/auth/login` uses snake_case and requires the full profile because refresh returns only a token.
struct AuthLoginResponse: Decodable, Sendable {
  let accessToken: String
  let expiresAt: String
  let userId: String
  let username: String
  let displayName: String
  let role: String
  let timezone: String

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case expiresAt = "expires_at"
    case userId = "user_id"
    case username
    case displayName = "display_name"
    case role
    case timezone
  }

  func session(baseURL: String) throws -> AuthSession {
    let value = AuthSession(
      baseUrl: baseURL,
      token: accessToken,
      expiresAt: expiresAt,
      userId: userId,
      username: username,
      displayName: displayName,
      role: role,
      timezone: timezone
    )
    guard value.isValid else { throw AuthContractError.invalidSession }
    return value
  }
}

enum AuthContractError: Error {
  case invalidSession
}

enum ServerInputProblem: Error, Equatable {
  case empty
  case invalid
}

struct NormalizedAuthServer: Equatable, Sendable {
  let baseURL: String
  let origin: String
  let explicitPath: Bool
  let local: Bool
  let port: Int?

  var discoveryCandidates: [String] {
    if explicitPath { return [baseURL] }
    let rootFirst = local || port == 8080 || port == 18080
    return rootFirst ? [origin, "\(origin)/api"] : ["\(origin)/api", origin]
  }
}

enum AuthServerContract {
  private static let schemePattern = #"^[A-Za-z][A-Za-z0-9+.-]*://"#

  static func normalize(_ rawValue: String) throws -> NormalizedAuthServer {
    let input = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !input.isEmpty else { throw ServerInputProblem.empty }
    guard input.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
          !input.contains("?"),
          !input.contains("#") else {
      throw ServerInputProblem.invalid
    }

    let hasScheme = input.range(of: schemePattern, options: .regularExpression) != nil
    if !hasScheme && input.contains("://") { throw ServerInputProblem.invalid }

    let authority = input
      .replacingOccurrences(of: schemePattern, with: "", options: .regularExpression)
      .split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
      .first
      .map(String.init) ?? ""
    guard !authority.hasSuffix(":") else { throw ServerInputProblem.invalid }

    let preliminary = hasScheme ? input : "http://\(input)"
    guard let preliminaryParts = URLComponents(string: preliminary),
          let preliminaryHost = preliminaryParts.host,
          !preliminaryHost.isEmpty else {
      throw ServerInputProblem.invalid
    }
    let local = isLocalHost(preliminaryHost)
    let value = hasScheme ? input : "\(local ? "http" : "https")://\(input)"

    guard var parts = URLComponents(string: value),
          let scheme = parts.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = parts.host,
          !host.isEmpty,
          parts.user == nil,
          parts.password == nil,
          parts.query == nil,
          parts.fragment == nil,
          parts.url != nil else {
      throw ServerInputProblem.invalid
    }
    if scheme == "http" && !local { throw ServerInputProblem.invalid }

    var path = parts.percentEncodedPath
    while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
    if path == "/" { path = "" }
    parts.percentEncodedPath = path

    var originParts = parts
    originParts.percentEncodedPath = ""
    guard let origin = originParts.string, !origin.isEmpty,
          let baseURL = parts.string, !baseURL.isEmpty else {
      throw ServerInputProblem.invalid
    }

    return NormalizedAuthServer(
      baseURL: baseURL,
      origin: origin,
      explicitPath: !path.isEmpty,
      local: local,
      port: parts.port
    )
  }

  static func displayHost(_ rawValue: String) -> String {
    guard let normalized = try? normalize(rawValue),
          let parts = URLComponents(string: normalized.baseURL),
          let host = parts.host else {
      return rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let displayedHost = host.contains(":") ? "[\(host)]" : host
    guard let port = parts.port else { return displayedHost }
    return "\(displayedHost):\(port)"
  }

  static func isValidEmail(_ rawValue: String) -> Bool {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return false }
    return value.range(
      of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#,
      options: .regularExpression
    ) != nil
  }

  private static func isLocalHost(_ rawHost: String) -> Bool {
    let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
    if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") {
      return true
    }
    if host == "::1" { return true }

    let pieces = host.split(separator: ".", omittingEmptySubsequences: false)
    guard pieces.count == 4 else { return false }
    let octets = pieces.compactMap { Int($0) }
    guard octets.count == 4, octets.allSatisfy({ 0 ... 255 ~= $0 }) else { return false }
    let first = octets[0]
    let second = octets[1]
    return first == 127 || first == 10 || (first == 192 && second == 168)
      || (first == 172 && 16 ... 31 ~= second)
  }
}
