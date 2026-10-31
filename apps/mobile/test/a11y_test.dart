import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/business/business_models.dart';
import 'package:nexa/main.dart';
import 'package:nexa/screens/back_office_screens.dart';
import 'package:nexa/screens/business_screens.dart';
import 'package:nexa/theme/theme.dart';

import 'a11y_helpers.dart';
import 'back_office_test.dart' show ownerPermissions, plan, subscription, withCustomer;
import 'business_test.dart' show FakeApi, bakery, booking, item, json, order, signedIn;

// Flutter's accessibility guidelines on the main screens, in light and dark mode, with real
// data on them: every tap target is at least 48×48 (Android) and 44×44 (iOS) and has a
// label a screen reader can say, and text has enough contrast against what is behind it.
// This doesn't replace trying the app with TalkBack and VoiceOver on real phones.

FakeApi fakeApi() {
  final api = FakeApi();
  api.on('GET /v1/businesses', (_) => json(200, {'businesses': [bakery()]}));
  api.on('GET /v1/businesses/bakery', (_) => json(200, bakery(online: true)));
  api.on('GET /v1/businesses/bakery/items', (_) => json(200, {'items': [item('i1', 'Sourdough', 450), item('i3', 'Bagel', 120, available: false)]}));
  api.on('GET /v1/businesses/bakery/services', (_) => json(200, {'services': [
        {'id': 's1', 'name': 'Cake tasting', 'description': '', 'durationMinutes': 60, 'priceMinor': 3000, 'currency': 'EUR', 'capacity': 1, 'active': true, 'depositMinor': 1000, 'freeCancelHours': 24},
      ]}));
  api.on('GET /v1/orders', (_) => json(200, {'orders': [order('o1', 'pending_payment', paymentStatus: 'unpaid'), order('o2', 'completed', paymentStatus: 'partially_refunded', refunded: 300)], 'nextCursor': null}));
  api.on('GET /v1/bookings', (_) => json(200, {'bookings': [{...booking('k1', 'confirmed', '2099-11-03T09:00:00.000Z'), 'currency': 'EUR', 'deposit': {'amountMinor': 1000, 'status': 'paid', 'refundedMinor': 0, 'freeCancelUntil': '2099-11-02T09:00:00.000Z'}}]}));
  api.on('GET /v1/businesses/b1/orders', (_) => json(200, {'orders': [withCustomer(order('o1', 'placed', paymentStatus: 'paid'))], 'nextCursor': null}));
  api.on('GET /v1/businesses/b1/bookings', (_) => json(200, {'bookings': [{...withCustomer(booking('k1', 'confirmed', '2099-11-03T09:00:00.000Z')), 'currency': 'EUR', 'deposit': null}]}));
  api.on('GET /v1/businesses/b1/items', (_) => json(200, {'items': [item('i1', 'Sourdough', 450), item('i3', 'Bagel', 120, available: false)]}));
  api.on('GET /v1/businesses/b1/payments/account', (_) => json(200, {'enabled': true, 'connected': true, 'country': 'IE', 'payoutsEnabled': true, 'onlinePayments': true}));
  api.on('GET /v1/businesses/b1/payouts', (_) => json(200, {'payouts': [{'id': 'po1', 'amountMinor': 4210, 'currency': 'EUR', 'status': 'paid', 'arrivalDate': '2026-11-04T00:00:00.000Z'}]}));
  api.on('GET /v1/businesses/b1/subscription', (_) => json(200, subscription(plan('growth', 'Growth', 1500))));
  api.on('GET /v1/plans', (_) => json(200, {'plans': [plan('growth', 'Growth', 1500), plan('scale', 'Scale', 4500)]}));
  api.on('GET /v1/businesses/b1/payments', (_) => json(200, {'payments': <Object>[], 'totals': [{'currency': 'EUR', 'paidMinor': 900, 'refundedMinor': 0, 'disputedMinor': 0, 'feesMinor': 27}]}));
  api.on('GET /v1/businesses/b1/disputes', (_) => json(200, {'disputes': [
        {'id': 'd1', 'orderId': 'o1', 'amountMinor': 900, 'currency': 'EUR', 'reason': 'fraudulent', 'status': 'needs_response', 'canRespond': true, 'evidenceDueBy': '2026-11-10T00:00:00.000Z'},
      ]}));
  return api;
}

Widget themed(Widget home, Brightness brightness) => MaterialApp(theme: nexaTheme(brightness), home: home);

void main() {
  for (final brightness in Brightness.values) {
    group('${brightness.name} mode', () {
      testWidgets('sign in', (tester) async {
        final auth = AuthController(ApiClient(client: FakeApi().client, baseUrl: 'http://api.test'), MemorySessionStore());
        await auth.restore();
        await tester.pumpWidget(NexaApp(auth: auth, themeMode: brightness == Brightness.dark ? ThemeMode.dark : ThemeMode.light));
        await tester.pumpAndSettle();
        await expectAccessible(tester);
      });

      testWidgets('home', (tester) async {
        final api = fakeApi();
        final auth = await signedIn(api);
        await tester.pumpWidget(NexaApp(auth: auth, connectSocket: api.connect, themeMode: brightness == Brightness.dark ? ThemeMode.dark : ThemeMode.light));
        await tester.pumpAndSettle();
        await expectAccessible(tester);
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      });

      testWidgets('shopping: businesses, a storefront, and my orders and bookings', (tester) async {
        final api = fakeApi();
        final auth = await signedIn(api);
        for (final screen in <Widget>[BusinessesScreen(auth: auth), StorefrontScreen(auth: auth, handle: 'bakery'), MyOrdersScreen(auth: auth)]) {
          await tester.pumpWidget(themed(screen, brightness));
          await tester.pumpAndSettle();
          await expectAccessible(tester);
        }
        // With something in the basket, the payment choice and order button show.
        await tester.pumpWidget(themed(StorefrontScreen(auth: auth, handle: 'bakery'), brightness));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('add-i1')));
        await tester.pumpAndSettle();
        await expectAccessible(tester);
      });

      testWidgets('running a business: every tab', (tester) async {
        final api = fakeApi();
        final auth = await signedIn(api);
        final b = Business.fromJson({...bakery(online: true), 'myRole': 'owner', 'permissions': ownerPermissions});
        await tester.pumpWidget(themed(ManageBusinessScreen(auth: auth, business: b, now: () => DateTime.utc(2026, 11, 2)), brightness));
        await tester.pumpAndSettle();
        for (final tab in ['orders', 'bookings', 'catalogue', 'money']) {
          await tester.tap(find.byKey(Key('tab-$tab')));
          await tester.pumpAndSettle();
          await expectAccessible(tester);
        }
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      });
    });
  }
}
