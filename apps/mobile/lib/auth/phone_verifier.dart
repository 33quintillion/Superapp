/// Sends and checks the SMS codes for phone sign-in. The app uses Firebase Auth once the
/// Firebase project is set up; tests use a fake. Either way the result is a Firebase ID
/// token, which the API checks before it signs anyone in.
abstract class PhoneVerifier {
  /// False in builds without Firebase, which then offer email sign-in only.
  bool get available;

  /// Texts a code to [phoneE164] and returns a handle for [confirm].
  Future<String> sendCode(String phoneE164);

  /// Checks [code] and returns the ID token proving the number.
  Future<String> confirm(String handle, String code);
}

/// A message safe to show as is ("That code is wrong…").
class PhoneVerificationException implements Exception {
  PhoneVerificationException(this.message);
  final String message;

  @override
  String toString() => message;
}

class UnavailablePhoneVerifier implements PhoneVerifier {
  const UnavailablePhoneVerifier();

  @override
  bool get available => false;

  @override
  Future<String> sendCode(String phoneE164) => throw PhoneVerificationException('Phone sign-in isn’t set up in this version of the app.');

  @override
  Future<String> confirm(String handle, String code) => throw PhoneVerificationException('Phone sign-in isn’t set up in this version of the app.');
}

/// Turns what people type (spaces, a leading 0, no country code) into E.164.
String toE164(String input, {String countryCode = '+91'}) {
  final raw = input.replaceAll(RegExp(r'[\s\-().]'), '');
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return '+${raw.substring(2)}';
  return '$countryCode${raw.replaceFirst(RegExp(r'^0+'), '')}';
}

final _e164 = RegExp(r'^\+[1-9][0-9]{6,14}$');
bool isE164(String s) => _e164.hasMatch(s);
