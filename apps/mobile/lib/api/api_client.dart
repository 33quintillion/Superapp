import 'dart:convert';

import 'package:http/http.dart' as http;

/// Error returned by the API in its `{ error: { code, message } }` envelope.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  @override
  String toString() => 'ApiException($status, $code): $message';
}

class TokenPair {
  TokenPair({required this.accessToken, required this.refreshToken, required this.sessionId});
  factory TokenPair.fromJson(Map<String, dynamic> j) => TokenPair(
        accessToken: j['accessToken'] as String,
        refreshToken: j['refreshToken'] as String,
        sessionId: j['sessionId'] as String,
      );
  final String accessToken;
  final String refreshToken;
  final String sessionId;
}

/// Thin JSON client. The base URL comes from `--dart-define=API_BASE_URL=...`;
/// nothing secret is compiled into the app.
class ApiClient {
  ApiClient({http.Client? client, String? baseUrl})
      : _http = client ?? http.Client(),
        baseUrl = baseUrl ?? const String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:3000');

  final http.Client _http;
  final String baseUrl;

  Future<Map<String, dynamic>?> send(String method, String path, {Object? body, String? accessToken}) async {
    final req = http.Request(method, Uri.parse('$baseUrl$path'));
    req.headers['accept'] = 'application/json';
    if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    if (accessToken != null) req.headers['authorization'] = 'Bearer $accessToken';
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 15)));
    } on Exception {
      throw ApiException(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
    }
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    if (res.statusCode >= 400) {
      final err = (decoded is Map ? decoded['error'] : null) as Map<String, dynamic>?;
      throw ApiException(res.statusCode, err?['code'] as String? ?? 'http_error', err?['message'] as String? ?? 'Request failed');
    }
    return decoded is Map<String, dynamic> ? decoded : null;
  }
}
