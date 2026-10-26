import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../chat/chat_controller.dart';
import '../chat/realtime.dart';
import '../theme/tokens.g.dart';
import 'chat_screens.dart';

/// Shared scaffold for the signed-out forms: one column, max 420 px, scrolls on small screens.
class _FormPage extends StatelessWidget {
  const _FormPage({required this.title, required this.children});
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(NexaSpace.xl),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(title, style: Theme.of(context).textTheme.headlineMedium),
                    const SizedBox(height: NexaSpace.xl),
                    ...children,
                  ],
                ),
              ),
            ),
          ),
        ),
      );
}

mixin _Submitting<T extends StatefulWidget> on State<T> {
  bool busy = false;
  String? error;

  Future<void> run(Future<void> Function() action) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget errorText(BuildContext context) => error == null
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.only(bottom: NexaSpace.md),
          child: Text(error!, key: const Key('form-error'), style: TextStyle(color: Theme.of(context).colorScheme.error)),
        );
}

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.auth});
  final AuthController auth;
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> with _Submitting {
  final _email = TextEditingController();
  final _password = TextEditingController();

  @override
  Widget build(BuildContext context) => _FormPage(title: 'Sign in', children: [
        TextField(key: const Key('email'), controller: _email, keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.email], decoration: const InputDecoration(labelText: 'Email')),
        const SizedBox(height: NexaSpace.md),
        TextField(key: const Key('password'), controller: _password, obscureText: true, autofillHints: const [AutofillHints.password], decoration: const InputDecoration(labelText: 'Password')),
        const SizedBox(height: NexaSpace.lg),
        errorText(context),
        FilledButton(
          key: const Key('submit'),
          onPressed: busy ? null : () => run(() => widget.auth.signIn(_email.text.trim(), _password.text)),
          child: Text(busy ? 'Signing in…' : 'Sign in'),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RegisterScreen(auth: widget.auth))),
          child: const Text('Create an account'),
        ),
      ]);
}

class MfaScreen extends StatefulWidget {
  const MfaScreen({super.key, required this.auth});
  final AuthController auth;
  @override
  State<MfaScreen> createState() => _MfaScreenState();
}

class _MfaScreenState extends State<MfaScreen> with _Submitting {
  final _code = TextEditingController();
  @override
  Widget build(BuildContext context) => _FormPage(title: 'Two-step verification', children: [
        const Text('Enter the 6-digit code from your authenticator app.'),
        const SizedBox(height: NexaSpace.md),
        TextField(key: const Key('code'), controller: _code, keyboardType: TextInputType.number, maxLength: 6, decoration: const InputDecoration(labelText: 'Code')),
        errorText(context),
        FilledButton(onPressed: busy ? null : () => run(() => widget.auth.submitMfa(_code.text.trim())), child: const Text('Verify')),
      ]);
}

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key, required this.auth});
  final AuthController auth;
  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> with _Submitting {
  final _name = TextEditingController();
  final _username = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();

  @override
  Widget build(BuildContext context) => _FormPage(title: 'Create account', children: [
        TextField(controller: _name, decoration: const InputDecoration(labelText: 'Display name')),
        const SizedBox(height: NexaSpace.md),
        TextField(controller: _username, decoration: const InputDecoration(labelText: 'Username', helperText: '3-30 letters, numbers or _')),
        const SizedBox(height: NexaSpace.md),
        TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
        const SizedBox(height: NexaSpace.md),
        TextField(controller: _password, obscureText: true, decoration: const InputDecoration(labelText: 'Password', helperText: 'At least 10 characters')),
        const SizedBox(height: NexaSpace.lg),
        errorText(context),
        FilledButton(
          onPressed: busy
              ? null
              : () => run(() async {
                    await widget.auth.register(email: _email.text.trim(), password: _password.text, username: _username.text.trim(), displayName: _name.text.trim());
                    if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
                  }),
          child: const Text('Create account'),
        ),
      ]);
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, this.connectSocket});
  final AuthController auth;
  final SocketFactory? connectSocket;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final ChatController chat = ChatController(auth: widget.auth, wsBase: wsBaseFor(widget.auth.api.baseUrl), connect: widget.connectSocket);

  @override
  void initState() {
    super.initState();
    unawaited(chat.start().catchError((_) {}));
  }

  @override
  void dispose() {
    chat.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = widget.auth;
    final p = auth.profile!;
    return Scaffold(
      appBar: AppBar(title: const Text('Nexa'), actions: [
        IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: auth.signOut),
      ]),
      body: ListView(padding: const EdgeInsets.all(NexaSpace.lg), children: [
        ListTile(
          leading: CircleAvatar(child: Text(p.displayName.isEmpty ? '?' : p.displayName.characters.first.toUpperCase())),
          title: Text(p.displayName, key: const Key('display-name')),
          subtitle: Text('@${p.username}'),
        ),
        if (!p.emailVerified)
          const ListTile(leading: Icon(Icons.mark_email_unread_outlined), title: Text('Check your inbox to confirm your email address.')),
        const Divider(),
        ListenableBuilder(
          listenable: chat,
          builder: (context, _) {
            final unread = chat.conversations.fold<int>(0, (n, c) => n + c.unreadCount);
            return ListTile(
              key: const Key('open-chats'),
              leading: const Icon(Icons.chat_bubble_outline),
              title: const Text('Chats'),
              subtitle: const Text('Not end-to-end encrypted yet'),
              trailing: unread > 0 ? Badge(label: Text('$unread')) : const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatListScreen(chat: chat))),
            );
          },
        ),
        const ListTile(
          leading: Icon(Icons.construction_outlined),
          title: Text('Calls and the feed arrive in later stages.'),
        ),
      ]),
    );
  }
}
