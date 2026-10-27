import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/business/business_models.dart';
import 'package:nexa/chat/realtime.dart';
import 'package:nexa/main.dart';
import 'package:nexa/screens/business_screens.dart';

// Only the HTTP and socket boundary is faked; the screens are the real code, and each
// request they make is checked against what the API expects.

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class FakeApi {
  final calls = <String>[];
  final bodies = <String, List<Map<String, dynamic>>>{};
  final handlers = <String, http.Response Function(http.Request)>{};

  late final http.Client client = MockClient((req) async {
    final key = '${req.method} ${req.url.path}';
    calls.add('$key${req.url.hasQuery ? '?${req.url.query}' : ''}');
    if (req.body.isNotEmpty) bodies.putIfAbsent(key, () => []).add(jsonDecode(req.body) as Map<String, dynamic>);
    if (req.url.path == '/v1/auth/refresh') return json(200, {'accessToken': 'a1', 'refreshToken': 'r1', 'sessionId': 's', 'expiresIn': 900});
    switch (key) {
      case 'GET /v1/me':
        return json(200, {'id': 'me', 'username': 'ada', 'displayName': 'Ada', 'email': 'ada@example.test', 'emailVerified': true});
      case 'POST /v1/realtime/tickets':
        return json(201, {'ticket': 't', 'path': '/v1/realtime', 'expiresIn': 60});
      case 'GET /v1/conversations':
        return json(200, {'conversations': <Object>[], 'nextCursor': null});
    }
    final h = handlers[key];
    if (h != null) return h(req);
    if (req.method == 'GET' && req.url.path.endsWith('/changes')) return json(200, {'changes': <Object>[], 'nextSince': 0, 'hasMore': false});
    return json(404, {'error': {'code': 'not_found', 'message': 'not found: $key'}});
  });

  void on(String key, http.Response Function(http.Request) h) => handlers[key] = h;

  Future<RealtimeSocket> connect(Uri uri) async {
    final s = FakeSocket();
    scheduleMicrotask(() => s.push({'type': 'ready', 'data': {'connectionId': 'x'}}));
    return s;
  }
}

class FakeSocket implements RealtimeSocket {
  final _in = StreamController<dynamic>();
  @override
  Stream<dynamic> get stream => _in.stream;
  @override
  void add(String data) {}
  void push(Map<String, dynamic> f) => _in.add(jsonEncode(f));
  @override
  Future<void> close() => _in.close();
}

Future<AuthController> signedIn(FakeApi api) async {
  final auth = AuthController(ApiClient(client: api.client, baseUrl: 'http://api.test'), MemorySessionStore()..token = 'r0');
  await auth.restore();
  return auth;
}

Map<String, dynamic> bakery({bool orders = true, bool bookings = true}) => {
      'id': 'b1',
      'handle': 'bakery',
      'name': 'Sunrise Bakery',
      'description': 'Fresh every morning',
      'category': 'food',
      'contactEmail': null,
      'phone': null,
      'address': '1 High St',
      'timeZone': 'UTC',
      'currency': 'EUR',
      'ordersEnabled': orders,
      'bookingsEnabled': bookings,
      'verified': true,
      'state': 'active',
      'myRole': null,
      'permissions': <String>[],
      'invited': null,
    };

Map<String, dynamic> item(String id, String name, int price, {bool available = true}) =>
    {'id': id, 'name': name, 'description': '', 'priceMinor': price, 'currency': 'EUR', 'available': available, 'stock': null, 'position': 0};

Map<String, dynamic> order(String id, String status, {String reason = ''}) => {
      'id': id,
      'business': {'id': 'b1', 'handle': 'bakery', 'name': 'Sunrise Bakery'},
      'status': status,
      'statusReason': reason,
      'fulfilment': 'pickup',
      'payment': 'pay_in_person',
      'note': '',
      'items': [
        {'itemId': 'i1', 'name': 'Sourdough', 'unitPriceMinor': 450, 'quantity': 2},
      ],
      'totalMinor': 900,
      'currency': 'EUR',
      'createdAt': '2026-10-27T09:00:00.000Z',
      'updatedAt': '2026-10-27T09:00:00.000Z',
    };

Map<String, dynamic> booking(String id, String status, String startsAt, {String? cancelledBy}) => {
      'id': id,
      'business': {'id': 'b1', 'handle': 'bakery', 'name': 'Sunrise Bakery', 'timeZone': 'UTC'},
      'service': {'id': 's1', 'name': 'Cake tasting'},
      'startsAt': startsAt,
      'endsAt': startsAt,
      'status': status,
      'cancelledBy': cancelledBy,
      'note': '',
      'createdAt': '2026-10-27T09:00:00.000Z',
    };

void main() {
  test('formats money in minor units, including currencies without cents', () {
    expect(formatMoney(455, 'EUR'), 'EUR 4.55');
    expect(formatMoney(5, 'USD'), 'USD 0.05');
    expect(formatMoney(500, 'JPY'), 'JPY 500');
  });

  testWidgets('finds a business and orders for pickup; a retry reuses the same order id', (tester) async {
    final api = FakeApi();
    api.on('GET /v1/businesses', (_) => json(200, {'businesses': [bakery()]}));
    api.on('GET /v1/businesses/bakery', (_) => json(200, bakery()));
    api.on('GET /v1/businesses/bakery/items', (_) => json(200, {'items': [item('i1', 'Sourdough', 450), item('i2', 'Croissant', 180), item('i3', 'Bagel', 120, available: false)]}));
    api.on('GET /v1/businesses/bakery/services', (_) => json(200, {'services': <Object>[]}));
    var attempts = 0;
    api.on('POST /v1/businesses/b1/orders', (_) {
      attempts += 1;
      // The first attempt fails as if the connection dropped; the second goes through.
      if (attempts == 1) return json(503, {'error': {'code': 'unavailable', 'message': 'Try again'}});
      return json(201, order('o1', 'placed'));
    });

    final auth = await signedIn(api);
    await tester.pumpWidget(NexaApp(auth: auth, connectSocket: api.connect));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-businesses')));
    await tester.pumpAndSettle();
    expect(find.text('@bakery · food · Verified'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('business-search')), 'sun rise');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pumpAndSettle();
    expect(api.calls, contains('GET /v1/businesses?q=sun+rise'));

    await tester.tap(find.byKey(const Key('business-bakery')));
    await tester.pumpAndSettle();
    expect(find.text('Fresh every morning'), findsOneWidget);
    expect(find.text('EUR 1.20 · Sold out'), findsOneWidget);
    expect(find.byKey(const Key('add-i3')), findsNothing);
    await tester.tap(find.byKey(const Key('add-i1')));
    await tester.tap(find.byKey(const Key('add-i1')));
    await tester.tap(find.byKey(const Key('add-i2')));
    await tester.pump();
    expect(find.text('Place order · EUR 10.80 · pay at pickup'), findsOneWidget);
    await tester.tap(find.byKey(const Key('less-i2')));
    await tester.pump();
    expect(find.text('Place order · EUR 9.00 · pay at pickup'), findsOneWidget);

    await tester.tap(find.byKey(const Key('place-order')));
    await tester.pumpAndSettle();
    expect(find.text('Try again'), findsOneWidget);
    await tester.tap(find.byKey(const Key('place-order')));
    await tester.pumpAndSettle();
    expect(find.text('Order placed: Waiting for the business. Pay when you collect.'), findsOneWidget);
    final sent = api.bodies['POST /v1/businesses/b1/orders']!;
    expect(sent, hasLength(2));
    expect(sent[0]['clientId'], sent[1]['clientId']);
    // Only ids and quantities go up; the server prices the order.
    expect(sent[1]['items'], [
      {'itemId': 'i1', 'quantity': 2},
    ]);
    expect(find.byKey(const Key('place-order')), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets('books a free time, and shows the refusal when someone else got it first', (tester) async {
    final api = FakeApi();
    final today = DateTime(2026, 11, 2);
    var taken = false;
    api.on('GET /v1/businesses/b1/services/s1/slots', (req) {
      final all = [
        {'startsAt': '2026-11-03T09:00:00.000Z', 'endsAt': '2026-11-03T10:00:00.000Z', 'remaining': 1},
        {'startsAt': '2026-11-03T10:00:00.000Z', 'endsAt': '2026-11-03T11:00:00.000Z', 'remaining': 1},
      ];
      return json(200, {'date': req.url.queryParameters['date'], 'timeZone': 'UTC', 'slots': taken ? all.sublist(1) : all});
    });
    api.on('POST /v1/businesses/b1/bookings', (req) {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      if (body['startsAt'] == '2026-11-03T09:00:00.000Z') {
        taken = true;
        return json(409, {'error': {'code': 'slot_full', 'message': 'That time has just been booked; pick another'}});
      }
      return json(201, booking('k1', 'confirmed', body['startsAt'] as String));
    });
    final auth = await signedIn(api);
    final b = Business.fromJson(bakery());
    final s = BookableService(id: 's1', name: 'Cake tasting', durationMinutes: 60, priceMinor: 0, currency: 'EUR');
    await tester.pumpWidget(MaterialApp(home: Builder(builder: (context) => Scaffold(body: Center(child: TextButton(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => BookingScreen(auth: auth, business: b, service: s, today: today))),
          child: const Text('open'),
        ))))));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(api.calls, contains('GET /v1/businesses/b1/services/s1/slots?date=2026-11-03'));
    await tester.tap(find.byKey(const Key('slot-2026-11-03T09:00:00.000Z')));
    await tester.pumpAndSettle();
    expect(find.text('That time has just been booked; pick another'), findsOneWidget);
    expect(find.byKey(const Key('slot-2026-11-03T09:00:00.000Z')), findsNothing);
    await tester.tap(find.byKey(const Key('slot-2026-11-03T10:00:00.000Z')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('booked')), findsOneWidget);
    expect(api.bodies['POST /v1/businesses/b1/bookings']!.last, {'serviceId': 's1', 'startsAt': '2026-11-03T10:00:00.000Z', 'clientId': isA<String>()});
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(find.text('open'), findsOneWidget);

    // Another day with nothing free.
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    api.on('GET /v1/businesses/b1/services/s1/slots', (req) => json(200, {'date': req.url.queryParameters['date'], 'timeZone': 'UTC', 'slots': <Object>[]}));
    await tester.tap(find.byKey(const Key('day-2026-11-05')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('no-slots')), findsOneWidget);
    expect(api.calls.last, 'GET /v1/businesses/b1/services/s1/slots?date=2026-11-05');
  });

  testWidgets('lists orders and bookings and cancels what is still open', (tester) async {
    final api = FakeApi();
    final future = DateTime.now().toUtc().add(const Duration(days: 2)).toIso8601String();
    var cancelled = false;
    api.on('GET /v1/orders', (_) => json(200, {'orders': [order('o1', cancelled ? 'cancelled' : 'placed'), order('o2', 'rejected', reason: 'Out of flour')], 'nextCursor': null}));
    api.on('GET /v1/bookings', (_) => json(200, {'bookings': [booking('k1', 'confirmed', future), booking('k2', 'cancelled', future, cancelledBy: 'business')]}));
    api.on('POST /v1/orders/o1/cancel', (_) {
      cancelled = true;
      return json(200, order('o1', 'cancelled'));
    });
    final auth = await signedIn(api);
    await tester.pumpWidget(MaterialApp(home: MyOrdersScreen(auth: auth)));
    await tester.pumpAndSettle();
    expect(api.calls, contains('GET /v1/bookings?upcoming=false'));
    expect(find.text('Sunrise Bakery · Waiting for the business'), findsOneWidget);
    expect(find.textContaining('Out of flour'), findsOneWidget);
    expect(find.byKey(const Key('cancel-order-o2')), findsNothing);
    expect(find.byKey(const Key('cancel-booking-k1')), findsOneWidget);
    expect(find.textContaining('Cancelled by the business'), findsOneWidget);
    await tester.tap(find.byKey(const Key('cancel-order-o1')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('POST /v1/orders/o1/cancel'));
    expect(find.text('Sunrise Bakery · Cancelled'), findsOneWidget);
    expect(find.byKey(const Key('cancel-order-o1')), findsNothing);
  });
}
