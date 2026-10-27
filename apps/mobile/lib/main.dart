import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'auth/auth_controller.dart';
import 'auth/session_store.dart';
import 'calls/call_engine.dart';
import 'chat/realtime.dart';
import 'screens/auth_screens.dart';
import 'theme/theme.dart';

void main() {
  final auth = AuthController(ApiClient(), const SecureSessionStore())..restore();
  runApp(NexaApp(auth: auth));
}

class NexaApp extends StatelessWidget {
  const NexaApp({super.key, required this.auth, this.connectSocket, this.callEngine});
  final AuthController auth;
  /// Tests swap in an in-memory socket; the app uses a real WebSocket.
  final SocketFactory? connectSocket;
  /// Tests swap in fake call media; the app uses WebRTC.
  final CallEngine Function()? callEngine;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Nexa',
        theme: nexaTheme(Brightness.light),
        darkTheme: nexaTheme(Brightness.dark),
        home: ListenableBuilder(
          listenable: auth,
          builder: (context, _) => switch (auth.status) {
            AuthStatus.unknown => const Scaffold(body: Center(child: CircularProgressIndicator())),
            AuthStatus.signedOut => SignInScreen(auth: auth),
            AuthStatus.mfaRequired => MfaScreen(auth: auth),
            AuthStatus.signedIn => HomeScreen(auth: auth, connectSocket: connectSocket, callEngine: callEngine),
          },
        ),
      );
}
