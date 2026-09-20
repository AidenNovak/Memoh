import Foundation

enum MemohAuthError: Error, Equatable {
  case notMemoh
  case invalidCredentials
  case unreachable
  case failed
}

private final class AuthRedirectRejector: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  static let shared = AuthRedirectRejector()

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

/// Native self-host authentication. The public entry point enforces discovery before credentials.
struct MemohAuthService: Sendable {
  private let session: URLSession

  init(session: URLSession = .shared) {
    self.session = session
  }

  func authenticate(
    server: NormalizedAuthServer,
    username: String,
    password: String
  ) async throws -> AuthSession {
    guard let baseURL = await discover(server) else { throw MemohAuthError.notMemoh }
    return try await login(baseURL: baseURL, username: username, password: password)
  }

  private func discover(_ server: NormalizedAuthServer) async -> String? {
    let candidates = server.discoveryCandidates
    if candidates.count == 1 {
      return await probe(candidates[0]) ? candidates[0] : nil
    }

    async let first = probe(candidates[0])
    async let second = probe(candidates[1])
    if await first { return candidates[0] }
    if await second { return candidates[1] }
    return nil
  }

  private func probe(_ candidate: String) async -> Bool {
    do {
      guard let pingURL = URL(string: "\(candidate)/ping"),
            let loginURL = URL(string: "\(candidate)/auth/login") else { return false }

      var ping = URLRequest(url: pingURL, timeoutInterval: 4)
      ping.setValue("application/json", forHTTPHeaderField: "Accept")
      let (pingData, pingResponse) = try await data(for: ping)
      guard let pingHTTP = pingResponse as? HTTPURLResponse,
            200 ... 299 ~= pingHTTP.statusCode,
            let body = try JSONSerialization.jsonObject(with: pingData) as? [String: Any],
            body["status"] as? String == "ok" else {
        return false
      }

      var login = URLRequest(url: loginURL, timeoutInterval: 4)
      login.httpMethod = "POST"
      login.httpBody = Data("{}".utf8)
      login.setValue("application/json", forHTTPHeaderField: "Accept")
      login.setValue("application/json", forHTTPHeaderField: "Content-Type")
      let (_, loginResponse) = try await data(for: login)
      guard let loginHTTP = loginResponse as? HTTPURLResponse else { return false }
      return [400, 401, 422].contains(loginHTTP.statusCode)
    } catch {
      return false
    }
  }

  private func login(baseURL: String, username: String, password: String) async throws -> AuthSession {
    guard let url = URL(string: "\(baseURL)/auth/login") else { throw MemohAuthError.failed }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "username": username,
      "password": password,
    ])
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await self.data(for: request)
    } catch {
      throw MemohAuthError.unreachable
    }
    guard let http = response as? HTTPURLResponse else { throw MemohAuthError.failed }
    if http.statusCode == 401 { throw MemohAuthError.invalidCredentials }
    guard 200 ... 299 ~= http.statusCode else { throw MemohAuthError.failed }

    do {
      return try JSONDecoder().decode(AuthLoginResponse.self, from: data).session(baseURL: baseURL)
    } catch {
      throw MemohAuthError.failed
    }
  }

  private func data(for request: URLRequest) async throws -> (Data, URLResponse) {
    try await session.data(for: request, delegate: AuthRedirectRejector.shared)
  }
}
