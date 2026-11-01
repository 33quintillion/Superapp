import 'package:flutter_test/flutter_test.dart';

/// Flutter's accessibility guidelines on whatever is on screen now: tap targets of at least
/// 48×48 (Android) and 44×44 (iOS), a label on everything tappable, and WCAG text contrast.
Future<void> expectAccessible(WidgetTester tester) async {
  final semantics = tester.ensureSemantics();
  await tester.pump();
  try {
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  } finally {
    semantics.dispose();
  }
}
