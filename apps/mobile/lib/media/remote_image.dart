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

/// A round profile photo, or the first letter of the name when there isn't one (or it
/// can't be loaded).
class Avatar extends StatefulWidget {
  const Avatar({super.key, required this.auth, required this.mediaId, required this.name, this.radius = 20});
  final AuthController auth;
  final String? mediaId;
  final String name;
  final double radius;

  @override
  State<Avatar> createState() => _AvatarState();
}

class _AvatarState extends State<Avatar> {
  String? _url;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(Avatar old) {
    super.didUpdateWidget(old);
    if (old.mediaId != widget.mediaId) _load();
  }

  void _load() {
    _url = null;
    final id = widget.mediaId;
    if (id == null) return;
    widget.auth.authed('GET', '/v1/media/$id').then((r) {
      if (mounted && widget.mediaId == id) setState(() => _url = r?['url'] as String?);
    }).catchError((Object _) => null);
  }

  @override
  Widget build(BuildContext context) {
    final letter = CircleAvatar(radius: widget.radius, child: Text(widget.name.isEmpty ? '?' : widget.name.characters.first.toUpperCase()));
    if (_url == null) return letter;
    final size = widget.radius * 2;
    return ClipOval(
      child: Image.network(
        _url!,
        key: Key('avatar-${widget.mediaId}'),
        width: size,
        height: size,
        fit: BoxFit.cover,
        semanticLabel: 'Profile photo of ${widget.name}',
        errorBuilder: (_, _, _) => letter,
      ),
    );
  }
}
