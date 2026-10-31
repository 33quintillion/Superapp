import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import 'phone_verifier.dart';
import 'session_store.dart';

class Profile {
  Profile({this.id = '', required this.username, required this.displayName, required this.email, required this.emailVerified, this.avatarMediaId, this.phone});
  factory Profile.fromJson(Map<String, dynamic> j) => Profile(
        id: j['id'] as String? ?? '',
        username: j['username'] as String? ?? '',
        displayName: j['displayName'] as String? ?? '',
        email: j['email'] as String? ?? '',
        emailVerified: j['emailVerified'] as bool? ?? false,
        avatarMediaId: j['avatarMediaId'] as String?,
        phone: j['phone'] as String?,
      );
  final String id;
  final String username;
  final String displayName;
  final String email;
  final bool emailVerified;
  final String? avatarMediaId;
  /// Set for accounts made with a phone number; '' username and email mean none yet.
  final String? phone;
}

/// needsName: the phone number is confirmed but has no account yet.
enum AuthStatus { unknown, signedOut, mfaRequired, needsName, signedIn }

/// Owns the signed-in state. Every transition is driven by a real API response.
class AuthController extends ChangeNotifier {
  AuthController(this.api, this.store, {this.phone = const UnavailablePhoneVerifier()});
  final ApiClient api;
  final SessionStore store;
  final PhoneVerifier phone;

  AuthStatus status = AuthStatus.unknown;
  Profile? profile;
  String? _accessToken;
  String? _mfaToken;
  String? _signupToken;
  /// The confirmed number waiting for a name (AuthStatus.needsName).
  String? signupPhone;

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

  /// Signs in with the ID token from a confirmed SMS code. A new number moves to
  /// [AuthStatus.needsName]; an account with two-step on moves to the code step.
  Future<void> phoneSignIn(String idToken) async {
    final res = (await api.send('POST', '/v1/auth/phone', body: {'idToken': idToken, 'deviceName': _deviceName()}))!;
    if (res['signupRequired'] == true) {
      _signupToken = res['signupToken'] as String;
      signupPhone = res['phone'] as String?;
      return _set(AuthStatus.needsName);
    }
    if (res['mfaRequired'] == true) {
      _mfaToken = res['mfaToken'] as String;
      return _set(AuthStatus.mfaRequired);
    }
    await _adopt(TokenPair.fromJson(res));
  }

  /// Creates the account for the confirmed number. The username is optional.
  Future<void> completePhoneSignUp({required String displayName, String? username}) async {
    final res = await api.send('POST', '/v1/auth/phone/complete', body: {
      'signupToken': _signupToken,
      'displayName': displayName,
      if (username != null && username.isNotEmpty) 'username': username.toLowerCase(),
      'deviceName': _deviceName(),
    });
    _signupToken = null;
    signupPhone = null;
    await _adopt(TokenPair.fromJson(res!));
  }

  void cancelPhoneSignUp() {
    _signupToken = null;
    signupPhone = null;
    _set(AuthStatus.signedOut);
  }

  /// Adds or changes the optional email (receipts, banking, payouts); a link confirms it.
  Future<void> setEmail(String email) async {
    await authed('PUT', '/v1/me/email', body: {'email': email});
    await _reloadProfile();
  }

  Future<void> removeEmail() async {
    await authed('DELETE', '/v1/me/email');
    await _reloadProfile();
  }

  Future<void> _reloadProfile() async {
    profile = Profile.fromJson((await authed('GET', '/v1/me'))!);
    notifyListeners();
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

  /// Calls the API as the signed-in user. Access tokens last 15 minutes, so a 401 is
  /// answered by rotating the refresh token once and retrying; if that fails too, the
  /// session really has ended and the user is signed out.
  Future<Map<String, dynamic>?> authed(String method, String path, {Object? body}) async {
    try {
      return await api.send(method, path, body: body, accessToken: _accessToken);
    } on ApiException catch (e) {
      if (e.status != 401) rethrow;
      if (!await _refresh()) {
        await signOut();
        rethrow;
      }
      return api.send(method, path, body: body, accessToken: _accessToken);
    }
  }

  Future<bool>? _refreshing;
  Future<bool> _refresh() => _refreshing ??= () async {
        try {
          final refresh = await store.readRefreshToken();
          if (refresh == null) return false;
          final pair = TokenPair.fromJson((await api.send('POST', '/v1/auth/refresh', body: {'refreshToken': refresh}))!);
          _accessToken = pair.accessToken;
          await store.writeRefreshToken(pair.refreshToken);
          return true;
        } on ApiException {
          return false;
        } finally {
          _refreshing = null;
        }
      }();

  /// Makes an uploaded image the profile photo, or removes the photo with null.
  Future<void> setAvatar(String? mediaId) async {
    final me = mediaId == null ? await authed('DELETE', '/v1/me/avatar') : await authed('PUT', '/v1/me/avatar', body: {'mediaId': mediaId});
    profile = Profile.fromJson(me!);
    notifyListeners();
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
