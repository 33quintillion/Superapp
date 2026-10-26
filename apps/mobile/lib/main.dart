import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'auth/auth_controller.dart';
import 'auth/session_store.dart';
import 'screens/auth_screens.dart';
import 'theme/theme.dart';

void main() {
  final auth = AuthController(ApiClient(), const SecureSessionStore())..restore();
  runApp(NexaApp(auth: auth));
}

class NexaApp extends StatelessWidget {
  const NexaApp({super.key, required this.auth});
  final AuthController auth;

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
            AuthStatus.signedIn => HomeScreen(auth: auth),
          },
        ),
      );
}
