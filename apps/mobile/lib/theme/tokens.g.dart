// Generated from packages/design-tokens/tokens.json. Do not edit by hand.
// ignore_for_file: public_member_api_docs
import 'package:flutter/painting.dart';

class NexaPalette {
  const NexaPalette({
    required this.bg,
    required this.surface,
    required this.surfaceMuted,
    required this.text,
    required this.textMuted,
    required this.border,
    required this.primary,
    required this.onPrimary,
    required this.link,
    required this.accent,
    required this.danger,
    required this.warning,
    required this.bubbleOwn,
    required this.onBubbleOwn,
    required this.bubbleOther,
    required this.onBubbleOther,
  });
  final Color bg;
  final Color surface;
  final Color surfaceMuted;
  final Color text;
  final Color textMuted;
  final Color border;
  final Color primary;
  final Color onPrimary;
  final Color link;
  final Color accent;
  final Color danger;
  final Color warning;
  final Color bubbleOwn;
  final Color onBubbleOwn;
  final Color bubbleOther;
  final Color onBubbleOther;
}

class NexaColors {
  static const light = NexaPalette(
    bg: Color(0xFFFAF6EC),
    surface: Color(0xFFFFFDF7),
    surfaceMuted: Color(0xFFF2EBDB),
    text: Color(0xFF14213D),
    textMuted: Color(0xFF5B6478),
    border: Color(0xFFE4D9C3),
    primary: Color(0xFF14213D),
    onPrimary: Color(0xFFFAF6EC),
    link: Color(0xFF8E1F43),
    accent: Color(0xFFE3B448),
    danger: Color(0xFFC1121F),
    warning: Color(0xFFA85F00),
    bubbleOwn: Color(0xFF7B1E3A),
    onBubbleOwn: Color(0xFFFDF8EE),
    bubbleOther: Color(0xFFF2EBDB),
    onBubbleOther: Color(0xFF14213D),
  );
  static const dark = NexaPalette(
    bg: Color(0xFF0B1426),
    surface: Color(0xFF111D35),
    surfaceMuted: Color(0xFF1A2846),
    text: Color(0xFFF6F0E1),
    textMuted: Color(0xFFAEB6C8),
    border: Color(0xFF263555),
    primary: Color(0xFFE3B448),
    onPrimary: Color(0xFF0B1426),
    link: Color(0xFFEBC567),
    accent: Color(0xFFE3B448),
    danger: Color(0xFFFF5A68),
    warning: Color(0xFFF0A23B),
    bubbleOwn: Color(0xFF7B1E3A),
    onBubbleOwn: Color(0xFFFDF8EE),
    bubbleOther: Color(0xFF1A2846),
    onBubbleOther: Color(0xFFF6F0E1),
  );
}

class NexaSpace {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

class NexaRadius {
  static const double sm = 6;
  static const double md = 10;
  static const double lg = 16;
  static const double pill = 999;
}

class NexaFontSize {
  static const double caption = 12;
  static const double body = 15;
  static const double title = 18;
  static const double headline = 24;
  static const double display = 32;
}
