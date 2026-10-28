import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'auth/auth_controller.dart';
import 'auth/session_store.dart';
import 'calls/call_engine.dart';
import 'chat/outbox_store.dart';
import 'chat/realtime.dart';
import 'screens/auth_screens.dart';
import 'theme/theme.dart';

void main() {
  final auth = AuthController(ApiClient(), const SecureSessionStore())..restore();
  runApp(NexaApp(auth: auth, outbox: const SecureOutboxStore()));
}

class NexaApp extends StatelessWidget {
  const NexaApp({super.key, required this.auth, this.connectSocket, this.callEngine, this.outbox, this.themeMode = ThemeMode.system});
  final AuthController auth;
  /// Tests swap in an in-memory socket; the app uses a real WebSocket.
  final SocketFactory? connectSocket;
  /// Tests swap in fake call media; the app uses WebRTC.
  final CallEngine Function()? callEngine;
  /// Where unsent messages are kept; the app uses the keystore, tests keep them in memory.
  final OutboxStore? outbox;
  /// Follows the phone's light or dark setting; tests pin one.
  final ThemeMode themeMode;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Nexa',
        theme: nexaTheme(Brightness.light),
        darkTheme: nexaTheme(Brightness.dark),
        themeMode: themeMode,
        home: ListenableBuilder(
          listenable: auth,
          builder: (context, _) => switch (auth.status) {
            AuthStatus.unknown => const Scaffold(body: Center(child: CircularProgressIndicator())),
            AuthStatus.signedOut => SignInScreen(auth: auth),
            AuthStatus.mfaRequired => MfaScreen(auth: auth),
            AuthStatus.signedIn => HomeScreen(auth: auth, connectSocket: connectSocket, callEngine: callEngine, outbox: outbox),
          },
        ),
      );
}
