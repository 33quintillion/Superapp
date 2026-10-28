import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nexa/business/business_models.dart';
import 'package:nexa/screens/back_office_screens.dart';
import 'package:nexa/screens/business_screens.dart';

import 'business_test.dart' show FakeApi, bakery, booking, item, json, order, signedIn;

// The back office: staff run their business from the phone. As in business_test, only the
// HTTP boundary is faked and each request is checked against what the API expects.

const managerPermissions = [
  'business.view', 'orders.view', 'orders.manage', 'bookings.view', 'bookings.manage', 'catalogue.manage', 'services.manage', //
  'orders.refund', 'bookings.refund', 'disputes.respond', 'payments.view',
];
const ownerPermissions = [...managerPermissions, 'payments.manage', 'billing.manage'];

Map<String, dynamic> myBakery(String role, List<String> permissions, {bool online = true}) => {...bakery(online: online), 'myRole': role, 'permissions': permissions};

Map<String, dynamic> withCustomer(Map<String, dynamic> j, [String name = 'Lee']) => {...j, 'customer': {'id': 'u2', 'username': 'lee', 'displayName': name}};

Map<String, dynamic> plan(String code, String name, int price, {String interval = 'month'}) =>
    {'id': 'p-$code', 'code': code, 'name': name, 'description': '', 'priceMinor': price, 'currency': 'EUR', 'interval': interval, 'entitlements': <String>[], 'state': 'active'};

Map<String, dynamic> subscription(Map<String, dynamic>? p, {bool cancelling = false}) => {
      'enabled': true,
      'subscription': p == null ? null : {'id': 'sub1', 'status': 'active', 'plan': p, 'cancelAtPeriodEnd': cancelling, 'currentPeriodEnd': '2026-11-28T00:00:00.000Z', 'entitled': true},
      'entitlements': <String>[],
      'limits': {'staff': p == null ? 10 : 100, 'catalogue': p == null ? 200 : 5000},
    };

/// Puts the screen under a button so it is pushed like it is in the app.
Future<void> open(WidgetTester tester, Widget screen) async {
  await tester.pumpWidget(MaterialApp(home: Builder(builder: (context) => Scaffold(body: Center(child: TextButton(
        onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen)),
        child: const Text('open'),
      ))))));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Future<void> close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pumpAndSettle();
}

void main() {
  test('reads prices typed by staff into minor units', () {
    expect(parseMoney('2.5', 'EUR'), 250);
    expect(parseMoney(' 3,20 ', 'EUR'), 320);
    expect(parseMoney('500', 'JPY'), 500);
    expect(() => parseMoney('two', 'EUR'), throwsFormatException);
    expect(() => parseMoney('-1', 'EUR'), throwsFormatException);
  });

  testWidgets('lists only the businesses you work at, and shows staff only the tabs their role allows', (tester) async {
    final api = FakeApi();
    api.on('GET /v1/me/businesses', (_) => json(200, {
          'businesses': [
            myBakery('staff', ['business.view', 'orders.view', 'orders.manage', 'bookings.view', 'bookings.manage']),
            {...bakery(), 'id': 'b2', 'handle': 'invited', 'name': 'Invited Café', 'invited': {'role': 'staff'}},
          ],
        }));
    api.on('GET /v1/businesses/b1/orders', (_) => json(200, {'orders': <Object>[], 'nextCursor': null}));
    api.on('GET /v1/businesses/b1/bookings', (_) => json(200, {'bookings': <Object>[]}));
    final auth = await signedIn(api);
    await open(tester, MyBusinessesScreen(auth: auth));
    expect(find.text('@bakery · staff'), findsOneWidget);
    expect(find.text('Invited Café'), findsNothing);
    await tester.tap(find.byKey(const Key('my-business-bakery')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('tab-orders')), findsOneWidget);
    expect(find.byKey(const Key('tab-bookings')), findsOneWidget);
    expect(find.byKey(const Key('tab-catalogue')), findsNothing);
    expect(find.byKey(const Key('tab-money')), findsNothing);
    expect(find.text('No orders here.'), findsOneWidget);
    await close(tester);
  });

  testWidgets('moves orders along and refunds part of a card payment once, even when retried', (tester) async {
    final api = FakeApi();
    var status = 'placed';
    var refunds = 0;
    api.on('GET /v1/businesses/b1/orders', (req) {
      final open = req.url.queryParameters['status'] == 'placed,accepted,ready';
      final o = withCustomer(order('o1', status, paymentStatus: refunds > 0 ? 'partially_refunded' : 'paid', refunded: refunds > 0 ? 300 : 0));
      final isOpen = ['placed', 'accepted', 'ready'].contains(status);
      return json(200, {'orders': open == isOpen ? [o] : <Object>[], 'nextCursor': null});
    });
    api.on('POST /v1/orders/o1/status', (req) {
      status = (jsonDecode(req.body) as Map<String, dynamic>)['status'] as String;
      return json(200, order('o1', status));
    });
    api.on('POST /v1/orders/o1/refunds', (_) {
      refunds += 1;
      if (refunds == 1) return json(503, {'error': {'code': 'provider_unavailable', 'message': 'The payment provider didn’t answer; try again'}});
      return json(201, {'id': 'r1'});
    });
    final auth = await signedIn(api);
    await open(tester, ManageBusinessScreen(auth: auth, business: Business.fromJson(myBakery('manager', managerPermissions))));
    expect(find.text('Lee · Waiting for the business'), findsOneWidget);
    expect(find.textContaining('EUR 9.00 · paid online'), findsOneWidget);

    await tester.tap(find.byKey(const Key('order-o1-accepted')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/orders/o1/status']!.last, {'status': 'accepted'});
    expect(find.text('Lee · Being prepared'), findsOneWidget);
    await tester.tap(find.byKey(const Key('order-o1-ready')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('order-o1-completed')), findsOneWidget);

    await tester.tap(find.byKey(const Key('refund-order-o1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('refund-amount')), '3.00');
    await tester.enterText(find.byKey(const Key('refund-reason')), 'One bagel was missing');
    await tester.tap(find.byKey(const Key('refund-send')));
    await tester.pumpAndSettle();
    expect(find.text('The payment provider didn’t answer; try again'), findsOneWidget);
    await tester.tap(find.byKey(const Key('refund-send')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('refund-dialog')), findsNothing);
    final sent = api.bodies['POST /v1/orders/o1/refunds']!;
    expect(sent, hasLength(2));
    expect(sent[0]['clientId'], sent[1]['clientId']);
    expect(sent[1], {'clientId': isA<String>(), 'reason': 'One bagel was missing', 'amountMinor': 300});
    expect(find.textContaining('EUR 3.00 refunded'), findsOneWidget);

    await tester.tap(find.byKey(const Key('order-o1-completed')));
    await tester.pumpAndSettle();
    expect(find.text('No orders here.'), findsOneWidget);
    await tester.tap(find.text('Finished'));
    await tester.pumpAndSettle();
    expect(find.text('Lee · Collected'), findsOneWidget);
    await close(tester);
  });

  testWidgets('marks who came, warns before cancelling a paid deposit, and refunds deposits', (tester) async {
    final api = FakeApi();
    final now = DateTime.utc(2026, 11, 2, 12);
    final deposit = {'amountMinor': 1000, 'status': 'paid', 'refundedMinor': 0, 'freeCancelUntil': '2026-11-04T09:00:00.000Z', 'refundDue': false};
    final rows = {
      'k1': {...withCustomer(booking('k1', 'confirmed', '2026-11-02T10:00:00.000Z')), 'currency': 'EUR', 'priceMinor': 3000, 'deposit': null},
      'k2': {...withCustomer(booking('k2', 'confirmed', '2026-11-05T10:00:00.000Z'), 'Sam'), 'currency': 'EUR', 'priceMinor': 3000, 'deposit': deposit},
    };
    api.on('GET /v1/businesses/b1/bookings', (_) => json(200, {'bookings': rows.values.toList()}));
    api.on('GET /v1/businesses/b1/orders', (_) => json(200, {'orders': <Object>[], 'nextCursor': null}));
    api.on('POST /v1/bookings/k1/outcome', (req) {
      rows['k1'] = {...rows['k1']!, 'status': (jsonDecode(req.body) as Map<String, dynamic>)['status']};
      return json(200, rows['k1']!);
    });
    api.on('POST /v1/bookings/k2/cancel', (_) {
      rows['k2'] = {...rows['k2']!, 'status': 'cancelled', 'cancelledBy': 'business', 'deposit': {...deposit, 'status': 'refunded', 'refundedMinor': 1000}};
      return json(200, rows['k2']!);
    });
    final auth = await signedIn(api);
    await open(tester, ManageBusinessScreen(auth: auth, business: Business.fromJson(myBakery('manager', managerPermissions)), now: () => now));
    await tester.tap(find.byKey(const Key('tab-bookings')));
    await tester.pumpAndSettle();
    expect(api.calls.where((c) => c.startsWith('GET /v1/businesses/b1/bookings?from=')).length, 1);
    expect(find.text('Deposit EUR 10.00: paid online'), findsOneWidget);
    // Bookings that have started get Came / No-show; later ones can be cancelled.
    expect(find.byKey(const Key('booking-k1-cancel')), findsNothing);
    expect(find.byKey(const Key('booking-k2-came')), findsNothing);
    expect(find.byKey(const Key('refund-booking-k2')), findsOneWidget);

    await tester.tap(find.byKey(const Key('booking-k1-no-show')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/bookings/k1/outcome']!.single, {'status': 'no_show'});
    expect(find.text('Lee · Didn’t come'), findsOneWidget);

    await tester.tap(find.byKey(const Key('booking-k2-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('Cancel this booking? The EUR 10.00 deposit will be refunded.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm-yes')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('POST /v1/bookings/k2/cancel'));
    expect(find.text('Deposit EUR 10.00: refunded'), findsOneWidget);
    expect(find.byKey(const Key('refund-booking-k2')), findsNothing);
    await close(tester);
  });

  testWidgets('adds an item, marks it sold out, and removes it after asking', (tester) async {
    final api = FakeApi();
    final items = [item('i1', 'Sourdough', 450)];
    api.on('GET /v1/businesses/b1/items', (_) => json(200, {'items': items}));
    api.on('POST /v1/businesses/b1/items', (req) {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      items.add(item('i2', body['name'] as String, body['priceMinor'] as int));
      return json(201, items.last);
    });
    api.on('PATCH /v1/businesses/b1/items/i1', (req) {
      items[0] = {...items[0], ...jsonDecode(req.body) as Map<String, dynamic>};
      return json(200, items[0]);
    });
    api.on('DELETE /v1/businesses/b1/items/i2', (_) {
      items.removeLast();
      return http.Response('', 204);
    });
    api.on('GET /v1/businesses/b1/orders', (_) => json(200, {'orders': <Object>[], 'nextCursor': null}));
    final auth = await signedIn(api);
    await open(tester, ManageBusinessScreen(auth: auth, business: Business.fromJson(myBakery('manager', managerPermissions))));
    await tester.tap(find.byKey(const Key('tab-catalogue')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('add-item')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('item-name')), 'Rye loaf');
    await tester.enterText(find.byKey(const Key('item-price')), 'cheap');
    await tester.tap(find.byKey(const Key('item-save')));
    await tester.pumpAndSettle();
    expect(find.text('Enter an amount such as 2.50'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('item-price')), '5.20');
    await tester.tap(find.byKey(const Key('item-save')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/businesses/b1/items']!.single, {'name': 'Rye loaf', 'priceMinor': 520});
    expect(find.text('EUR 5.20'), findsOneWidget);

    await tester.tap(find.byKey(const Key('available-i1')));
    await tester.pumpAndSettle();
    expect(api.bodies['PATCH /v1/businesses/b1/items/i1']!.single, {'available': false});
    expect(find.text('EUR 4.50 · Sold out'), findsOneWidget);

    await tester.tap(find.byKey(const Key('remove-i2')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-yes')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('DELETE /v1/businesses/b1/items/i2'));
    expect(find.text('Rye loaf'), findsNothing);
    await close(tester);
  });

  testWidgets('owner sees payouts and payments, answers a dispute, and switches plan after seeing the cost', (tester) async {
    final api = FakeApi();
    final opened = <Uri>[];
    var current = plan('growth', 'Growth', 1500);
    var dispute = {
      'id': 'd1', 'paymentId': 'pay1', 'orderId': 'o1', 'bookingId': null, 'amountMinor': 900, 'currency': 'EUR', 'reason': 'product_not_received', //
      'status': 'needs_response', 'open': true, 'canRespond': true, 'evidenceDueBy': '2026-11-10T00:00:00.000Z', 'evidenceSubmittedAt': null, 'createdAt': '2026-11-01T00:00:00.000Z',
    };
    api.on('GET /v1/businesses/b1/payments/account', (_) => json(200, {'enabled': true, 'provider': 'stripe', 'connected': true, 'country': 'IE', 'chargesEnabled': true, 'payoutsEnabled': true, 'detailsSubmitted': true, 'onlinePayments': true}));
    api.on('GET /v1/businesses/b1/payouts', (_) => json(200, {'payouts': [{'id': 'po1', 'amountMinor': 4210, 'currency': 'EUR', 'status': 'in_transit', 'arrivalDate': '2026-11-04T00:00:00.000Z', 'createdAt': '2026-11-02T00:00:00.000Z'}]}));
    api.on('GET /v1/businesses/b1/subscription', (_) => json(200, subscription(current)));
    api.on('GET /v1/plans', (_) => json(200, {'plans': [plan('growth', 'Growth', 1500), plan('scale', 'Scale', 4500), plan('usd', 'Dollars', 1500)..['currency'] = 'USD']}));
    api.on('GET /v1/businesses/b1/payments', (_) => json(200, {
          'payments': [
            {'id': 'pay1', 'orderId': 'o1', 'bookingId': null, 'status': 'paid', 'amountMinor': 900, 'refundedMinor': 0, 'disputedMinor': 900, 'refundableMinor': 0, 'feeMinor': 27, 'currency': 'EUR', 'createdAt': '2026-11-01T09:00:00.000Z', 'paidAt': null},
          ],
          'totals': [{'currency': 'EUR', 'paidMinor': 900, 'refundedMinor': 0, 'disputedMinor': 900, 'feesMinor': 27}],
        }));
    api.on('GET /v1/businesses/b1/disputes', (_) => json(200, {'disputes': [dispute]}));
    api.on('POST /v1/disputes/d1/response', (_) {
      dispute = {...dispute, 'status': 'under_review', 'canRespond': false};
      return json(200, dispute);
    });
    api.on('POST /v1/businesses/b1/subscription/preview', (_) => json(200, {'plan': plan('scale', 'Scale', 4500), 'from': current, 'amountDueNowMinor': 2900, 'currency': 'EUR', 'intervalChanges': false}));
    api.on('POST /v1/businesses/b1/subscription/change', (_) {
      current = plan('scale', 'Scale', 4500);
      return json(200, subscription(current));
    });
    api.on('POST /v1/businesses/b1/billing-portal', (_) => json(200, {'url': 'https://billing.example.test/session'}));
    api.on('GET /v1/businesses/b1/orders', (_) => json(200, {'orders': <Object>[], 'nextCursor': null}));
    final auth = await signedIn(api);
    await open(tester, ManageBusinessScreen(auth: auth, business: Business.fromJson(myBakery('owner', ownerPermissions)), openUrl: (u) async => opened.add(u)));
    await tester.tap(find.byKey(const Key('tab-money')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('payouts-ready')), findsOneWidget);
    expect(find.text('EUR 42.10'), findsOneWidget);
    expect(find.text('EUR 9.00 paid · EUR 0.00 refunded · EUR 9.00 held by banks · EUR 0.27 fees'), findsOneWidget);
    expect(find.textContaining('Needs your response · product not received · respond by 2026-11-10'), findsOneWidget);

    await tester.tap(find.byKey(const Key('respond-d1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('dispute-text')), 'Lee collected both loaves at 9:15 and paid by card at the counter.');
    await tester.tap(find.byKey(const Key('dispute-send')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/disputes/d1/response']!.single, {'text': 'Lee collected both loaves at 9:15 and paid by card at the counter.'});
    expect(find.textContaining('Bank deciding'), findsOneWidget);
    expect(find.byKey(const Key('respond-d1')), findsNothing);

    // Only plans in the same currency can be switched to in place.
    expect(find.byKey(const Key('switch-usd')), findsNothing);
    await tester.scrollUntilVisible(find.byKey(const Key('switch-scale')), 200, scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first);
    await tester.tap(find.descendant(of: find.byKey(const Key('switch-scale')), matching: find.text('See the cost')));
    await tester.pumpAndSettle();
    expect(find.text('Switching to Scale costs EUR 29.00 today, for the rest of this period. Then EUR 45.00 a month.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm-yes')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/businesses/b1/subscription/change']!.single, {'planCode': 'scale', 'clientId': isA<String>()});
    expect(find.textContaining('Scale, EUR 45.00 a month.'), findsOneWidget);

    await tester.tap(find.byKey(const Key('billing-portal')));
    await tester.pumpAndSettle();
    expect(opened.single, Uri.parse('https://billing.example.test/session'));
    await close(tester);
  });

  testWidgets('a manager sees the money but can’t set up payouts or change the plan; an owner on the free plan subscribes', (tester) async {
    final api = FakeApi();
    final opened = <Uri>[];
    api.on('GET /v1/businesses/b1/payments/account', (_) => json(200, {'enabled': true, 'provider': 'stripe', 'connected': false, 'country': null, 'chargesEnabled': false, 'payoutsEnabled': false, 'detailsSubmitted': false, 'onlinePayments': false}));
    api.on('GET /v1/businesses/b1/subscription', (_) => json(200, subscription(null)));
    api.on('GET /v1/plans', (_) => json(200, {'plans': [plan('growth', 'Growth', 1500)]}));
    api.on('GET /v1/businesses/b1/payments', (_) => json(200, {'payments': <Object>[], 'totals': <Object>[]}));
    api.on('GET /v1/businesses/b1/disputes', (_) => json(200, {'disputes': <Object>[]}));
    api.on('POST /v1/businesses/b1/payments/account', (_) => json(200, {'url': 'https://connect.example.test/onboard'}));
    api.on('POST /v1/businesses/b1/subscription', (_) => json(200, {'url': 'https://checkout.example.test/plan'}));
    api.on('GET /v1/businesses/b1/orders', (_) => json(200, {'orders': <Object>[], 'nextCursor': null}));
    final auth = await signedIn(api);

    await open(tester, ManageBusinessScreen(auth: auth, business: Business.fromJson(myBakery('manager', managerPermissions, online: false)), openUrl: (u) async => opened.add(u)));
    await tester.tap(find.byKey(const Key('tab-money')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('payouts-not-ready')), findsOneWidget);
    expect(find.text('Only the owner can set up payouts.'), findsOneWidget);
    expect(find.byKey(const Key('setup-payouts')), findsNothing);
    expect(find.byKey(const Key('plan-growth')), findsNothing);
    // Payouts aren't asked for before there is an account.
    expect(api.calls.where((c) => c.contains('/payouts')), isEmpty);
    await close(tester);

    await open(tester, ManageBusinessScreen(auth: auth, business: Business.fromJson(myBakery('owner', ownerPermissions, online: false)), openUrl: (u) async => opened.add(u)));
    await tester.tap(find.byKey(const Key('tab-money')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('payout-country')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('IE').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('setup-payouts')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/businesses/b1/payments/account']!.single, {'country': 'IE'});
    await tester.scrollUntilVisible(find.byKey(const Key('plan-growth')), 200, scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first);
    await tester.tap(find.descendant(of: find.byKey(const Key('plan-growth')), matching: find.text('Choose')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/businesses/b1/subscription']!.single, {'planCode': 'growth', 'clientId': isA<String>()});
    expect(opened, [Uri.parse('https://connect.example.test/onboard'), Uri.parse('https://checkout.example.test/plan')]);
    await close(tester);
  });

  testWidgets('customer pays a booking deposit on the provider’s page, and is told before a late cancel keeps it', (tester) async {
    final api = FakeApi();
    final opened = <Uri>[];
    final today = DateTime(2026, 11, 2);
    api.on('GET /v1/businesses/b1/services/s1/slots', (req) => json(200, {
          'date': req.url.queryParameters['date'],
          'timeZone': 'UTC',
          'slots': [{'startsAt': '2026-11-03T09:00:00.000Z', 'endsAt': '2026-11-03T10:00:00.000Z', 'remaining': 1}],
        }));
    api.on('POST /v1/businesses/b1/bookings', (_) => json(201, {...booking('k1', 'pending_payment', '2026-11-03T09:00:00.000Z'), 'currency': 'EUR', 'priceMinor': 3000, 'deposit': {'amountMinor': 1000, 'status': 'unpaid', 'refundedMinor': 0, 'freeCancelUntil': null, 'refundDue': false}}));
    api.on('POST /v1/bookings/k1/checkout', (_) => json(200, {'url': 'https://checkout.example.test/deposit'}));
    final auth = await signedIn(api);
    final b = Business.fromJson(bakery(online: true));
    final s = BookableService(id: 's1', name: 'Cake tasting', durationMinutes: 60, priceMinor: 3000, currency: 'EUR', depositMinor: 1000);
    await open(tester, BookingScreen(auth: auth, business: b, service: s, today: today, openUrl: (u) async => opened.add(u)));
    await tester.tap(find.byKey(const Key('slot-2026-11-03T09:00:00.000Z')));
    await tester.pumpAndSettle();
    expect(opened.single, Uri.parse('https://checkout.example.test/deposit'));
    expect(find.text('open'), findsOneWidget);
    await close(tester);

    // In my bookings: a held booking can be paid; a paid one past its free-cancel time asks first.
    final held = {...booking('k1', 'pending_payment', '2099-11-03T09:00:00.000Z'), 'currency': 'EUR', 'deposit': {'amountMinor': 1000, 'status': 'unpaid', 'refundedMinor': 0, 'freeCancelUntil': null}};
    final late = {...booking('k2', 'confirmed', '2099-11-03T09:00:00.000Z'), 'currency': 'EUR', 'deposit': {'amountMinor': 1000, 'status': 'paid', 'refundedMinor': 0, 'freeCancelUntil': '2020-01-01T00:00:00.000Z'}};
    api.on('GET /v1/orders', (_) => json(200, {'orders': <Object>[], 'nextCursor': null}));
    api.on('GET /v1/bookings', (_) => json(200, {'bookings': [held, late]}));
    api.on('POST /v1/bookings/k2/cancel', (_) => json(200, {...late, 'status': 'cancelled'}));
    await open(tester, MyOrdersScreen(auth: auth, openUrl: (u) async => opened.add(u)));
    expect(find.textContaining('Waiting for the deposit'), findsOneWidget);
    await tester.tap(find.byKey(const Key('pay-booking-k1')));
    await tester.pumpAndSettle();
    expect(opened, hasLength(2));
    await tester.tap(find.byKey(const Key('cancel-booking-k2')));
    await tester.pumpAndSettle();
    expect(find.text('Cancel this booking? If you cancel now, the business keeps your EUR 10.00 deposit.'), findsOneWidget);
    await tester.tap(find.text('Keep it'));
    await tester.pumpAndSettle();
    expect(api.calls, isNot(contains('POST /v1/bookings/k2/cancel')));
    await tester.tap(find.byKey(const Key('cancel-booking-k2')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-cancel-booking')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('POST /v1/bookings/k2/cancel'));
    await close(tester);
  });
}
