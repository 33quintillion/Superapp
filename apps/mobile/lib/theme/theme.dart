import 'package:flutter/material.dart';

import 'tokens.g.dart';

ThemeData nexaTheme(Brightness brightness) {
  final p = brightness == Brightness.dark ? NexaColors.dark : NexaColors.light;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: p.primary,
    onPrimary: p.onPrimary,
    secondary: p.accent,
    onSecondary: p.onPrimary,
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
