import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists only the refresh token, in the platform keystore (Keychain / Keystore).
/// Access tokens live in memory and are re-minted on launch.
abstract class SessionStore {
  Future<String?> readRefreshToken();
  Future<void> writeRefreshToken(String token);
  Future<void> clear();
}

class SecureSessionStore implements SessionStore {
  const SecureSessionStore([this._storage = const FlutterSecureStorage()]);
  final FlutterSecureStorage _storage;
  static const _key = 'nexa.refresh_token';

  @override
  Future<String?> readRefreshToken() => _storage.read(key: _key);
  @override
  Future<void> writeRefreshToken(String token) => _storage.write(key: _key, value: token);
  @override
  Future<void> clear() => _storage.delete(key: _key);
}

class MemorySessionStore implements SessionStore {
  String? token;
  @override
  Future<String?> readRefreshToken() async => token;
  @override
  Future<void> writeRefreshToken(String t) async => token = t;
  @override
  Future<void> clear() async => token = null;
}
