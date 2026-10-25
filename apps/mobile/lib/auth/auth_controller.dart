import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import 'session_store.dart';

class Profile {
  Profile({required this.username, required this.displayName, required this.email, required this.emailVerified});
  factory Profile.fromJson(Map<String, dynamic> j) => Profile(
        username: j['username'] as String? ?? '',
        displayName: j['displayName'] as String? ?? '',
        email: j['email'] as String? ?? '',
        emailVerified: j['emailVerified'] as bool? ?? false,
      );
  final String username;
  final String displayName;
  final String email;
  final bool emailVerified;
}

enum AuthStatus { unknown, signedOut, mfaRequired, signedIn }

/// Owns the signed-in state. Every transition is driven by a real API response.
class AuthController extends ChangeNotifier {
  AuthController(this.api, this.store);
  final ApiClient api;
  final SessionStore store;

  AuthStatus status = AuthStatus.unknown;
  Profile? profile;
  String? _accessToken;
  String? _mfaToken;

  Future<void> restore() async {
    final refresh = await store.readRefreshToken();
    if (refresh == null) return _set(AuthStatus.signedOut);
    try {
      await _adopt(TokenPair.fromJson((await api.send('POST', '/v1/auth/refresh', body: {'refreshToken': refresh}))!));
    } on ApiException catch (e) {
      // Only discard the token if the server rejected it; keep it through network errors.
      if (e.status == 401) await store.clear();
      _set(AuthStatus.signedOut);
    }
  }

  Future<void> signIn(String email, String password) async {
    final res = (await api.send('POST', '/v1/auth/login', body: {'email': email, 'password': password, 'deviceName': _deviceName()}))!;
    if (res['mfaRequired'] == true) {
      _mfaToken = res['mfaToken'] as String;
      return _set(AuthStatus.mfaRequired);
    }
    await _adopt(TokenPair.fromJson(res));
  }

  Future<void> submitMfa(String code) async {
    final res = await api.send('POST', '/v1/auth/login/mfa', body: {'mfaToken': _mfaToken, 'code': code, 'deviceName': _deviceName()});
    _mfaToken = null;
    await _adopt(TokenPair.fromJson(res!));
  }

  Future<void> register({required String email, required String password, required String username, required String displayName}) async {
    final res = await api.send('POST', '/v1/auth/register', body: {
      'email': email,
      'password': password,
      'username': username,
      'displayName': displayName,
      'deviceName': _deviceName(),
    });
    await _adopt(TokenPair.fromJson(res!));
  }

  Future<void> signOut() async {
    final token = _accessToken;
    _accessToken = null;
    profile = null;
    await store.clear();
    _set(AuthStatus.signedOut);
    if (token != null) {
      try {
        await api.send('POST', '/v1/auth/logout', accessToken: token);
      } on ApiException {
        // Local sign-out already happened; the server session expires on its own.
      }
    }
  }

  Future<void> _adopt(TokenPair pair) async {
    _accessToken = pair.accessToken;
    await store.writeRefreshToken(pair.refreshToken);
    profile = Profile.fromJson((await api.send('GET', '/v1/me', accessToken: pair.accessToken))!);
    _set(AuthStatus.signedIn);
  }

  void _set(AuthStatus s) {
    status = s;
    notifyListeners();
  }

  String _deviceName() => kIsWeb ? 'Web browser' : '${defaultTargetPlatform.name} app';
}
