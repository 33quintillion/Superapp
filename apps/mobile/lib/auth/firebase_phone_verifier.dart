import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';

import 'phone_verifier.dart';

/// Sends and checks SMS codes through Firebase Auth. The Firebase settings come from
/// --dart-define at build time (they are public, like the website's); without them the app
/// offers email sign-in only.
class FirebasePhoneVerifier implements PhoneVerifier {
  FirebasePhoneVerifier._(this._auth);
  final FirebaseAuth _auth;

  static Future<PhoneVerifier> fromEnvironment() async {
    const apiKey = String.fromEnvironment('FIREBASE_API_KEY');
    const appId = String.fromEnvironment('FIREBASE_APP_ID');
    const senderId = String.fromEnvironment('FIREBASE_SENDER_ID');
    const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
    if (apiKey.isEmpty || appId.isEmpty || projectId.isEmpty) return const UnavailablePhoneVerifier();
    try {
      final app = await Firebase.initializeApp(options: const FirebaseOptions(apiKey: apiKey, appId: appId, messagingSenderId: senderId, projectId: projectId));
      return FirebasePhoneVerifier._(FirebaseAuth.instanceFor(app: app));
    } catch (_) {
      return const UnavailablePhoneVerifier();
    }
  }

  @override
  bool get available => true;

  @override
  Future<String> sendCode(String phoneE164) {
    final done = Completer<String>();
    _auth.verifyPhoneNumber(
      phoneNumber: phoneE164,
      timeout: const Duration(seconds: 60),
      // Android can read the SMS itself; the person still sees and confirms the code.
      verificationCompleted: (_) {},
      verificationFailed: (e) {
        if (!done.isCompleted) done.completeError(PhoneVerificationException(_message(e)));
      },
      codeSent: (verificationId, _) {
        if (!done.isCompleted) done.complete(verificationId);
      },
      codeAutoRetrievalTimeout: (_) {},
    );
    return done.future;
  }

  @override
  Future<String> confirm(String handle, String code) async {
    try {
      final result = await _auth.signInWithCredential(PhoneAuthProvider.credential(verificationId: handle, smsCode: code));
      final token = await result.user!.getIdToken(true);
      // SuperApp keeps its own session; the Firebase one was only the proof of the number.
      await _auth.signOut();
      if (token == null) throw PhoneVerificationException('Something went wrong. Try again.');
      return token;
    } on FirebaseAuthException catch (e) {
      throw PhoneVerificationException(_message(e));
    }
  }

  static String _message(FirebaseAuthException e) => switch (e.code) {
        'invalid-phone-number' => 'That phone number doesn’t look right.',
        'invalid-verification-code' => 'That code is wrong. Check the text message and try again.',
        'session-expired' || 'code-expired' => 'That code has expired. Ask for a new one.',
        'too-many-requests' => 'Too many attempts. Wait a while and try again.',
        'quota-exceeded' => 'We can’t send codes right now. Try again later.',
        'network-request-failed' => 'Couldn’t reach the server. Check your connection.',
        _ => 'Something went wrong. Try again.',
      };
}
