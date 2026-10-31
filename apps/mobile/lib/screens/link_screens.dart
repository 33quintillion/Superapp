import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../theme/tokens.g.dart';

/// What the website's QR code holds before the code itself.
const linkPrefix = 'SUPERAPP-LINK:';

/// The 8-character code in a scanned QR code or in what someone typed, or null.
String? linkCodeFrom(String raw) {
  final text = raw.trim().toUpperCase();
  final body = text.startsWith(linkPrefix) ? text.substring(linkPrefix.length) : text;
  final code = body.replaceAll(RegExp(r'[^0-9A-Z]'), '');
  return RegExp(r'^[2-9A-HJKMNP-Z]{8}$').hasMatch(code) ? code : null;
}

/// Opens the camera and returns the first SuperApp link code it sees.
Future<String?> scanLinkCode(BuildContext context) => Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const _ScanScreen()));

class _ScanScreen extends StatefulWidget {
  const _ScanScreen();
  @override
  State<_ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<_ScanScreen> {
  bool _done = false;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Scan the code')),
        body: Stack(children: [
          MobileScanner(
            onDetect: (capture) {
              if (_done) return;
              for (final b in capture.barcodes) {
                final code = b.rawValue == null ? null : linkCodeFrom(b.rawValue!);
                if (code != null) {
                  _done = true;
                  Navigator.of(context).pop(code);
                  return;
                }
              }
            },
          ),
          const Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: EdgeInsets.all(NexaSpace.xl),
              child: Text('Point the camera at the code on your computer’s screen.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white, fontSize: 16)),
            ),
          ),
        ]),
      );
}

/// Linking a computer (the website, later the Windows app) to this account, as WhatsApp's
/// Linked devices does: scan or type the code it shows, check what it is, approve.
class LinkDeviceScreen extends StatefulWidget {
  const LinkDeviceScreen({super.key, required this.auth, this.scan = scanLinkCode});
  final AuthController auth;
  /// Opens the camera; tests replace it.
  final Future<String?> Function(BuildContext) scan;
  @override
  State<LinkDeviceScreen> createState() => _LinkDeviceScreenState();
}

class _LinkDeviceScreenState extends State<LinkDeviceScreen> {
  final _typed = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _linked;

  Future<void> _link(String? raw) async {
    if (raw == null) return;
    final code = linkCodeFrom(raw);
    if (code == null) return setState(() => _error = 'That isn’t a SuperApp code. It has 8 letters and numbers, like ABCD-2345.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final what = await widget.auth.describeLink(code);
      if (!mounted) return;
      final browser = what['browser'] as String?;
      final name = '${what['deviceName'] ?? 'A computer'}${browser == null ? '' : ' ($browser)'}';
      final ok = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Link this device?'),
          content: Text('$name will be signed in to your SuperApp account and can read and send your messages. Only link a device you’re using right now.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
            FilledButton(key: const Key('approve-link'), onPressed: () => Navigator.pop(context, true), child: const Text('Link device')),
          ],
        ),
      );
      if (ok != true) return;
      await widget.auth.approveLink(code);
      if (mounted) setState(() => _linked = name);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.code == 'invalid_token' ? 'That code has expired or was already used. Get a new one on the computer.' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Link a device')),
        body: ListView(padding: const EdgeInsets.all(NexaSpace.lg), children: [
          if (_linked != null) ...[
            Text('$_linked is now linked.', key: const Key('link-done'), style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: NexaSpace.sm),
            const Text('You can sign it out any time from your devices list.'),
          ] else ...[
            const Text('On your computer, open SuperApp and choose “Log in with a QR code”. Then scan the code it shows.'),
            const SizedBox(height: NexaSpace.lg),
            FilledButton.icon(
              key: const Key('scan-code'),
              onPressed: _busy ? null : () async => _link(await widget.scan(context)),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan the code'),
            ),
            const SizedBox(height: NexaSpace.xl),
            TextField(
              key: const Key('typed-code'),
              controller: _typed,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Or type the code', helperText: 'Shown under the QR code, like ABCD-2345'),
            ),
            const SizedBox(height: NexaSpace.md),
            OutlinedButton(key: const Key('link-typed'), onPressed: _busy ? null : () => _link(_typed.text), child: const Text('Link with this code')),
          ],
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: NexaSpace.md),
              child: Text(_error!, key: const Key('link-error'), style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ]),
      );
}
