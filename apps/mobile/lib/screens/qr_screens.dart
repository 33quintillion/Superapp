import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api/api_client.dart';
import '../chat/chat_controller.dart';
import '../theme/tokens.g.dart';
import 'chat_screens.dart';
import 'desktop_screens.dart';
import 'link_screens.dart';

Future<String?> _scanContact(BuildContext context) => scanCode(context, contactCodeFrom, 'Point the camera at someone’s SuperApp QR code.');

/// "My QR code", as in WeChat: others scan it to start a chat with you, and you scan theirs.
/// Your phone number is never in it. Reset it to stop old screenshots working.
class MyQrScreen extends StatefulWidget {
  const MyQrScreen({super.key, required this.chat, this.scan = _scanContact});
  final ChatController chat;
  final Future<String?> Function(BuildContext) scan;

  @override
  State<MyQrScreen> createState() => _MyQrScreenState();
}

class _MyQrScreenState extends State<MyQrScreen> {
  late Future<Map<String, dynamic>?> _mine = _load();
  bool _busy = false;

  Future<Map<String, dynamic>?> _load() => widget.chat.auth.authed('GET', '/v1/me/contact-code');

  void _say(String text) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _reset() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Reset your code?'),
        content: const Text('Your old QR code, and any screenshot or printout of it, will stop working.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(key: const Key('confirm-reset'), onPressed: () => Navigator.pop(ctx, true), child: const Text('Reset')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.chat.auth.authed('POST', '/v1/me/contact-code/reset');
      setState(() {
        _mine = _load();
      });
    } on ApiException catch (e) {
      _say(e.message);
    }
  }

  Future<void> _typeCode() async {
    final ctrl = TextEditingController();
    final typed = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Type a code'),
        content: TextField(key: const Key('typed-contact-code'), controller: ctrl, autofocus: true, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Code, like ABCDE-23456')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(key: const Key('find-contact'), onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Find')),
        ],
      ),
    );
    if (typed == null) return;
    final code = contactCodeFrom(typed);
    if (code == null) {
      _say('That isn’t a SuperApp code. It has 10 letters and numbers.');
      return;
    }
    await _open(code);
  }

  Future<void> _open(String? code) async {
    if (code == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final person = (await widget.chat.auth.authed('GET', '/v1/contact-codes/$code'))!;
      if (!mounted) return;
      if (person['self'] == true) {
        _say('That’s your own code.');
        return;
      }
      final name = person['displayName'] as String? ?? 'them';
      final go = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(name),
          content: Text(person['username'] == null ? 'Start a chat?' : '@${person['username']}\n\nStart a chat?'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(key: const Key('message-person'), onPressed: () => Navigator.pop(ctx, true), child: Text('Message $name')),
          ],
        ),
      );
      if (go != true || !mounted) return;
      final id = await widget.chat.openDirectById(person['id'] as String);
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChatScreen(chat: widget.chat, conversationId: id)));
    } on ApiException catch (e) {
      _say(e.status == 404 ? 'This code doesn’t work. It may have been reset by its owner.' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('My QR code')),
        body: FutureBuilder<Map<String, dynamic>?>(
          future: _mine,
          builder: (context, snap) {
            if (snap.hasError) return const Center(child: Text('Couldn’t load your code. Check your connection.'));
            final mine = snap.data;
            if (mine == null) return const Center(child: CircularProgressIndicator());
            final code = mine['code'] as String;
            final me = widget.chat.auth.profile;
            return ListView(padding: const EdgeInsets.all(NexaSpace.xl), children: [
              Center(
                child: Container(
                  padding: const EdgeInsets.all(NexaSpace.lg),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(NexaRadius.lg)),
                  child: QrImageView(
                    key: const Key('my-qr'),
                    data: mine['qr'] as String,
                    size: 220,
                    backgroundColor: Colors.white,
                    eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: Color(0xFF14213D)),
                    dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: Color(0xFF14213D)),
                    semanticsLabel: 'Your SuperApp QR code',
                  ),
                ),
              ),
              const SizedBox(height: NexaSpace.lg),
              if (me != null) Text(me.displayName, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: NexaSpace.sm),
              const Text('Let people scan this in SuperApp to start a chat with you. Your phone number stays private.', textAlign: TextAlign.center),
              const SizedBox(height: NexaSpace.sm),
              Text('${code.substring(0, 5)}-${code.substring(5)}', key: const Key('my-code'), textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium?.copyWith(letterSpacing: 2)),
              const SizedBox(height: NexaSpace.xl),
              // Computers have no camera scanner here; typing the code works everywhere.
              if (!isDesktopPlatform)
              FilledButton.icon(
                key: const Key('scan-contact'),
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('Scan someone’s code'),
                onPressed: _busy ? null : () async => _open(await widget.scan(context)),
              ),
              const SizedBox(height: NexaSpace.sm),
              OutlinedButton(key: const Key('type-contact-code'), onPressed: _busy ? null : _typeCode, child: const Text('Type a code instead')),
              const SizedBox(height: NexaSpace.sm),
              TextButton(key: const Key('reset-code'), onPressed: _busy ? null : _reset, child: const Text('Reset my code')),
            ]);
          },
        ),
      );
}
