import Foundation
import Security

/// Session storage compatible with Expo SecureStore's default unauthenticated iOS query.
/// Keeping the exact service/account/generic tuple preserves sessions across this migration.
struct AuthKeychain: Sendable {
  static let shared = AuthKeychain()

  private let key = "memoh.session.v1"
  private let service = "app:no-auth"

  func load() throws -> AuthSession? {
    var query = itemQuery
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = kCFBooleanTrue

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data,
          let json = String(data: data, encoding: .utf8) else {
      throw AuthKeychainError.read(status)
    }
    // Corrupt or outdated payloads are treated as signed out, not as a launch failure.
    return try? AuthSession.decode(json)
  }

  func loadJSON() throws -> String? {
    try load()?.json()
  }

  func save(json: String) throws {
    try save(session: AuthSession.decode(json))
  }

  func save(session: AuthSession) throws {
    let data = try JSONEncoder().encode(session)
    let updates: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let updateStatus = SecItemUpdate(itemQuery as CFDictionary, updates as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else { throw AuthKeychainError.write(updateStatus) }

    var item = itemQuery
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let addStatus = SecItemAdd(item as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw AuthKeychainError.write(addStatus) }
  }

  func clear() throws {
    let status = SecItemDelete(itemQuery as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw AuthKeychainError.delete(status)
    }
  }

  private var itemQuery: [String: Any] {
    let encodedKey = Data(key.utf8)
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: encodedKey,
      kSecAttrGeneric as String: encodedKey,
    ]
  }
}

enum AuthKeychainError: Error {
  case read(OSStatus)
  case write(OSStatus)
  case delete(OSStatus)
}
