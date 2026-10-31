import 'package:flutter/material.dart';

import 'tokens.g.dart';

ThemeData nexaTheme(Brightness brightness) {
  final p = brightness == Brightness.dark ? NexaColors.dark : NexaColors.light;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: p.primary,
    onPrimary: p.onPrimary,
    secondary: p.accent,
    // Navy text on the gold accent in both modes: ivory on it would be too faint.
    onSecondary: brightness == Brightness.dark ? p.onPrimary : p.text,
    // Selected segments and tonal buttons; left to Material they come out gold with ivory text.
    secondaryContainer: p.surfaceMuted,
    onSecondaryContainer: p.text,
    error: p.danger,
    onError: p.onPrimary,
    surface: p.surface,
    onSurface: p.text,
  );
  final radius = BorderRadius.circular(NexaRadius.md);
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: p.bg,
    useMaterial3: true,
    // Midnight navy with ivory text in both themes, as on the web: the brand's one constant.
    appBarTheme: const AppBarTheme(
      backgroundColor: Color(0xFF14213D),
      foregroundColor: Color(0xFFF6F0E1),
      surfaceTintColor: Colors.transparent,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.surfaceMuted,
      border: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide.none),
      contentPadding: const EdgeInsets.symmetric(horizontal: NexaSpace.lg, vertical: NexaSpace.md),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
  );
}
