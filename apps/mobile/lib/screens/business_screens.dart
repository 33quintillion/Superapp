import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../business/business_models.dart';
import '../chat/realtime.dart' show newClientId;
import '../theme/tokens.g.dart';
import 'back_office_screens.dart';

void _snack(BuildContext context, Object e) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : '$e')));
}

/// Opens a provider's hosted page (card checkout) outside the app. Tests pass their own.
typedef OpenUrl = Future<void> Function(Uri url);

Future<void> openInBrowser(Uri url) async {
  if (!await launchUrl(url, mode: LaunchMode.externalApplication)) throw Exception('Could not open the payment page');
}

/// Asks the API for a checkout page for an order or booking waiting for payment, and opens it.
Future<void> _payOnline(AuthController auth, String orderId, OpenUrl openUrl, {String kind = 'orders'}) async {
  final r = await auth.authed('POST', '/v1/$kind/$orderId/checkout');
  await openUrl(Uri.parse(r!['url'] as String));
}

/// Find businesses to order from or book with.
class BusinessesScreen extends StatefulWidget {
  const BusinessesScreen({super.key, required this.auth});
  final AuthController auth;

  @override
  State<BusinessesScreen> createState() => _BusinessesScreenState();
}

class _BusinessesScreenState extends State<BusinessesScreen> {
  final _q = TextEditingController();
  List<Business>? _results;

  @override
  void initState() {
    super.initState();
    unawaited(_search());
  }

  Future<void> _search() async {
    try {
      final q = _q.text.trim();
      final r = await widget.auth.authed('GET', '/v1/businesses${q.isEmpty ? '' : '?q=${Uri.encodeQueryComponent(q)}'}');
      if (mounted) setState(() => _results = [for (final b in r!['businesses'] as List) Business.fromJson(b as Map<String, dynamic>)]);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Businesses'), actions: [
          IconButton(
            key: const Key('open-my-businesses'),
            tooltip: 'Businesses you run',
            icon: const Icon(Icons.storefront_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => MyBusinessesScreen(auth: widget.auth))),
          ),
          IconButton(
            key: const Key('open-my-orders'),
            tooltip: 'Your orders and bookings',
            icon: const Icon(Icons.receipt_long_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => MyOrdersScreen(auth: widget.auth))),
          ),
        ]),
        body: ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
          TextField(
            key: const Key('business-search'),
            controller: _q,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _search(),
            decoration: InputDecoration(hintText: 'Find shops, cafés, salons…', suffixIcon: IconButton(icon: const Icon(Icons.search), onPressed: _search)),
          ),
          if (_results == null) const Padding(padding: EdgeInsets.all(NexaSpace.lg), child: Center(child: CircularProgressIndicator())),
          if (_results?.isEmpty ?? false) const ListTile(title: Text('No businesses found.')),
          for (final b in _results ?? <Business>[])
            ListTile(
              key: Key('business-${b.handle}'),
              title: Text(b.name),
              subtitle: Text('@${b.handle} · ${b.category}${b.verified ? ' · Verified' : ''}'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => StorefrontScreen(auth: widget.auth, handle: b.handle))),
            ),
        ]),
      );
}

/// A business's page: order for pickup from the catalogue, or book a time.
class StorefrontScreen extends StatefulWidget {
  const StorefrontScreen({super.key, required this.auth, required this.handle, this.openUrl = openInBrowser});
  final AuthController auth;
  final String handle;
  final OpenUrl openUrl;

  @override
  State<StorefrontScreen> createState() => _StorefrontScreenState();
}

class _StorefrontScreenState extends State<StorefrontScreen> {
  Business? _b;
  List<CatalogueItem> _items = [];
  List<BookableService> _services = [];
  final _basket = <String, int>{};
  // One id per basket, so a retry after a dropped connection can't order twice.
  String _orderKey = newClientId();
  bool _placing = false;
  String _payment = 'pay_in_person';

  AuthController get auth => widget.auth;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final h = widget.handle;
      final results = await Future.wait([
        auth.authed('GET', '/v1/businesses/$h'),
        auth.authed('GET', '/v1/businesses/$h/items'),
        auth.authed('GET', '/v1/businesses/$h/services'),
      ]);
      if (!mounted) return;
      setState(() {
        _b = Business.fromJson(results[0]!);
        _payment = _b!.inPersonPayments ? 'pay_in_person' : 'online';
        _items = [for (final i in results[1]!['items'] as List) CatalogueItem.fromJson(i as Map<String, dynamic>)];
        _services = [for (final s in results[2]!['services'] as List) BookableService.fromJson(s as Map<String, dynamic>)];
      });
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  int get _total => _items.fold(0, (t, i) => t + i.priceMinor * (_basket[i.id] ?? 0));

  Future<void> _place() async {
    setState(() => _placing = true);
    try {
      final r = await auth.authed('POST', '/v1/businesses/${_b!.id}/orders', body: {
        'clientId': _orderKey,
        'items': [
          for (final e in _basket.entries)
            if (e.value > 0) {'itemId': e.key, 'quantity': e.value},
        ],
        'payment': _payment,
      });
      final order = Order.fromJson(r!);
      if (!mounted) return;
      setState(() {
        _basket.clear();
        _orderKey = newClientId();
      });
      if (order.status == 'pending_payment') {
        // The order holds its items while the customer pays on the provider's page.
        await _payOnline(auth, order.id, widget.openUrl);
        if (!mounted) return;
        _snack(context, 'Finish paying on the payment page. Your order is held for you; see it in your orders.');
        return;
      }
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('Order placed: ${orderStatusLabels[order.status]}. Pay when you collect.')));
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    } finally {
      if (mounted) setState(() => _placing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final b = _b;
    return Scaffold(
      appBar: AppBar(title: Text(b?.name ?? '')),
      body: b == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
              if (b.description.isNotEmpty) Text(b.description),
              if (b.address.isNotEmpty) Text(b.address, style: Theme.of(context).textTheme.bodySmall),
              if (_items.isNotEmpty) ...[
                const SizedBox(height: NexaSpace.lg),
                Text('Order for pickup', style: Theme.of(context).textTheme.titleMedium),
                if (!b.ordersEnabled) const Text('Not taking orders right now.'),
                for (final i in _items)
                  ListTile(
                    key: Key('item-${i.id}'),
                    title: Text(i.name),
                    subtitle: Text(i.available ? formatMoney(i.priceMinor, i.currency) : '${formatMoney(i.priceMinor, i.currency)} · Sold out'),
                    trailing: b.ordersEnabled && i.available
                        ? Row(mainAxisSize: MainAxisSize.min, children: [
                            if ((_basket[i.id] ?? 0) > 0) ...[
                              IconButton(key: Key('less-${i.id}'), tooltip: 'One less', icon: const Icon(Icons.remove), onPressed: () => setState(() => _basket[i.id] = _basket[i.id]! - 1)),
                              Text('${_basket[i.id]}', key: Key('qty-${i.id}')),
                            ],
                            IconButton(key: Key('add-${i.id}'), tooltip: 'Add', icon: const Icon(Icons.add), onPressed: () => setState(() => _basket[i.id] = ((_basket[i.id] ?? 0) + 1).clamp(0, 99))),
                          ])
                        : null,
                  ),
                if (_total > 0 && b.onlinePayments)
                  Padding(
                    padding: const EdgeInsets.only(top: NexaSpace.md),
                    child: SegmentedButton<String>(
                      key: const Key('payment-choice'),
                      segments: [
                        const ButtonSegment(value: 'online', label: Text('Pay now by card')),
                        if (b.inPersonPayments) const ButtonSegment(value: 'pay_in_person', label: Text('Pay at pickup')),
                      ],
                      selected: {_payment},
                      onSelectionChanged: (s) => setState(() => _payment = s.first),
                    ),
                  ),
                if (_total > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: NexaSpace.md),
                    child: FilledButton(
                      key: const Key('place-order'),
                      onPressed: _placing ? null : _place,
                      child: Text(_payment == 'online'
                          ? 'Continue to payment · ${formatMoney(_total, b.currency)}'
                          : 'Place order · ${formatMoney(_total, b.currency)} · pay at pickup'),
                    ),
                  ),
                if (_total > 0 && _payment == 'online')
                  Text('You pay on our payment provider’s secure page. We never see your card details.', style: Theme.of(context).textTheme.bodySmall),
              ],
              if (_services.isNotEmpty) ...[
                const SizedBox(height: NexaSpace.lg),
                Text('Book a time', style: Theme.of(context).textTheme.titleMedium),
                if (!b.bookingsEnabled) const Text('Not taking bookings right now.'),
                for (final s in _services)
                  ListTile(
                    key: Key('service-${s.id}'),
                    title: Text(s.name),
                    subtitle: Text('${s.durationMinutes} min${s.priceMinor > 0 ? ' · ${formatMoney(s.priceMinor, s.currency)}' : ''}'
                        '${s.depositMinor > 0 ? ' · ${formatMoney(s.depositMinor, s.currency)} deposit by card, refunded if you cancel ${s.freeCancelHours} hours ahead' : ''}'),
                    trailing: const Icon(Icons.event_available_outlined),
                    enabled: b.bookingsEnabled,
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => BookingScreen(auth: auth, business: b, service: s, openUrl: widget.openUrl))),
                  ),
              ],
              const SizedBox(height: NexaSpace.lg),
              TextButton(key: const Key('report-business'), onPressed: () => _report(b), child: const Text('Report this business')),
            ]),
    );
  }

  Future<void> _report(Business b) async {
    try {
      await auth.authed('POST', '/v1/reports', body: {'subjectType': 'business', 'subjectId': b.id, 'reason': 'fraud'});
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Thanks, our team will look at it.')));
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }
}

/// Pick a day and a free time. Times are shown in this phone's time zone.
class BookingScreen extends StatefulWidget {
  const BookingScreen({super.key, required this.auth, required this.business, required this.service, this.today, this.openUrl = openInBrowser});
  final AuthController auth;
  final OpenUrl openUrl;
  final Business business;
  final BookableService service;
  /// Tests pin "today".
  final DateTime? today;

  @override
  State<BookingScreen> createState() => _BookingScreenState();
}

class _BookingScreenState extends State<BookingScreen> {
  late final DateTime _today = widget.today ?? DateTime.now();
  late DateTime _day = _today.add(const Duration(days: 1));
  List<Slot>? _slots;
  bool _booking = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _slots = null);
    try {
      final r = await widget.auth.authed('GET', '/v1/businesses/${widget.business.id}/services/${widget.service.id}/slots?date=${isoDate(_day)}');
      if (mounted) setState(() => _slots = [for (final s in r!['slots'] as List) Slot.fromJson(s as Map<String, dynamic>)]);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _slots = []);
        _snack(context, e);
      }
    }
  }

  Future<void> _book(Slot s) async {
    setState(() => _booking = true);
    try {
      final r = await widget.auth.authed('POST', '/v1/businesses/${widget.business.id}/bookings', body: {
        'serviceId': widget.service.id,
        'startsAt': s.startsAt.toUtc().toIso8601String(),
        'clientId': newClientId(),
      });
      final k = Booking.fromJson(r!);
      if (!mounted) return;
      if (k.status == 'pending_payment') {
        // The place is held while the customer pays the deposit on the provider's page.
        await _payOnline(widget.auth, k.id, widget.openUrl, kind: 'bookings');
        if (!mounted) return;
        _snack(context, 'Pay the deposit on the payment page to confirm. Your time is held for you; see it in your bookings.');
        Navigator.of(context).pop();
        return;
      }
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          key: const Key('booked'),
          title: const Text('Booked'),
          content: Text('${k.serviceName} at ${k.businessName}, ${isoDate(k.startsAt.toLocal())} ${hhmm(k.startsAt.toLocal())}.'),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
        ),
      );
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
      await _load();
    } finally {
      if (mounted) setState(() => _booking = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(widget.service.name)),
        body: ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
          Wrap(spacing: NexaSpace.sm, children: [
            for (var i = 0; i < 7; i++)
              () {
                final d = _today.add(Duration(days: i));
                return ChoiceChip(
                  key: Key('day-${isoDate(d)}'),
                  label: Text(i == 0 ? 'Today' : i == 1 ? 'Tomorrow' : isoDate(d).substring(5)),
                  selected: isoDate(d) == isoDate(_day),
                  onSelected: (_) {
                    setState(() => _day = d);
                    unawaited(_load());
                  },
                );
              }(),
          ]),
          const SizedBox(height: NexaSpace.md),
          if (_slots == null) const Center(child: CircularProgressIndicator()),
          if (_slots?.isEmpty ?? false) const Text('No free times that day.', key: Key('no-slots')),
          Wrap(spacing: NexaSpace.sm, runSpacing: NexaSpace.sm, children: [
            for (final s in _slots ?? <Slot>[])
              OutlinedButton(key: Key('slot-${s.startsAt.toUtc().toIso8601String()}'), onPressed: _booking ? null : () => _book(s), child: Text(hhmm(s.startsAt.toLocal()))),
          ]),
          const SizedBox(height: NexaSpace.md),
          Text('Times are in your phone’s time zone.', style: Theme.of(context).textTheme.bodySmall),
        ]),
      );
}

/// Orders and bookings you made, with cancelling where it's still allowed.
class MyOrdersScreen extends StatefulWidget {
  const MyOrdersScreen({super.key, required this.auth, this.openUrl = openInBrowser});
  final AuthController auth;
  final OpenUrl openUrl;

  @override
  State<MyOrdersScreen> createState() => _MyOrdersScreenState();
}

class _MyOrdersScreenState extends State<MyOrdersScreen> {
  List<Order>? _orders;
  List<Booking> _bookings = [];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final r = await Future.wait([widget.auth.authed('GET', '/v1/orders'), widget.auth.authed('GET', '/v1/bookings?upcoming=false')]);
      if (!mounted) return;
      setState(() {
        _orders = [for (final o in r[0]!['orders'] as List) Order.fromJson(o as Map<String, dynamic>)];
        _bookings = [for (final k in r[1]!['bookings'] as List) Booking.fromJson(k as Map<String, dynamic>)];
      });
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _cancel(String path) async {
    try {
      await widget.auth.authed('POST', path);
      await _load();
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  /// A paid deposit may be kept by the business, so say what happens before cancelling.
  Future<void> _cancelBooking(Booking k) async {
    final note = k.cancellationNote(DateTime.now());
    if (note != null) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          content: Text('Cancel this booking? $note'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
            TextButton(key: const Key('confirm-cancel-booking'), onPressed: () => Navigator.pop(ctx, true), child: const Text('Cancel booking')),
          ],
        ),
      );
      if (ok != true) return;
    }
    await _cancel('/v1/bookings/${k.id}/cancel');
  }

  Future<void> _pay(String id, {String kind = 'orders'}) async {
    try {
      await _payOnline(widget.auth, id, widget.openUrl, kind: kind);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Orders and bookings'),
          actions: [IconButton(key: const Key('refresh-orders'), tooltip: 'Refresh', icon: const Icon(Icons.refresh), onPressed: _load)],
        ),
        body: _orders == null
            ? const Center(child: CircularProgressIndicator())
            : ListView(children: [
                const ListTile(title: Text('Bookings')),
                if (_bookings.isEmpty) const ListTile(title: Text('No bookings yet.')),
                for (final k in _bookings)
                  ListTile(
                    key: Key('booking-${k.id}'),
                    title: Text('${k.serviceName} · ${k.businessName}'),
                    subtitle: Text([
                      '${isoDate(k.startsAt.toLocal())} ${hhmm(k.startsAt.toLocal())} · '
                          '${k.status == 'cancelled' ? (k.cancelledBy == 'business' ? 'Cancelled by the business' : 'Cancelled') : bookingStatusLabels[k.status] ?? k.status}',
                      if (k.depositLabel != null) k.depositLabel!,
                      if (k.status == 'confirmed' && k.cancellationNote(DateTime.now()) != null) k.cancellationNote(DateTime.now())!,
                    ].join('\n')),
                    isThreeLine: k.depositLabel != null,
                    trailing: k.status == 'pending_payment'
                        ? Row(mainAxisSize: MainAxisSize.min, children: [
                            TextButton(key: Key('pay-booking-${k.id}'), onPressed: () => _pay(k.id, kind: 'bookings'), child: const Text('Pay deposit')),
                            TextButton(key: Key('cancel-booking-${k.id}'), onPressed: () => _cancel('/v1/bookings/${k.id}/cancel'), child: const Text('Cancel')),
                          ])
                        : k.status == 'confirmed' && k.startsAt.isAfter(DateTime.now())
                            ? TextButton(key: Key('cancel-booking-${k.id}'), onPressed: () => _cancelBooking(k), child: const Text('Cancel'))
                            : null,
                  ),
                const ListTile(title: Text('Orders')),
                if (_orders!.isEmpty) const ListTile(title: Text('No orders yet.')),
                for (final o in _orders!)
                  ListTile(
                    key: Key('order-${o.id}'),
                    title: Text('${o.businessName} · ${orderStatusLabels[o.status] ?? o.status}'),
                    subtitle: Text('${o.lines.map((l) => '${l.quantity} × ${l.name}').join(', ')}\n${formatMoney(o.totalMinor, o.currency)}, ${o.paymentLabel}'
                        '${o.statusReason.isNotEmpty ? ' · ${o.statusReason}' : ''}'),
                    isThreeLine: true,
                    trailing: o.status == 'pending_payment'
                        ? Row(mainAxisSize: MainAxisSize.min, children: [
                            TextButton(key: Key('pay-order-${o.id}'), onPressed: () => _pay(o.id), child: const Text('Pay now')),
                            TextButton(key: Key('cancel-order-${o.id}'), onPressed: () => _cancel('/v1/orders/${o.id}/cancel'), child: const Text('Cancel')),
                          ])
                        : o.status == 'placed'
                            ? TextButton(key: Key('cancel-order-${o.id}'), onPressed: () => _cancel('/v1/orders/${o.id}/cancel'), child: const Text('Cancel'))
                            : null,
                  ),
              ]),
      );
}
