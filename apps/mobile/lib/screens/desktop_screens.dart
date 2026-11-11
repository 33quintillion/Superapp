import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../chat/chat_controller.dart';
import '../theme/tokens.g.dart';
import 'auth_screens.dart';
import 'call_screens.dart';
import 'chat_screens.dart';
import 'mini_screens.dart';
import 'qr_screens.dart';

/// Windows, Mac and Linux: the computer app signs in by QR code from the phone, and lays out
/// chats side by side, like WhatsApp for Windows.
bool get isDesktopPlatform =>
    !kIsWeb && (defaultTargetPlatform == TargetPlatform.windows || defaultTargetPlatform == TargetPlatform.macOS || defaultTargetPlatform == TargetPlatform.linux);

/// What the computer's QR code holds; the phone app looks for this before the code.
const _linkPrefix = 'SUPERAPP-LINK:';

/// Sign in on a computer: a QR code to scan with SuperApp on the phone (Linked devices),
/// replaced as it runs out, with the code to type as a fallback and email sign-in below.
class DesktopLinkScreen extends StatefulWidget {
  const DesktopLinkScreen({super.key, required this.auth, this.pollEvery = const Duration(seconds: 3)});
  final AuthController auth;
  final Duration pollEvery;
  @override
  State<DesktopLinkScreen> createState() => _DesktopLinkScreenState();
}

class _DesktopLinkScreenState extends State<DesktopLinkScreen> {
  ({String code, String secret, int expiresIn})? _link;
  String? _error;
  bool _stale = false;
  int _refreshes = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _fresh();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _fresh() async {
    _timer?.cancel();
    setState(() {
      _link = null;
      _error = null;
      _stale = false;
    });
    try {
      final l = await widget.auth.startDeviceLink();
      if (!mounted) return;
      setState(() => _link = l);
      _timer = Timer.periodic(widget.pollEvery, (_) => _poll());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.status >= 500 || e.status == 0 ? 'SuperApp is starting up. Try again in a moment.' : e.message);
    } on Exception {
      if (mounted) setState(() => _error = 'Couldn’t reach SuperApp. Check your internet connection.');
    }
  }

  bool _polling = false;
  Future<void> _poll() async {
    final l = _link;
    if (l == null || _polling) return;
    _polling = true;
    try {
      if (await widget.auth.collectDeviceLink(l.code, l.secret)) _timer?.cancel();
    } on ApiException catch (e) {
      if (e.status == 400 || e.status == 401 || e.status == 404) {
        // Ran out unscanned: a new code, a few times, then wait for a click.
        _timer?.cancel();
        if (_refreshes++ < 4) {
          unawaited(_fresh());
        } else if (mounted) {
          setState(() => _stale = true);
        }
      }
      // Anything else (the server briefly away): keep asking.
    } on Exception {
      // Offline for a moment: keep asking.
    } finally {
      _polling = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final l = _link;
    Widget qr;
    if (_error != null || _stale) {
      qr = TextButton(
        key: const Key('desktop-link-retry'),
        onPressed: () {
          _refreshes = 0;
          _fresh();
        },
        child: Text('${_error ?? 'This code ran out.'} Click to get a new one.', textAlign: TextAlign.center),
      );
    } else if (l == null) {
      qr = const CircularProgressIndicator();
    } else {
      qr = QrImageView(
        key: const Key('desktop-link-qr'),
        data: '$_linkPrefix${l.code}',
        size: 264,
        backgroundColor: Colors.white,
        eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: Color(0xFF14213D)),
        dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: Color(0xFF14213D)),
        semanticsLabel: 'QR code to sign in this computer',
      );
    }
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(NexaSpace.xl),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 940),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(48),
                child: Wrap(spacing: 56, runSpacing: 32, crossAxisAlignment: WrapCrossAlignment.center, children: [
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 420),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Use SuperApp on your computer', style: text.headlineMedium),
                      const SizedBox(height: NexaSpace.xl),
                      for (final (i, s) in const ['Open SuperApp on your phone.', 'Tap Linked devices, then Scan the code.', 'Point your phone at this screen.'].indexed)
                        Padding(
                          padding: const EdgeInsets.only(bottom: NexaSpace.lg),
                          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            CircleAvatar(radius: 14, child: Text('${i + 1}', style: const TextStyle(fontSize: 13))),
                            const SizedBox(width: NexaSpace.md),
                            Expanded(child: Text(s, style: text.titleMedium)),
                          ]),
                        ),
                      const SizedBox(height: NexaSpace.md),
                      TextButton(
                        key: const Key('desktop-email-sign-in'),
                        onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => SignInScreen(auth: widget.auth))),
                        child: const Text('Signed up with email? Sign in with email'),
                      ),
                    ]),
                  ),
                  Column(mainAxisSize: MainAxisSize.min, children: [
                    Container(
                      width: 296,
                      height: 296,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), border: Border.all(color: Theme.of(context).dividerColor)),
                      child: Padding(padding: const EdgeInsets.all(NexaSpace.md), child: qr),
                    ),
                    const SizedBox(height: NexaSpace.md),
                    if (l != null && _error == null && !_stale)
                      Text('Can’t scan? On your phone, type ${l.code.substring(0, 4)}-${l.code.substring(4)}', key: const Key('desktop-link-code'), style: text.bodyMedium),
                  ]),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The signed-in computer app: a rail on the left, the chat list beside the open chat.
class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key, required this.auth, required this.chat, required this.settings});
  final AuthController auth;
  final ChatController chat;
  /// Profile, linked devices, businesses and the rest: the phone's home list.
  final Widget settings;
  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  int _tab = 0;
  String? _openChat;

  @override
  Widget build(BuildContext context) {
    final chat = widget.chat;
    final Widget body = switch (_tab) {
      0 => Row(children: [
          SizedBox(
            width: 360,
            child: ChatListScreen(chat: chat, selectedId: _openChat, onOpen: (id) => setState(() => _openChat = id)),
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: _openChat == null
                ? Center(
                    key: const Key('desktop-no-chat'),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.forum_outlined, size: 64, color: Theme.of(context).colorScheme.primary),
                      const SizedBox(height: NexaSpace.md),
                      Text('SuperApp for ${defaultTargetPlatform == TargetPlatform.macOS ? 'Mac' : 'Windows'}', style: Theme.of(context).textTheme.headlineSmall),
                      const SizedBox(height: NexaSpace.sm),
                      const Text('Pick a chat on the left. Messages also stay on your phone.'),
                    ]),
                  )
                : ChatScreen(key: ValueKey(_openChat), chat: chat, conversationId: _openChat!),
          ),
        ]),
      1 => CallHistoryScreen(chat: chat),
      2 => MiniProgramsScreen(auth: widget.auth),
      3 => MyQrScreen(chat: chat),
      _ => widget.settings,
    };
    return Scaffold(
      body: Row(children: [
        ListenableBuilder(
          listenable: chat,
          builder: (context, _) {
            final unread = chat.conversations.fold<int>(0, (n, c) => n + c.unreadCount);
            return NavigationRail(
              key: const Key('desktop-rail'),
              selectedIndex: _tab,
              onDestinationSelected: (i) => setState(() => _tab = i),
              labelType: NavigationRailLabelType.all,
              leading: Padding(
                padding: const EdgeInsets.symmetric(vertical: NexaSpace.md),
                child: Text('SuperApp', style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.primary)),
              ),
              destinations: [
                NavigationRailDestination(
                  icon: unread > 0 ? Badge(label: Text('$unread'), child: const Icon(Icons.chat_bubble_outline)) : const Icon(Icons.chat_bubble_outline),
                  selectedIcon: const Icon(Icons.chat_bubble),
                  label: const Text('Chats'),
                ),
                const NavigationRailDestination(icon: Icon(Icons.call_outlined), selectedIcon: Icon(Icons.call), label: Text('Calls')),
                const NavigationRailDestination(icon: Icon(Icons.apps_outlined), selectedIcon: Icon(Icons.apps), label: Text('Mini-programs')),
                const NavigationRailDestination(icon: Icon(Icons.qr_code_2), label: Text('My QR code')),
                const NavigationRailDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: Text('More')),
              ],
            );
          },
        ),
        const VerticalDivider(width: 1),
        Expanded(child: body),
      ]),
    );
  }
}
