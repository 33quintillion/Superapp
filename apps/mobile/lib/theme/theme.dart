import 'package:flutter/material.dart';

import 'tokens.g.dart';

ThemeData nexaTheme(Brightness brightness) {
  final p = brightness == Brightness.dark ? NexaColors.dark : NexaColors.light;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: p.primary,
    onPrimary: p.onPrimary,
    secondary: p.accent,
    // Dark text on the green accent in both modes: white on it is only 3.1:1.
    onSecondary: brightness == Brightness.dark ? p.onPrimary : p.text,
    // Selected segments and tonal buttons; left to Material they come out green with white text.
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
