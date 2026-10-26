import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/main.dart';

// HTTP is stubbed at the transport layer only; the controller, client and widgets are the real code.
http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  testWidgets('signs in, shows the profile, and signs out', (tester) async {
    final calls = <String>[];
    final client = MockClient((req) async {
      calls.add('${req.method} ${req.url.path}');
      switch (req.url.path) {
        case '/v1/auth/login':
          final b = jsonDecode(req.body) as Map;
          if (b['password'] != 'right password') {
            return json(401, {'error': {'code': 'invalid_credentials', 'message': 'Email or password is incorrect'}});
          }
          return json(200, {'accessToken': 'a', 'refreshToken': 'r', 'sessionId': 's', 'expiresIn': 900});
        case '/v1/me':
          expect(req.headers['authorization'], 'Bearer a');
          return json(200, {'username': 'ada', 'displayName': 'Ada', 'email': 'ada@example.test', 'emailVerified': false});
        case '/v1/auth/logout':
          return http.Response('', 204);
      }
      return json(404, {'error': {'code': 'not_found', 'message': 'nope'}});
    });
    final store = MemorySessionStore();
    final auth = AuthController(ApiClient(client: client, baseUrl: 'http://api.test'), store);
    await auth.restore();
    await tester.pumpWidget(NexaApp(auth: auth));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('email')), 'ada@example.test');
    await tester.enterText(find.byKey(const Key('password')), 'wrong');
    await tester.tap(find.byKey(const Key('submit')));
    await tester.pumpAndSettle();
    expect(find.text('Email or password is incorrect'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('password')), 'right password');
    await tester.tap(find.byKey(const Key('submit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('display-name')), findsOneWidget);
    expect(store.token, 'r');

    await tester.tap(find.byTooltip('Sign out'));
    await tester.pumpAndSettle();
    expect(find.text('Sign in'), findsWidgets);
    expect(store.token, isNull);
    expect(calls, contains('POST /v1/auth/logout'));
  });

  test('keeps the stored refresh token through a network error', () async {
    final store = MemorySessionStore()..token = 'r';
    final auth = AuthController(ApiClient(client: MockClient((_) async => throw http.ClientException('offline')), baseUrl: 'http://api.test'), store);
    await auth.restore();
    expect(auth.status, AuthStatus.signedOut);
    expect(store.token, 'r');
  });

  test('drops a refresh token the server rejects', () async {
    final store = MemorySessionStore()..token = 'r';
    final auth = AuthController(
      ApiClient(client: MockClient((_) async => json(401, {'error': {'code': 'unauthorized', 'message': 'x'}})), baseUrl: 'http://api.test'),
      store,
    );
    await auth.restore();
    expect(store.token, isNull);
  });

  test('routes to the MFA step when the server asks for it', () async {
    final auth = AuthController(
      ApiClient(client: MockClient((_) async => json(200, {'mfaRequired': true, 'mfaToken': 'm'})), baseUrl: 'http://api.test'),
      MemorySessionStore(),
    );
    await auth.signIn('a@b.c', 'pw');
    expect(auth.status, AuthStatus.mfaRequired);
  });
}
