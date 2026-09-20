import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

@main
enum AuthContractTests {
  static func main() throws {
    try localDefaultsToHTTP()
    try publicDefaultsToHTTPS()
    try candidatePriority()
    try explicitPathWins()
    try invalidServersAreRejected()
    emailShapeMatchesTheUIContract()
    try sessionRoundTrips()
    print("Auth contract tests passed")
  }

  private static func localDefaultsToHTTP() throws {
    let server = try AuthServerContract.normalize(" 127.0.0.1:18080 ")
    expect(server.baseURL == "http://127.0.0.1:18080", "local default scheme")
    expect(server.local, "loopback is local")
    expect(server.discoveryCandidates == [
      "http://127.0.0.1:18080",
      "http://127.0.0.1:18080/api",
    ], "local root-first discovery")
  }

  private static func publicDefaultsToHTTPS() throws {
    let server = try AuthServerContract.normalize("memoh.example.com")
    expect(server.baseURL == "https://memoh.example.com", "public default scheme")
    expect(!server.local, "public host is not local")
    expect(server.discoveryCandidates == [
      "https://memoh.example.com/api",
      "https://memoh.example.com",
    ], "public api-first discovery")
  }

  private static func candidatePriority() throws {
    let server = try AuthServerContract.normalize("https://memoh.example.com:8080")
    expect(server.discoveryCandidates.first == "https://memoh.example.com:8080", "8080 root first")
  }

  private static func explicitPathWins() throws {
    let server = try AuthServerContract.normalize("https://memoh.example.com/custom///")
    expect(server.baseURL == "https://memoh.example.com/custom", "trailing slash normalization")
    expect(server.discoveryCandidates == [server.baseURL], "explicit path is the only candidate")
  }

  private static func invalidServersAreRejected() throws {
    let invalid = [
      "",
      "https://user:pass@example.com",
      "https://example.com?q=1",
      "https://example.com#fragment",
      "ftp://example.com",
      "http://example.com",
      "https://example.com:",
      "https://example.com:abc",
      "https://exa mple.com",
    ]
    for value in invalid {
      do {
        _ = try AuthServerContract.normalize(value)
        fail("accepted invalid server: \(value)")
      } catch {
        continue
      }
    }
  }

  private static func emailShapeMatchesTheUIContract() {
    expect(AuthServerContract.isValidEmail(" a@b.co "), "valid email")
    for value in ["", "a", "a@b", "a@@b.co", "a b@c.co"] {
      expect(!AuthServerContract.isValidEmail(value), "invalid email: \(value)")
    }
  }

  private static func sessionRoundTrips() throws {
    let value = AuthSession(
      baseUrl: "https://memoh.example.com/api",
      token: "token",
      expiresAt: "2099-01-01T00:00:00Z",
      userId: "user-id",
      username: "tester",
      displayName: "Test User",
      role: "member",
      timezone: "Asia/Tokyo"
    )
    let encoded = try value.json()
    let decoded = try AuthSession.decode(encoded)
    expect(decoded == value, "session JSON round trip")
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fail(message) }
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Auth contract failure: \(message)\n".utf8))
    exit(1)
  }
}
