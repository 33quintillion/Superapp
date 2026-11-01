import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../business/business_models.dart';
import '../theme/tokens.g.dart';
import 'business_screens.dart';

/// A mini-program's colour, and the text colour that reads on it.
(Color, Color) accentColors(String accent) => switch (accent) {
      'burgundy' => (const Color(0xFF7B1E3A), const Color(0xFFFDF8EE)),
      'gold' => (const Color(0xFFE3B448), const Color(0xFF14213D)),
      'red' => (const Color(0xFFC1121F), Colors.white),
      'green' => (const Color(0xFF1B5E3B), Colors.white),
      _ => (const Color(0xFF14213D), const Color(0xFFF6F0E1)),
    };

/// Mini-programs from businesses, as in WeChat: search, recently used, and all of them.
class MiniProgramsScreen extends StatefulWidget {
  const MiniProgramsScreen({super.key, required this.auth});
  final AuthController auth;
  @override
  State<MiniProgramsScreen> createState() => _MiniProgramsScreenState();
}

class _MiniProgramsScreenState extends State<MiniProgramsScreen> {
  final _q = TextEditingController();
  List<Map<String, dynamic>>? _all;
  List<Map<String, dynamic>> _recent = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final q = _q.text.trim();
      final all = await widget.auth.authed('GET', '/v1/mini-programs${q.isEmpty ? '' : '?q=${Uri.encodeQueryComponent(q)}'}');
      final recent = q.isEmpty ? await widget.auth.authed('GET', '/v1/me/mini-programs/recent') : null;
      if (!mounted) return;
      setState(() {
        _all = (all!['miniPrograms'] as List).cast<Map<String, dynamic>>();
        _recent = (recent?['miniPrograms'] as List? ?? const []).cast<Map<String, dynamic>>();
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _open(Map<String, dynamic> m) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => MiniProgramScreen(auth: widget.auth, id: m['id'] as String)));
    await _load();
  }

  Widget _card(Map<String, dynamic> m, String prefix) {
    final (bg, fg) = accentColors(m['accent'] as String? ?? 'navy');
    final b = m['business'] as Map<String, dynamic>;
    return ListTile(
      key: Key('$prefix-${m['id']}'),
      leading: CircleAvatar(backgroundColor: bg, foregroundColor: fg, child: Text(m['icon'] as String? ?? '🛍️', style: TextStyle(fontSize: 20, color: fg))),
      title: Text(m['name'] as String),
      subtitle: Text('${b['name']}${b['verified'] == true ? ' ✓' : ''}'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => _open(m),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Mini-programs')),
        body: RefreshIndicator(
          onRefresh: _load,
          child: ListView(padding: const EdgeInsets.all(NexaSpace.md), children: [
            TextField(
              key: const Key('mini-search'),
              controller: _q,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _load(),
              decoration: const InputDecoration(hintText: 'Search mini-programs', prefixIcon: Icon(Icons.search)),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.all(NexaSpace.md), child: Text(_error!)),
            if (_recent.isNotEmpty) ...[
              const Padding(padding: EdgeInsets.only(top: NexaSpace.lg), child: Text('Recently used', style: TextStyle(fontWeight: FontWeight.w600))),
              for (final m in _recent) _card(m, 'mini-recent'),
            ],
            Padding(
              padding: const EdgeInsets.only(top: NexaSpace.lg),
              child: Text(_q.text.trim().isEmpty ? 'All mini-programs' : 'Results', style: const TextStyle(fontWeight: FontWeight.w600)),
            ),
            if (_all == null)
              const Padding(padding: EdgeInsets.all(NexaSpace.xl), child: Center(child: CircularProgressIndicator()))
            else if (_all!.isEmpty)
              const Padding(padding: EdgeInsets.all(NexaSpace.md), child: Text('None yet.'))
            else
              for (final m in _all!) _card(m, 'mini'),
          ]),
        ),
      );
}

/// One mini-program, drawn by SuperApp from its blocks: no code from the business runs here.
class MiniProgramScreen extends StatefulWidget {
  const MiniProgramScreen({super.key, required this.auth, required this.id, this.openUrl = openInBrowser});
  final AuthController auth;
  final String id;
  final Future<void> Function(Uri) openUrl;
  @override
  State<MiniProgramScreen> createState() => _MiniProgramScreenState();
}

class _MiniProgramScreenState extends State<MiniProgramScreen> {
  Map<String, dynamic>? _m;
  List<CatalogueItem> _items = [];
  List<Map<String, dynamic>> _hours = [];
  String? _pageId;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final m = (await widget.auth.authed('GET', '/v1/mini-programs/${widget.id}'))!;
      final blocks = [for (final p in m['pages'] as List) ...(p['blocks'] as List)].cast<Map<String, dynamic>>();
      final bid = (m['business'] as Map)['id'];
      final items = blocks.any((b) => b['type'] == 'items') ? await widget.auth.authed('GET', '/v1/businesses/$bid/items') : null;
      final hours = blocks.any((b) => b['type'] == 'hours') ? await widget.auth.authed('GET', '/v1/businesses/$bid/hours') : null;
      if (!mounted) return;
      setState(() {
        _m = m;
        _items = [for (final i in (items?['items'] as List? ?? const [])) CatalogueItem.fromJson(i as Map<String, dynamic>)];
        _hours = (hours?['hours'] as List? ?? const []).cast<Map<String, dynamic>>();
        _pageId = ((m['pages'] as List).first as Map)['id'] as String;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.status == 404 ? 'This mini-program isn’t available.' : e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = _m;
    if (m == null) {
      return Scaffold(appBar: AppBar(title: const Text('Mini-program')), body: Center(child: _error == null ? const CircularProgressIndicator() : Text(_error!)));
    }
    final pages = (m['pages'] as List).cast<Map<String, dynamic>>();
    final page = pages.firstWhere((p) => p['id'] == _pageId, orElse: () => pages.first);
    final home = identical(page, pages.first);
    final (bg, fg) = accentColors(m['accent'] as String? ?? 'navy');
    final business = m['business'] as Map<String, dynamic>;
    return PopScope(
      canPop: home,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) setState(() => _pageId = pages.first['id'] as String);
      },
      child: Scaffold(
        appBar: AppBar(
          backgroundColor: bg,
          foregroundColor: fg,
          title: Row(children: [
            Text(m['icon'] as String? ?? '🛍️', style: const TextStyle(fontSize: 22)),
            const SizedBox(width: NexaSpace.sm),
            Flexible(child: Text(home ? m['name'] as String : page['title'] as String, key: const Key('mini-title'))),
          ]),
        ),
        body: ListView(key: Key('mini-page-${page['id']}'), padding: const EdgeInsets.all(NexaSpace.lg), children: [
          if (home && (m['tagline'] as String? ?? '').isNotEmpty)
            Padding(padding: const EdgeInsets.only(bottom: NexaSpace.md), child: Text(m['tagline'] as String, style: Theme.of(context).textTheme.bodySmall)),
          for (final b in (page['blocks'] as List).cast<Map<String, dynamic>>())
            Padding(padding: const EdgeInsets.only(bottom: NexaSpace.md), child: _block(context, b, business, bg, fg)),
          Text('A mini-program by ${business['name']} · inside SuperApp', style: Theme.of(context).textTheme.labelSmall),
        ]),
      ),
    );
  }

  Widget _block(BuildContext context, Map<String, dynamic> b, Map<String, dynamic> business, Color bg, Color fg) {
    final text = Theme.of(context).textTheme;
    switch (b['type']) {
      case 'heading':
        return Text(b['text'] as String, style: text.headlineSmall);
      case 'text':
        return Text(b['text'] as String);
      case 'divider':
        return const Divider();
      case 'items':
        return Column(key: const Key('mini-items'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if ((b['title'] as String? ?? '').isNotEmpty) Text(b['title'] as String, style: text.titleMedium),
          if (_items.isEmpty) const Text('Nothing on the menu right now.'),
          for (final it in _items)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(it.name),
              subtitle: it.description.isEmpty ? null : Text(it.description),
              trailing: Text(formatMoney(it.priceMinor, it.currency), style: text.titleSmall),
            ),
        ]);
      case 'hours':
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return Column(key: const Key('mini-hours'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Opening hours', style: text.titleMedium),
          if (_hours.isEmpty)
            const Text('Not listed.')
          else
            for (var d = 0; d < 7; d++)
              Row(children: [
                Expanded(child: Text(days[d])),
                Text(() {
                  final s = _hours.where((h) => h['weekday'] == d).map((h) => '${h['opens']}–${h['closes']}').toList();
                  return s.isEmpty ? 'Closed' : s.join(', ');
                }()),
              ]),
        ]);
      case 'location':
        final lat = (b['lat'] as num).toDouble();
        final lng = (b['lng'] as num).toDouble();
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.place),
          title: Text((b['label'] as String? ?? '').isEmpty ? 'Find us' : b['label'] as String),
          subtitle: const Text('Open map'),
          onTap: () => widget.openUrl(Uri.parse('https://www.openstreetmap.org/?mlat=$lat&mlon=$lng#map=17/$lat/$lng')),
        );
      case 'button':
        final a = b['action'] as Map<String, dynamic>;
        VoidCallback? onPressed;
        switch (a['type']) {
          case 'page':
            onPressed = () => setState(() => _pageId = a['pageId'] as String);
          case 'order' || 'book':
            final on = business[a['type'] == 'order' ? 'ordersEnabled' : 'bookingsEnabled'] == true;
            if (on) {
              onPressed = () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => StorefrontScreen(auth: widget.auth, handle: business['handle'] as String)));
            }
          case 'call':
            final phone = business['phone'] as String?;
            if (phone == null) return const SizedBox.shrink();
            onPressed = () => widget.openUrl(Uri.parse('tel:$phone'));
          case 'link':
            onPressed = () => widget.openUrl(Uri.parse(a['url'] as String));
        }
        return FilledButton(
          key: Key('mini-button-${b['label']}'),
          style: FilledButton.styleFrom(backgroundColor: bg, foregroundColor: fg),
          onPressed: onPressed,
          child: Text(a['type'] == 'link' ? '${b['label']} ↗' : b['label'] as String),
        );
    }
    return const SizedBox.shrink();
  }
}
