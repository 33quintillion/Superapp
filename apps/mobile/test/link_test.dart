import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/screens/link_screens.dart';

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Future<(AuthController, List<String>)> signedIn({bool expired = false}) async {
  final calls = <String>[];
  final client = MockClient((req) async {
    final key = '${req.method} ${req.url.path}';
    calls.add(key);
    switch (key) {
      case 'POST /v1/auth/login':
        return json(200, {'accessToken': 'a', 'refreshToken': 'r', 'sessionId': 's', 'expiresIn': 900});
      case 'GET /v1/me':
        return json(200, {'id': 'u1', 'username': 'asha', 'displayName': 'Asha', 'email': null, 'emailVerified': false, 'phone': '+919876543210'});
      case 'GET /v1/auth/link/ABCD2345':
        if (expired) return json(400, {'error': {'code': 'invalid_token', 'message': 'This link or code is invalid or has expired'}});
        return json(200, {'deviceName': 'Web browser', 'browser': 'Chrome on Windows', 'expiresInSeconds': 90});
      case 'POST /v1/auth/link/ABCD2345/approve':
        expect(req.headers['authorization'], 'Bearer a');
        return http.Response('', 204);
    }
    return json(404, {'error': {'code': 'not_found', 'message': 'nope'}});
  });
  final auth = AuthController(ApiClient(client: client, baseUrl: 'http://api.test'), MemorySessionStore());
  await auth.signIn('asha@example.test', 'pw');
  return (auth, calls);
}

Future<void> open(WidgetTester tester, AuthController auth, {String? scanned}) async {
  await tester.pumpWidget(MaterialApp(home: LinkDeviceScreen(auth: auth, scan: (_) async => scanned)));
  await tester.pumpAndSettle();
}

void main() {
  test('reads the code from a scanned QR code or from typing', () {
    expect(linkCodeFrom('SUPERAPP-LINK:ABCD2345'), 'ABCD2345');
    expect(linkCodeFrom('abcd-2345'), 'ABCD2345');
    expect(linkCodeFrom(' ABCD 2345 '), 'ABCD2345');
    expect(linkCodeFrom('https://example.com'), isNull);
    expect(linkCodeFrom('ABCD1234'), isNull, reason: '1 is never used, so this is a typo');
  });

  testWidgets('scans, shows what is being linked, and links it after the person agrees', (tester) async {
    final (auth, calls) = await signedIn();
    await open(tester, auth, scanned: 'SUPERAPP-LINK:ABCD2345');
    await tester.tap(find.byKey(const Key('scan-code')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Web browser (Chrome on Windows) will be signed in'), findsOneWidget);
    expect(calls, isNot(contains('POST /v1/auth/link/ABCD2345/approve')));

    await tester.tap(find.byKey(const Key('approve-link')));
    await tester.pumpAndSettle();
    expect(calls, contains('POST /v1/auth/link/ABCD2345/approve'));
    expect(find.byKey(const Key('link-done')), findsOneWidget);
  });

  testWidgets('cancelling links nothing', (tester) async {
    final (auth, calls) = await signedIn();
    await open(tester, auth);
    await tester.enterText(find.byKey(const Key('typed-code')), 'abcd-2345');
    await tester.tap(find.byKey(const Key('link-typed')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(calls, isNot(contains('POST /v1/auth/link/ABCD2345/approve')));
    expect(find.byKey(const Key('link-done')), findsNothing);
  });

  testWidgets('explains a mistyped or expired code', (tester) async {
    final (auth, _) = await signedIn(expired: true);
    await open(tester, auth);
    await tester.enterText(find.byKey(const Key('typed-code')), 'hello');
    await tester.tap(find.byKey(const Key('link-typed')));
    await tester.pumpAndSettle();
    expect(find.textContaining('isn’t a SuperApp code'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('typed-code')), 'ABCD-2345');
    await tester.tap(find.byKey(const Key('link-typed')));
    await tester.pumpAndSettle();
    expect(find.textContaining('expired or was already used'), findsOneWidget);
  });
}
