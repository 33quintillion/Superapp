import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../business/back_office_models.dart';
import '../business/business_models.dart';
import '../chat/realtime.dart' show newClientId;
import '../theme/tokens.g.dart';
import 'business_screens.dart' show OpenUrl, openInBrowser;

/// The theme makes filled buttons full width; these sit in rows, lists and dialogs.
final _inline = FilledButton.styleFrom(minimumSize: const Size(64, 48));

void _snack(BuildContext context, Object e) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : e is FormatException ? e.message : '$e')));
}

Future<bool> _confirm(BuildContext context, String question, {String yes = 'Yes'}) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        content: Text(question),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('No')),
          TextButton(key: const Key('confirm-yes'), onPressed: () => Navigator.pop(ctx, true), child: Text(yes)),
        ],
      ),
    ) ??
    false;

/// The businesses you own or work at.
class MyBusinessesScreen extends StatefulWidget {
  const MyBusinessesScreen({super.key, required this.auth, this.openUrl = openInBrowser});
  final AuthController auth;
  final OpenUrl openUrl;

  @override
  State<MyBusinessesScreen> createState() => _MyBusinessesScreenState();
}

class _MyBusinessesScreenState extends State<MyBusinessesScreen> {
  List<Business>? _list;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final r = await widget.auth.authed('GET', '/v1/me/businesses');
      if (mounted) setState(() => _list = [for (final b in r!['businesses'] as List) Business.fromJson(b as Map<String, dynamic>)].where((b) => b.myRole != null).toList());
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Your businesses')),
        body: _list == null
            ? const Center(child: CircularProgressIndicator())
            : ListView(children: [
                if (_list!.isEmpty) const ListTile(title: Text('You don’t run or work at a business yet. Create one on the website.')),
                for (final b in _list!)
                  ListTile(
                    key: Key('my-business-${b.handle}'),
                    title: Text(b.name),
                    subtitle: Text('@${b.handle} · ${b.myRole}'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ManageBusinessScreen(auth: widget.auth, business: b, openUrl: widget.openUrl))),
                  ),
              ]),
      );
}

/// Running a business from the phone: orders, bookings, the catalogue and money.
class ManageBusinessScreen extends StatelessWidget {
  const ManageBusinessScreen({super.key, required this.auth, required this.business, this.openUrl = openInBrowser, this.now});
  final AuthController auth;
  final Business business;
  final OpenUrl openUrl;

  /// Tests pin the clock.
  final DateTime Function()? now;

  @override
  Widget build(BuildContext context) {
    final b = business;
    final tabs = <(String, Widget)>[
      ('Orders', OrdersTab(auth: auth, business: b, now: now)),
      ('Bookings', BookingsTab(auth: auth, business: b, now: now)),
      if (b.can('catalogue.manage')) ('Catalogue', CatalogueTab(auth: auth, business: b)),
      if (b.can('payments.view')) ('Money', MoneyTab(auth: auth, business: b, openUrl: openUrl)),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: AppBar(
          title: Text(b.name),
          bottom: TabBar(isScrollable: true, tabs: [for (final t in tabs) Tab(key: Key('tab-${t.$1.toLowerCase()}'), text: t.$1)]),
        ),
        body: TabBarView(children: [for (final t in tabs) t.$2]),
      ),
    );
  }
}

/// Asks how much to refund (blank means everything left) and why, then refunds once:
/// the key stays the same while the dialog is open, so a retry can't refund twice.
Future<bool> showRefundDialog(BuildContext context, AuthController auth, {required String path, required int leftMinor, required String currency}) async {
  final amount = TextEditingController();
  final reason = TextEditingController();
  final key = newClientId();
  final done = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      key: const Key('refund-dialog'),
      title: const Text('Refund'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(
          key: const Key('refund-amount'),
          controller: amount,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(labelText: 'Amount', helperText: 'Leave empty to refund all ${formatMoney(leftMinor, currency)}'),
        ),
        TextField(key: const Key('refund-reason'), controller: reason, decoration: const InputDecoration(labelText: 'Reason (optional)')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
        FilledButton(style: _inline, 
          key: const Key('refund-send'),
          onPressed: () async {
            try {
              final a = amount.text.trim();
              await auth.authed('POST', path, body: {
                'clientId': key,
                'reason': reason.text.trim(),
                if (a.isNotEmpty) 'amountMinor': parseMoney(a, currency),
              });
              if (ctx.mounted) Navigator.pop(ctx, true);
            } on Exception catch (e) {
              if (ctx.mounted) _snack(ctx, e);
            }
          },
          child: const Text('Refund'),
        ),
      ],
    ),
  );
  return done ?? false;
}

class OrdersTab extends StatefulWidget {
  const OrdersTab({super.key, required this.auth, required this.business, this.now});
  final AuthController auth;
  final Business business;
  final DateTime Function()? now;

  @override
  State<OrdersTab> createState() => _OrdersTabState();
}

class _OrdersTabState extends State<OrdersTab> {
  bool _open = true;
  List<Order>? _orders;
  Timer? _poll;

  Business get b => widget.business;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    // New orders also arrive over the WebSocket; polling keeps this screen simple and correct.
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_load()));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final status = _open ? 'placed,accepted,ready' : 'completed,cancelled,rejected';
      final r = await widget.auth.authed('GET', '/v1/businesses/${b.id}/orders?status=$status');
      if (mounted) setState(() => _orders = [for (final o in r!['orders'] as List) Order.fromJson(o as Map<String, dynamic>)]);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _move(Order o, String to) async {
    try {
      await widget.auth.authed('POST', '/v1/orders/${o.id}/status', body: {'status': to});
      await _load();
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
          SegmentedButton<bool>(
            key: const Key('orders-filter'),
            segments: const [ButtonSegment(value: true, label: Text('Open')), ButtonSegment(value: false, label: Text('Finished'))],
            selected: {_open},
            onSelectionChanged: (s) {
              setState(() {
                _open = s.first;
                _orders = null;
              });
              unawaited(_load());
            },
          ),
          if (_orders == null) const Padding(padding: EdgeInsets.all(NexaSpace.lg), child: Center(child: CircularProgressIndicator())),
          if (_orders?.isEmpty ?? false) const ListTile(title: Text('No orders here.')),
          for (final o in _orders ?? <Order>[])
            Card(
              key: Key('staff-order-${o.id}'),
              child: Padding(
                padding: const EdgeInsets.all(NexaSpace.md),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${o.customerName ?? 'Customer'} · ${orderStatusLabels[o.status] ?? o.status}', style: Theme.of(context).textTheme.titleSmall),
                  Text(o.lines.map((l) => '${l.quantity} × ${l.name}').join(', ')),
                  Text(
                    '${formatMoney(o.totalMinor, o.currency)} · ${o.paymentStatus == null ? 'pay at pickup' : paymentStatusLabels[o.paymentStatus]!.toLowerCase()}'
                    '${o.refundedMinor > 0 ? ' · ${formatMoney(o.refundedMinor, o.currency)} refunded' : ''}'
                    '${o.note.isNotEmpty ? ' · “${o.note}”' : ''}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  Wrap(spacing: NexaSpace.sm, children: [
                    if (b.can('orders.manage'))
                      for (final (to, label) in orderNextSteps[o.status] ?? const <(String, String)>[])
                        to == 'rejected' || to == 'cancelled'
                            ? TextButton(key: Key('order-${o.id}-$to'), onPressed: () => _move(o, to), child: Text(label))
                            : FilledButton.tonal(style: _inline, key: Key('order-${o.id}-$to'), onPressed: () => _move(o, to), child: Text(label)),
                    if (b.can('orders.refund') && o.refundable)
                      TextButton(
                        key: Key('refund-order-${o.id}'),
                        onPressed: () async {
                          if (await showRefundDialog(context, widget.auth, path: '/v1/orders/${o.id}/refunds', leftMinor: o.totalMinor - o.refundedMinor, currency: o.currency)) await _load();
                        },
                        child: const Text('Refund'),
                      ),
                  ]),
                ]),
              ),
            ),
        ]),
      );
}

class BookingsTab extends StatefulWidget {
  const BookingsTab({super.key, required this.auth, required this.business, this.now});
  final AuthController auth;
  final Business business;
  final DateTime Function()? now;

  @override
  State<BookingsTab> createState() => _BookingsTabState();
}

class _BookingsTabState extends State<BookingsTab> {
  List<Booking>? _bookings;

  Business get b => widget.business;
  DateTime get _now => (widget.now ?? DateTime.now)();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final from = _now.subtract(const Duration(days: 1)).toUtc().toIso8601String();
      final to = _now.add(const Duration(days: 30)).toUtc().toIso8601String();
      final r = await widget.auth.authed('GET', '/v1/businesses/${b.id}/bookings?from=${Uri.encodeQueryComponent(from)}&to=${Uri.encodeQueryComponent(to)}');
      if (mounted) setState(() => _bookings = [for (final k in r!['bookings'] as List) Booking.fromJson(k as Map<String, dynamic>)]);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _post(String path, [Object? body]) async {
    try {
      await widget.auth.authed('POST', path, body: body);
      await _load();
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _cancel(Booking k) async {
    final d = k.deposit;
    final question = d != null && d.status == 'paid' ? 'Cancel this booking? The ${formatMoney(d.amountMinor, k.currency)} deposit will be refunded.' : 'Cancel this booking?';
    if (await _confirm(context, question, yes: 'Cancel booking')) await _post('/v1/bookings/${k.id}/cancel');
  }

  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
          Text('Yesterday to 30 days ahead, times in your phone’s time zone.', style: Theme.of(context).textTheme.bodySmall),
          if (_bookings == null) const Padding(padding: EdgeInsets.all(NexaSpace.lg), child: Center(child: CircularProgressIndicator())),
          if (_bookings?.isEmpty ?? false) const ListTile(title: Text('No bookings yet.')),
          for (final k in _bookings ?? <Booking>[])
            Card(
              key: Key('staff-booking-${k.id}'),
              child: Padding(
                padding: const EdgeInsets.all(NexaSpace.md),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${isoDate(k.startsAt.toLocal())} ${hhmm(k.startsAt.toLocal())} · ${k.serviceName}', style: Theme.of(context).textTheme.titleSmall),
                  Text('${k.customerName ?? 'Customer'} · ${bookingStatusLabels[k.status] ?? k.status}'),
                  if (k.depositLabel != null) Text(k.depositLabel!, key: Key('staff-booking-deposit-${k.id}'), style: Theme.of(context).textTheme.bodySmall),
                  if (k.note.isNotEmpty) Text('“${k.note}”', style: Theme.of(context).textTheme.bodySmall),
                  Wrap(spacing: NexaSpace.sm, children: [
                    if (k.status == 'confirmed' && b.can('bookings.manage')) ...[
                      if (!k.startsAt.isAfter(_now)) ...[
                        FilledButton.tonal(style: _inline, key: Key('booking-${k.id}-came'), onPressed: () => _post('/v1/bookings/${k.id}/outcome', {'status': 'completed'}), child: const Text('Came')),
                        TextButton(key: Key('booking-${k.id}-no-show'), onPressed: () => _post('/v1/bookings/${k.id}/outcome', {'status': 'no_show'}), child: const Text('No-show')),
                      ] else
                        TextButton(key: Key('booking-${k.id}-cancel'), onPressed: () => _cancel(k), child: const Text('Cancel')),
                    ],
                    if (b.can('bookings.refund') && (k.deposit?.refundable ?? false))
                      TextButton(
                        key: Key('refund-booking-${k.id}'),
                        onPressed: () async {
                          final d = k.deposit!;
                          if (await showRefundDialog(context, widget.auth, path: '/v1/bookings/${k.id}/refunds', leftMinor: d.amountMinor - d.refundedMinor, currency: k.currency)) await _load();
                        },
                        child: const Text('Refund deposit'),
                      ),
                  ]),
                ]),
              ),
            ),
        ]),
      );
}

/// Items for sale: add one, mark it sold out or back, or take it off the menu.
class CatalogueTab extends StatefulWidget {
  const CatalogueTab({super.key, required this.auth, required this.business});
  final AuthController auth;
  final Business business;

  @override
  State<CatalogueTab> createState() => _CatalogueTabState();
}

class _CatalogueTabState extends State<CatalogueTab> {
  List<CatalogueItem>? _items;

  Business get b => widget.business;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final r = await widget.auth.authed('GET', '/v1/businesses/${b.id}/items?all=true');
      if (mounted) setState(() => _items = [for (final i in r!['items'] as List) CatalogueItem.fromJson(i as Map<String, dynamic>)]);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _call(String method, String path, [Object? body]) async {
    try {
      await widget.auth.authed(method, path, body: body);
      await _load();
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _add() async {
    final name = TextEditingController();
    final price = TextEditingController();
    final added = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New item'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(key: const Key('item-name'), controller: name, decoration: const InputDecoration(labelText: 'Name')),
          TextField(
            key: const Key('item-price'),
            controller: price,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: 'Price', prefixText: '${b.currency} '),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          FilledButton(style: _inline, 
            key: const Key('item-save'),
            onPressed: () async {
              try {
                await widget.auth.authed('POST', '/v1/businesses/${b.id}/items', body: {'name': name.text.trim(), 'priceMinor': parseMoney(price.text, b.currency)});
                if (ctx.mounted) Navigator.pop(ctx, true);
              } on Exception catch (e) {
                if (ctx.mounted) _snack(ctx, e);
              }
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );
    if (added ?? false) await _load();
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
        Align(alignment: Alignment.centerLeft, child: FilledButton.icon(style: _inline, key: const Key('add-item'), onPressed: _add, icon: const Icon(Icons.add), label: const Text('Add item'))),
        if (_items == null) const Padding(padding: EdgeInsets.all(NexaSpace.lg), child: Center(child: CircularProgressIndicator())),
        if (_items?.isEmpty ?? false) const ListTile(title: Text('Nothing for sale yet.')),
        for (final i in _items ?? <CatalogueItem>[])
          ListTile(
            key: Key('catalogue-${i.id}'),
            title: Text(i.name),
            subtitle: Text('${formatMoney(i.priceMinor, i.currency)}${i.available ? '' : ' · Sold out'}'),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              Semantics(
                label: i.available ? 'On sale' : 'Sold out',
                child: Switch(key: Key('available-${i.id}'), value: i.available, onChanged: (v) => _call('PATCH', '/v1/businesses/${b.id}/items/${i.id}', {'available': v})),
              ),
              IconButton(
                key: Key('remove-${i.id}'),
                tooltip: 'Remove from the catalogue',
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  if (await _confirm(context, 'Remove ${i.name} from the catalogue?', yes: 'Remove')) await _call('DELETE', '/v1/businesses/${b.id}/items/${i.id}');
                },
              ),
            ]),
          ),
        const SizedBox(height: NexaSpace.md),
        Text('Bookable services, stock and photos are edited on the website.', style: Theme.of(context).textTheme.bodySmall),
      ]);
}

/// Payouts, disputes, what was paid online, and the business's plan.
class MoneyTab extends StatefulWidget {
  const MoneyTab({super.key, required this.auth, required this.business, this.openUrl = openInBrowser});
  final AuthController auth;
  final Business business;
  final OpenUrl openUrl;

  @override
  State<MoneyTab> createState() => _MoneyTabState();
}

class _MoneyTabState extends State<MoneyTab> {
  PayoutAccount? _account;
  BusinessSubscription? _sub;
  List<Plan> _plans = [];
  List<PaymentRecord> _payments = [];
  List<PaymentTotals> _totals = [];
  List<Dispute> _disputes = [];
  List<Payout> _payouts = [];
  String _country = 'GB';

  Business get b => widget.business;
  AuthController get auth => widget.auth;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final r = await Future.wait([
        auth.authed('GET', '/v1/businesses/${b.id}/payments/account'),
        auth.authed('GET', '/v1/businesses/${b.id}/subscription'),
        auth.authed('GET', '/v1/plans'),
        auth.authed('GET', '/v1/businesses/${b.id}/payments?limit=20'),
        auth.authed('GET', '/v1/businesses/${b.id}/disputes'),
      ]);
      final account = PayoutAccount.fromJson(r[0]!);
      // Payouts come from the provider; the rest of the screen works without them.
      var payouts = <Payout>[];
      if (account.connected) {
        try {
          final p = await auth.authed('GET', '/v1/businesses/${b.id}/payouts');
          payouts = [for (final x in p!['payouts'] as List) Payout.fromJson(x as Map<String, dynamic>)];
        } on ApiException {
          payouts = [];
        }
      }
      if (!mounted) return;
      setState(() {
        _account = account;
        _country = account.country ?? _country;
        _sub = BusinessSubscription.fromJson(r[1]!);
        _plans = [for (final p in r[2]!['plans'] as List) Plan.fromJson(p as Map<String, dynamic>)];
        _payments = [for (final p in r[3]!['payments'] as List) PaymentRecord.fromJson(p as Map<String, dynamic>)];
        _totals = [for (final t in r[3]!['totals'] as List? ?? const []) PaymentTotals.fromJson(t as Map<String, dynamic>)];
        _disputes = [for (final d in r[4]!['disputes'] as List) Dispute.fromJson(d as Map<String, dynamic>)];
        _payouts = payouts;
      });
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  /// Opens one of the provider's hosted pages (payout setup, plan checkout, card and invoices).
  Future<void> _go(String path, [Object? body]) async {
    try {
      final r = await auth.authed('POST', path, body: body);
      await widget.openUrl(Uri.parse(r!['url'] as String));
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _call(String method, String path, [Object? body]) async {
    try {
      await auth.authed(method, path, body: body);
      await _load();
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  Future<void> _respond(Dispute d) async {
    final text = TextEditingController();
    final sent = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('dispute-dialog'),
        title: const Text('Your side'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Tell the bank what happened: what was bought, when it was collected, and anything that shows it. You can send this once.'),
          TextField(key: const Key('dispute-text'), controller: text, maxLines: 5, maxLength: 20000),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          FilledButton(style: _inline, 
            key: const Key('dispute-send'),
            onPressed: () async {
              if (text.text.trim().isEmpty) return;
              try {
                await auth.authed('POST', '/v1/disputes/${d.id}/response', body: {'text': text.text.trim()});
                if (ctx.mounted) Navigator.pop(ctx, true);
              } on ApiException catch (e) {
                if (ctx.mounted) _snack(ctx, e);
              }
            },
            child: const Text('Send to the bank'),
          ),
        ],
      ),
    );
    if (sent ?? false) await _load();
  }

  Future<void> _switchTo(Plan p) async {
    try {
      final preview = PlanChangePreview.fromJson((await auth.authed('POST', '/v1/businesses/${b.id}/subscription/preview', body: {'planCode': p.code}))!);
      if (!mounted) return;
      final due = preview.amountDueNowMinor;
      final cost = due > 0
          ? 'costs ${formatMoney(due, preview.currency)} today, for the rest of this period.'
          : due < 0
              ? 'gives you ${formatMoney(-due, preview.currency)} of credit towards your next bills.'
              : 'costs nothing extra today.';
      final ok = await _confirm(
        context,
        'Switching to ${p.name} $cost${preview.intervalChanges ? ' A new billing period starts today.' : ''} Then ${formatMoney(p.priceMinor, p.currency)} a ${p.interval}.',
        yes: 'Switch now',
      );
      if (ok) await _call('POST', '/v1/businesses/${b.id}/subscription/change', {'planCode': p.code, 'clientId': newClientId()});
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  String _date(DateTime d) => isoDate(d.toLocal());

  @override
  Widget build(BuildContext context) {
    final a = _account;
    final sub = _sub;
    if (a == null || sub == null) return const Center(child: CircularProgressIndicator());
    final text = Theme.of(context).textTheme;
    final owner = b.can('payments.manage');
    final billing = b.can('billing.manage');
    final plan = sub.plan;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
        Text('Online payments', style: text.titleMedium),
        if (!a.enabled)
          const Text('Online payments aren’t switched on for Nexa yet. Customers pay when they collect.')
        else if (a.onlinePayments)
          Text(
            'Customers can pay by card. Money goes to your own account at our payment provider${a.payoutsEnabled ? ', which pays it out to your bank.' : '; finish your bank details there to get paid out.'}',
            key: const Key('payouts-ready'),
          )
        else ...[
          Text(
            a.connected
                ? 'Your payout account isn’t finished yet. The payment provider needs a few more details before you can take card payments.'
                : 'Take card payments. Our payment provider checks who you are and pays out to your bank; Nexa never holds your money.',
            key: const Key('payouts-not-ready'),
          ),
          if (owner)
            Row(children: [
              if (!a.connected)
                DropdownButton<String>(
                  key: const Key('payout-country'),
                  value: _country,
                  items: [for (final c in payoutCountries) DropdownMenuItem(value: c, child: Text(c))],
                  onChanged: (c) => setState(() => _country = c ?? _country),
                ),
              const SizedBox(width: NexaSpace.sm),
              FilledButton(style: _inline, 
                key: const Key('setup-payouts'),
                onPressed: () => _go('/v1/businesses/${b.id}/payments/account', {'country': _country}),
                child: Text(a.connected ? 'Continue setup' : 'Set up payouts'),
              ),
            ])
          else
            Text('Only the owner can set up payouts.', style: text.bodySmall),
        ],
        if (_payouts.isNotEmpty) ...[
          const SizedBox(height: NexaSpace.md),
          Text('Recent payouts to your bank', style: text.titleSmall),
          for (final p in _payouts)
            ListTile(
              key: Key('payout-${p.id}'),
              dense: true,
              title: Text(formatMoney(p.amountMinor, p.currency)),
              subtitle: p.arrivalDate == null ? null : Text('Arrives ${_date(p.arrivalDate!)}'),
              trailing: Text(p.status.replaceAll('_', ' ')),
            ),
        ],
        if (_disputes.isNotEmpty) ...[
          const SizedBox(height: NexaSpace.lg),
          Text('Disputes', style: text.titleMedium),
          Text(
            'A customer asked their bank to take back a card payment. The bank holds the money while it decides; tell it your side before the date shown. If you win, the money comes back to you.',
            style: text.bodySmall,
          ),
          for (final d in _disputes)
            ListTile(
              key: Key('dispute-${d.id}'),
              title: Text('${formatMoney(d.amountMinor, d.currency)} · ${d.orderId != null ? 'order' : 'booking deposit'}'),
              subtitle: Text('${disputeStatusLabels[d.status] ?? d.status}'
                  '${d.reason.isNotEmpty ? ' · ${d.reason.replaceAll('_', ' ')}' : ''}'
                  '${d.canRespond && d.evidenceDueBy != null ? ' · respond by ${_date(d.evidenceDueBy!)}' : ''}'),
              trailing: d.canRespond && b.can('disputes.respond') ? TextButton(key: Key('respond-${d.id}'), onPressed: () => _respond(d), child: const Text('Respond')) : null,
            ),
        ],
        if (_totals.isNotEmpty || _payments.isNotEmpty) ...[
          const SizedBox(height: NexaSpace.lg),
          Text('Paid online', style: text.titleMedium),
          for (final t in _totals)
            Text(
              '${formatMoney(t.paidMinor, t.currency)} paid · ${formatMoney(t.refundedMinor, t.currency)} refunded'
              '${t.disputedMinor > 0 ? ' · ${formatMoney(t.disputedMinor, t.currency)} held by banks' : ''} · ${formatMoney(t.feesMinor, t.currency)} fees',
              key: Key('totals-${t.currency}'),
            ),
          for (final p in _payments)
            ListTile(
              key: Key('payment-${p.id}'),
              dense: true,
              title: Text('${formatMoney(p.amountMinor, p.currency)} · ${p.orderId != null ? 'order' : 'deposit'}'),
              subtitle: Text('${_date(p.createdAt)} · ${(paymentStatusLabels[p.status] ?? p.status).toLowerCase()}'
                  '${p.refundedMinor > 0 ? ' · ${formatMoney(p.refundedMinor, p.currency)} back' : ''}'
                  '${p.disputedMinor > 0 ? ' · ${formatMoney(p.disputedMinor, p.currency)} disputed' : ''}'),
            ),
        ],
        const SizedBox(height: NexaSpace.lg),
        Text('Plan', style: text.titleMedium),
        if (plan == null)
          const Text('Free plan.')
        else ...[
          Text(
            '${plan.name}, ${formatMoney(plan.priceMinor, plan.currency)} a ${plan.interval}.'
            '${sub.status == 'past_due' ? ' Payment failed: update your card.' : ''}'
            '${sub.currentPeriodEnd == null ? '' : sub.cancelAtPeriodEnd ? ' Ends on ${_date(sub.currentPeriodEnd!)}.' : ' Renews on ${_date(sub.currentPeriodEnd!)}.'}',
            key: const Key('current-plan'),
          ),
          if (billing)
            Wrap(spacing: NexaSpace.sm, children: [
              if (sub.cancelAtPeriodEnd)
                TextButton(key: const Key('resume-plan'), onPressed: () => _call('POST', '/v1/businesses/${b.id}/subscription/resume'), child: const Text('Keep my plan'))
              else
                TextButton(
                  key: const Key('cancel-plan'),
                  onPressed: () async {
                    if (await _confirm(context, 'Cancel ${plan.name} at the end of this period?', yes: 'Cancel plan')) await _call('DELETE', '/v1/businesses/${b.id}/subscription');
                  },
                  child: const Text('Cancel at the end of the period'),
                ),
              TextButton(key: const Key('billing-portal'), onPressed: () => _go('/v1/businesses/${b.id}/billing-portal'), child: const Text('Card and invoices')),
            ]),
          if (billing && !sub.cancelAtPeriodEnd && sub.status == 'active')
            for (final p in _plans.where((p) => p.id != plan.id && p.currency == plan.currency))
              ListTile(
                key: Key('switch-${p.code}'),
                title: Text('Switch to ${p.name}'),
                subtitle: Text('${formatMoney(p.priceMinor, p.currency)} a ${p.interval}'),
                trailing: TextButton(onPressed: () => _switchTo(p), child: const Text('See the cost')),
              ),
        ],
        Text('Up to ${sub.staffLimit} staff and ${sub.catalogueLimit} catalogue items.', key: const Key('limits'), style: text.bodySmall),
        if (plan == null && billing)
          for (final p in _plans)
            ListTile(
              key: Key('plan-${p.code}'),
              title: Text(p.name),
              subtitle: Text('${formatMoney(p.priceMinor, p.currency)} a ${p.interval}'),
              trailing: FilledButton(style: _inline, onPressed: () => _go('/v1/businesses/${b.id}/subscription', {'planCode': p.code, 'clientId': newClientId()}), child: const Text('Choose')),
            ),
      ]),
    );
  }
}
