import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/phone_verifier.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/main.dart';

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

/// Stands in for Firebase: "texts" 123456 to any number and returns a token naming it.
class FakePhoneVerifier implements PhoneVerifier {
  final sentTo = <String>[];

  @override
  bool get available => true;

  @override
  Future<String> sendCode(String phoneE164) async {
    sentTo.add(phoneE164);
    return 'handle:$phoneE164';
  }

  @override
  Future<String> confirm(String handle, String code) async {
    if (code != '123456') throw PhoneVerificationException('That code is wrong. Check the text message and try again.');
    return 'id-token-for-${handle.split(':').last}';
  }
}

/// The API as far as phone sign-in and the optional email go.
class FakeApi {
  final calls = <String>[];
  final bodies = <String, Map<String, dynamic>>{};
  final known = <String>{};
  String? email;
  late final client = MockClient((req) async {
    final key = '${req.method} ${req.url.path}';
    calls.add(key);
    if (req.body.isNotEmpty) bodies[key] = jsonDecode(req.body) as Map<String, dynamic>;
    switch (key) {
      case 'POST /v1/auth/phone':
        final phone = (bodies[key]!['idToken'] as String).replaceFirst('id-token-for-', '');
        if (known.contains(phone)) return json(200, {'accessToken': 'a', 'refreshToken': 'r', 'sessionId': 's', 'expiresIn': 900});
        return json(200, {'signupRequired': true, 'signupToken': 'signup-token', 'phone': phone});
      case 'POST /v1/auth/phone/complete':
        expect(bodies[key]!['signupToken'], 'signup-token');
        return json(201, {'accessToken': 'a', 'refreshToken': 'r', 'sessionId': 's', 'expiresIn': 900});
      case 'GET /v1/me':
        return json(200, {
          'id': 'u1',
          'username': null,
          'displayName': bodies['POST /v1/auth/phone/complete']?['displayName'] ?? 'Asha',
          'email': email,
          'emailVerified': false,
          'phone': '+919876543210',
        });
      case 'PUT /v1/me/email':
        email = bodies[key]!['email'] as String;
        return json(200, {'email': email, 'verified': false});
    }
    // Everything else (chats, the realtime socket) is out of scope here, as in auth_flow_test.
    return json(404, {'error': {'code': 'not_found', 'message': 'nope'}});
  });
}

Future<(AuthController, FakeApi, FakePhoneVerifier)> start(WidgetTester tester, {Set<String> known = const {}}) async {
  final api = FakeApi()..known.addAll(known);
  final phone = FakePhoneVerifier();
  final auth = AuthController(ApiClient(client: api.client, baseUrl: 'http://api.test'), MemorySessionStore(), phone: phone);
  await auth.restore();
  await tester.pumpWidget(NexaApp(auth: auth));
  await tester.pumpAndSettle();
  return (auth, api, phone);
}

void main() {
  testWidgets('a new number gets a code, picks a name, and lands signed in', (tester) async {
    final (auth, api, phone) = await start(tester);
    expect(find.text('Welcome to SuperApp'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('phone')), '12');
    await tester.tap(find.byKey(const Key('send-code')));
    await tester.pumpAndSettle();
    expect(find.text('That phone number doesn’t look right.'), findsOneWidget);
    expect(phone.sentTo, isEmpty);

    await tester.enterText(find.byKey(const Key('phone')), '098765 43210');
    await tester.tap(find.byKey(const Key('send-code')));
    await tester.pumpAndSettle();
    expect(phone.sentTo, ['+919876543210']);

    await tester.enterText(find.byKey(const Key('sms-code')), '111111');
    await tester.tap(find.byKey(const Key('verify-code')));
    await tester.pumpAndSettle();
    expect(find.textContaining('That code is wrong'), findsOneWidget);
    expect(api.calls, isNot(contains('POST /v1/auth/phone')));

    await tester.enterText(find.byKey(const Key('sms-code')), '123456');
    await tester.tap(find.byKey(const Key('verify-code')));
    await tester.pumpAndSettle();
    expect(auth.status, AuthStatus.needsName);
    expect(find.textContaining('+919876543210 is confirmed'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('display-name-field')), 'Asha');
    await tester.tap(find.byKey(const Key('create-account')));
    await tester.pumpAndSettle();
    expect(auth.status, AuthStatus.signedIn);
    expect(api.bodies['POST /v1/auth/phone/complete'], {'signupToken': 'signup-token', 'displayName': 'Asha', 'deviceName': isA<String>()});
    expect(find.text('+919876543210'), findsOneWidget);
    expect(find.text('Add an email'), findsOneWidget);
  });

  testWidgets('a known number signs straight in', (tester) async {
    final (auth, api, _) = await start(tester, known: {'+919876543210'});
    await tester.enterText(find.byKey(const Key('phone')), '+91 98765 43210');
    await tester.tap(find.byKey(const Key('send-code')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('sms-code')), '123456');
    await tester.tap(find.byKey(const Key('verify-code')));
    await tester.pumpAndSettle();
    expect(auth.status, AuthStatus.signedIn);
    expect(api.calls, isNot(contains('POST /v1/auth/phone/complete')));
  });

  testWidgets('adds an optional email and says a link is on its way', (tester) async {
    final (_, api, _) = await start(tester, known: {'+919876543210'});
    await tester.enterText(find.byKey(const Key('phone')), '9876543210');
    await tester.tap(find.byKey(const Key('send-code')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('sms-code')), '123456');
    await tester.tap(find.byKey(const Key('verify-code')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('open-email')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('email-field')), 'asha@example.test');
    await tester.tap(find.byKey(const Key('save-email')));
    await tester.pumpAndSettle();
    expect(api.bodies['PUT /v1/me/email'], {'email': 'asha@example.test'});
    expect(find.byKey(const Key('email-sent')), findsOneWidget);
    expect(find.text('asha@example.test isn’t confirmed yet. Check your inbox for the link.'), findsOneWidget);
  });

  test('turns typed numbers into E.164', () {
    expect(toE164('98765 43210'), '+919876543210');
    expect(toE164('098765-43210'), '+919876543210');
    expect(toE164('+1 (416) 555-0123'), '+14165550123');
    expect(toE164('0044 7700 900123'), '+447700900123');
    expect(isE164(toE164('12')), isFalse);
  });
}
