# SuperApp mobile (Flutter)

Android and iOS client. Stage 2 covers sign-in, registration, two-step verification, profile and sign-out. The refresh token is kept in the platform keystore.

```bash
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator
flutter analyze && flutter test
```

`lib/theme/tokens.g.dart` is generated from `packages/design-tokens`. Do not edit it by hand.
