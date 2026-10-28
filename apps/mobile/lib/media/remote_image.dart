import 'package:flutter/material.dart';

import '../auth/auth_controller.dart';
import '../theme/tokens.g.dart';

/// A stored photo: asks the API for a short-lived link (which also checks that this person
/// may see it), then shows it.
class RemoteImage extends StatefulWidget {
  const RemoteImage({super.key, required this.auth, required this.mediaId, this.height = 220, this.fit = BoxFit.cover, this.semanticLabel = 'Photo'});
  final AuthController auth;
  final String mediaId;
  final double height;
  final BoxFit fit;
  final String semanticLabel;

  @override
  State<RemoteImage> createState() => _RemoteImageState();
}

class _RemoteImageState extends State<RemoteImage> {
  String? _url;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    widget.auth.authed('GET', '/v1/media/${widget.mediaId}').then((r) {
      if (mounted) setState(() => _url = r?['url'] as String?);
    }).catchError((Object _) {
      if (mounted) setState(() => _failed = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.surfaceContainerHighest;
    Widget box(Widget child) => SizedBox(height: widget.height, child: ColoredBox(color: muted, child: Center(child: child)));
    if (_failed) return box(const Text('Photo not available'));
    if (_url == null) return box(const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)));
    return ClipRRect(
      borderRadius: BorderRadius.circular(NexaRadius.md),
      child: Image.network(
        _url!,
        key: Key('image-${widget.mediaId}'),
        height: widget.height,
        width: double.infinity,
        fit: widget.fit,
        semanticLabel: widget.semanticLabel,
        errorBuilder: (_, _, _) => box(const Text('Photo not available')),
      ),
    );
  }
}
