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
    bg: Color(0xFFF7F8FA),
    surface: Color(0xFFFFFFFF),
    surfaceMuted: Color(0xFFEEF1F5),
    text: Color(0xFF14181F),
    textMuted: Color(0xFF5A6372),
    border: Color(0xFFDDE2EA),
    primary: Color(0xFF3B5BDB),
    onPrimary: Color(0xFFFFFFFF),
    accent: Color(0xFF0CA678),
    danger: Color(0xFFC2255C),
    warning: Color(0xFFE8590C),
    bubbleOwn: Color(0xFF3B5BDB),
    onBubbleOwn: Color(0xFFFFFFFF),
    bubbleOther: Color(0xFFEEF1F5),
    onBubbleOther: Color(0xFF14181F),
  );
  static const dark = NexaPalette(
    bg: Color(0xFF0E1116),
    surface: Color(0xFF161A21),
    surfaceMuted: Color(0xFF1F242D),
    text: Color(0xFFE8ECF2),
    textMuted: Color(0xFF9AA4B2),
    border: Color(0xFF2A303B),
    primary: Color(0xFF748FFC),
    onPrimary: Color(0xFF0E1116),
    accent: Color(0xFF38D9A9),
    danger: Color(0xFFF06595),
    warning: Color(0xFFFF922B),
    bubbleOwn: Color(0xFF3B5BDB),
    onBubbleOwn: Color(0xFFFFFFFF),
    bubbleOther: Color(0xFF1F242D),
    onBubbleOther: Color(0xFFE8ECF2),
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
