import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../auth/phone_verifier.dart';
import '../calls/call_controller.dart';
import '../calls/call_engine.dart';
import '../chat/chat_controller.dart';
import '../chat/outbox_store.dart';
import '../chat/realtime.dart';
import '../media/media.dart';
import '../media/remote_image.dart';
import '../theme/tokens.g.dart';
import 'business_screens.dart';
import 'call_screens.dart';
import 'chat_screens.dart';
import 'social_screens.dart';

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
    } on PhoneVerificationException catch (e) {
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

/// Phone sign-in and sign-up in one: a code is texted to the number, and the confirmed
/// number either signs in or, if it's new, goes on to pick a name.
class PhoneSignInScreen extends StatefulWidget {
  const PhoneSignInScreen({super.key, required this.auth});
  final AuthController auth;
  @override
  State<PhoneSignInScreen> createState() => _PhoneSignInScreenState();
}

class _PhoneSignInScreenState extends State<PhoneSignInScreen> with _Submitting {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  String? _handle;
  String _number = '';

  Future<void> _send() async {
    final number = toE164(_phone.text);
    if (!isE164(number)) throw PhoneVerificationException('That phone number doesn’t look right.');
    final handle = await widget.auth.phone.sendCode(number);
    if (!mounted) return;
    setState(() {
      _number = number;
      _handle = handle;
      _code.clear();
    });
  }

  Future<void> _confirm() async {
    final idToken = await widget.auth.phone.confirm(_handle!, _code.text.trim());
    await widget.auth.phoneSignIn(idToken);
  }

  @override
  Widget build(BuildContext context) => _FormPage(
        title: 'Welcome to Nexa',
        children: _handle == null
            ? [
                const Text('Enter your phone number. We’ll text you a code to sign in, or to set up your account if you’re new.'),
                const SizedBox(height: NexaSpace.md),
                TextField(
                  key: const Key('phone'),
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  autofillHints: const [AutofillHints.telephoneNumber],
                  decoration: const InputDecoration(labelText: 'Phone number', prefixText: '+91 ', helperText: 'Other countries: start with + and the country code'),
                ),
                const SizedBox(height: NexaSpace.lg),
                errorText(context),
                FilledButton(key: const Key('send-code'), onPressed: busy ? null : () => run(_send), child: Text(busy ? 'Sending…' : 'Send code')),
                TextButton(
                  key: const Key('email-sign-in'),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => SignInScreen(auth: widget.auth))),
                  child: const Text('Signed up with email before? Sign in with email'),
                ),
              ]
            : [
                Text('Enter the 6-digit code we sent to $_number.'),
                const SizedBox(height: NexaSpace.md),
                TextField(
                  key: const Key('sms-code'),
                  controller: _code,
                  keyboardType: TextInputType.number,
                  autofillHints: const [AutofillHints.oneTimeCode],
                  maxLength: 6,
                  decoration: const InputDecoration(labelText: 'Code'),
                ),
                errorText(context),
                FilledButton(key: const Key('verify-code'), onPressed: busy ? null : () => run(_confirm), child: Text(busy ? 'Checking…' : 'Continue')),
                TextButton(onPressed: busy ? null : () => run(_send), child: const Text('Send a new code')),
                TextButton(key: const Key('change-number'), onPressed: busy ? null : () => setState(() => _handle = null), child: const Text('Change number')),
              ],
      );
}

/// A new phone number's account: a name, and optionally a username.
class NameScreen extends StatefulWidget {
  const NameScreen({super.key, required this.auth});
  final AuthController auth;
  @override
  State<NameScreen> createState() => _NameScreenState();
}

class _NameScreenState extends State<NameScreen> with _Submitting {
  final _name = TextEditingController();
  final _username = TextEditingController();

  @override
  Widget build(BuildContext context) => _FormPage(title: 'Create your account', children: [
        Text('${widget.auth.signupPhone ?? 'Your number'} is confirmed. What should people call you?'),
        const SizedBox(height: NexaSpace.md),
        TextField(key: const Key('display-name-field'), controller: _name, autofillHints: const [AutofillHints.name], decoration: const InputDecoration(labelText: 'Your name')),
        const SizedBox(height: NexaSpace.md),
        TextField(
          key: const Key('username-field'),
          controller: _username,
          decoration: const InputDecoration(labelText: 'Username (optional)', helperText: 'Lets people find you without your number'),
        ),
        const SizedBox(height: NexaSpace.lg),
        errorText(context),
        FilledButton(
          key: const Key('create-account'),
          onPressed: busy ? null : () => run(() => widget.auth.completePhoneSignUp(displayName: _name.text.trim(), username: _username.text.trim())),
          child: Text(busy ? 'Creating…' : 'Create account'),
        ),
        TextButton(onPressed: busy ? null : widget.auth.cancelPhoneSignUp, child: const Text('Use a different number')),
      ]);
}

/// The optional email: for receipts and banking, and needed before a business takes payouts.
class EmailScreen extends StatefulWidget {
  const EmailScreen({super.key, required this.auth});
  final AuthController auth;
  @override
  State<EmailScreen> createState() => _EmailScreenState();
}

class _EmailScreenState extends State<EmailScreen> with _Submitting {
  late final _email = TextEditingController(text: widget.auth.profile?.email ?? '');
  bool _sent = false;

  @override
  Widget build(BuildContext context) {
    final p = widget.auth.profile;
    return Scaffold(
      appBar: AppBar(title: const Text('Email')),
      body: ListView(padding: const EdgeInsets.all(NexaSpace.lg), children: [
        const Text('For receipts and banking. A business needs a confirmed email to receive payouts. You still sign in with your phone number.'),
        const SizedBox(height: NexaSpace.md),
        if (p != null && p.email.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: NexaSpace.md),
            child: Text(p.emailVerified ? '${p.email} is confirmed.' : '${p.email} isn’t confirmed yet. Check your inbox for the link.', key: const Key('email-status')),
          ),
        TextField(key: const Key('email-field'), controller: _email, keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.email], decoration: const InputDecoration(labelText: 'Email')),
        const SizedBox(height: NexaSpace.lg),
        errorText(context),
        if (_sent) const Padding(padding: EdgeInsets.only(bottom: NexaSpace.md), child: Text('We sent a confirmation link. Open it to confirm your email.', key: Key('email-sent'))),
        FilledButton(
          key: const Key('save-email'),
          onPressed: busy
              ? null
              : () => run(() async {
                    await widget.auth.setEmail(_email.text.trim());
                    if (mounted) setState(() => _sent = true);
                  }),
          child: Text(busy ? 'Saving…' : 'Save and send link'),
        ),
        if (p != null && p.email.isNotEmpty)
          TextButton(
            key: const Key('remove-email'),
            onPressed: busy
                ? null
                : () => run(() async {
                      await widget.auth.removeEmail();
                      if (mounted) {
                        _email.clear();
                        setState(() => _sent = false);
                      }
                    }),
            child: const Text('Remove email'),
          ),
      ]),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, this.connectSocket, this.callEngine, this.outbox});
  final AuthController auth;
  final SocketFactory? connectSocket;
  final CallEngine Function()? callEngine;
  final OutboxStore? outbox;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final ChatController chat = ChatController(auth: widget.auth, wsBase: wsBaseFor(widget.auth.api.baseUrl), connect: widget.connectSocket, outbox: widget.outbox);
  late final CallController calls;

  @override
  void initState() {
    super.initState();
    // Before the socket opens, so it hears calls from the first connection on.
    calls = CallController(chat: chat, engine: widget.callEngine);
    unawaited(chat.start().catchError((_) {}));
  }

  @override
  void dispose() {
    calls.dispose();
    chat.dispose();
    super.dispose();
  }

  Future<void> _editPhoto(BuildContext context) async {
    final auth = widget.auth;
    final messenger = ScaffoldMessenger.of(context);
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(key: const Key('photo-choose'), leading: const Icon(Icons.photo_library_outlined), title: const Text('Choose a photo'), onTap: () => Navigator.pop(context, 'choose')),
          if (auth.profile?.avatarMediaId != null)
            ListTile(key: const Key('photo-remove'), leading: const Icon(Icons.delete_outline), title: const Text('Remove photo'), onTap: () => Navigator.pop(context, 'remove')),
        ]),
      ),
    );
    if (choice == null) return;
    try {
      if (choice == 'remove') {
        await auth.setAvatar(null);
      } else {
        final picked = await MediaDevices.instance.pickPhotos();
        if (picked.isEmpty) return;
        final media = await uploadMedia(auth, picked.single, kind: 'image');
        await auth.setAvatar(media['id'] as String);
      }
    } on Exception catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(uploadError(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = widget.auth;
    final p = auth.profile!;
    return CallOverlayHost(
      calls: calls,
      child: Scaffold(
        appBar: AppBar(title: const Text('Nexa'), actions: [
          IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: auth.signOut),
        ]),
        body: ListView(padding: const EdgeInsets.all(NexaSpace.lg), children: [
          ListenableBuilder(
            listenable: auth,
            builder: (context, _) {
              final p = auth.profile;
              if (p == null) return const SizedBox.shrink();
              return ListTile(
                leading: Avatar(auth: auth, mediaId: p.avatarMediaId, name: p.displayName),
                title: Text(p.displayName, key: const Key('display-name')),
                subtitle: Text(p.username.isNotEmpty ? '@${p.username}' : (p.phone ?? '')),
                trailing: IconButton(key: const Key('edit-photo'), tooltip: 'Profile photo', icon: const Icon(Icons.photo_camera_outlined), onPressed: () => _editPhoto(context)),
              );
            },
          ),
          if (p.email.isNotEmpty && !p.emailVerified)
            const ListTile(leading: Icon(Icons.mark_email_unread_outlined), title: Text('Check your inbox to confirm your email address.')),
          if (p.phone != null)
            ListTile(
              key: const Key('open-email'),
              leading: const Icon(Icons.alternate_email),
              title: Text(p.email.isEmpty ? 'Add an email' : 'Email'),
              subtitle: Text(p.email.isEmpty ? 'For receipts, banking and payouts' : p.email),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => EmailScreen(auth: auth))),
            ),
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
          ListTile(
            key: const Key('open-feed'),
            leading: const Icon(Icons.dynamic_feed_outlined),
            title: const Text('Feed and stories'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => FeedScreen(auth: auth))),
          ),
          ListTile(
            key: const Key('open-find-people'),
            leading: const Icon(Icons.person_search_outlined),
            title: const Text('Find people you know'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => FindPeopleScreen(auth: auth))),
          ),
          ListTile(
            key: const Key('open-communities'),
            leading: const Icon(Icons.groups_outlined),
            title: const Text('Communities'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => CommunitiesScreen(auth: auth))),
          ),
          ListTile(
            key: const Key('open-businesses'),
            leading: const Icon(Icons.storefront_outlined),
            title: const Text('Businesses'),
            subtitle: const Text('Order for pickup and book appointments'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => BusinessesScreen(auth: auth))),
          ),
          ListTile(
            key: const Key('open-calls'),
            leading: const Icon(Icons.call_outlined),
            title: const Text('Calls'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => CallHistoryScreen(chat: chat))),
          ),
        ]),
      ),
    );
  }
}
