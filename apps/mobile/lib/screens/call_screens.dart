import 'dart:async';

import 'package:flutter/material.dart';

import '../calls/call_controller.dart';
import '../chat/chat_controller.dart';
import '../chat/chat_models.dart';
import '../theme/tokens.g.dart';

/// Voice and video call buttons for a direct chat's app bar.
List<Widget> callActions(BuildContext context, ChatController chat, Conversation c) {
  final calls = chat.calls;
  final peer = c.peer(chat.me);
  if (calls == null || c.isGroup || peer == null) return const [];
  return [
    IconButton(
      key: const Key('voice-call'),
      tooltip: 'Voice call',
      icon: const Icon(Icons.call_outlined),
      onPressed: () => unawaited(calls.start(c.id, peer.userId, video: false)),
    ),
    IconButton(
      key: const Key('video-call'),
      tooltip: 'Video call',
      icon: const Icon(Icons.videocam_outlined),
      onPressed: () => unawaited(calls.start(c.id, peer.userId, video: true)),
    ),
  ];
}

/// Shows the call screen whenever a call starts or rings, wherever the person is in the app.
class CallOverlayHost extends StatefulWidget {
  const CallOverlayHost({super.key, required this.calls, required this.child});
  final CallController calls;
  final Widget child;

  @override
  State<CallOverlayHost> createState() => _CallOverlayHostState();
}

class _CallOverlayHostState extends State<CallOverlayHost> {
  bool _open = false;

  @override
  void initState() {
    super.initState();
    widget.calls.addListener(_changed);
  }

  @override
  void dispose() {
    widget.calls.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (_open || widget.calls.phase == CallPhase.idle || !mounted) return;
    _open = true;
    unawaited(Navigator.of(context, rootNavigator: true)
        .push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => CallScreen(calls: widget.calls)))
        .whenComplete(() => _open = false));
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class CallScreen extends StatefulWidget {
  const CallScreen({super.key, required this.calls});
  final CallController calls;

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  Timer? _tick;
  bool _popped = false;

  CallController get calls => widget.calls;

  @override
  void initState() {
    super.initState();
    calls.addListener(_changed);
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && calls.connectedAt != null) setState(() {});
    });
  }

  @override
  void dispose() {
    calls.removeListener(_changed);
    _tick?.cancel();
    super.dispose();
  }

  void _changed() {
    if (calls.phase == CallPhase.idle && !_popped && mounted) {
      _popped = true;
      Navigator.of(context).pop();
    } else if (mounted) {
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final phase = calls.phase;
    final kind = calls.video ? 'video call' : 'voice call';
    final status = switch (phase) {
      CallPhase.outgoing => 'Ringing…',
      CallPhase.incoming => 'Incoming $kind…',
      CallPhase.connecting => 'Connecting…',
      CallPhase.reconnecting => 'Reconnecting…',
      CallPhase.active => calls.connectedAt == null ? '' : formatDuration(DateTime.now().difference(calls.connectedAt!).inSeconds),
      CallPhase.ended => calls.notice ?? 'Call ended',
      CallPhase.idle => '',
    };
    final engine = calls.engine;
    final showVideo = calls.video && engine != null && phase != CallPhase.incoming && phase != CallPhase.ended;
    return PopScope(
      // Leaving the screen does not end the call; the buttons do.
      canPop: phase == CallPhase.ended || phase == CallPhase.idle,
      child: Scaffold(
        backgroundColor: const Color(0xFF0B0F14),
        body: Stack(fit: StackFit.expand, children: [
          if (showVideo) Positioned.fill(child: KeyedSubtree(key: const Key('remote-video'), child: engine.remoteView())),
          if (showVideo && !calls.cameraOff)
            Positioned(
              right: NexaSpace.lg,
              top: NexaSpace.lg + MediaQuery.paddingOf(context).top,
              width: 110,
              height: 150,
              child: ClipRRect(borderRadius: BorderRadius.circular(NexaRadius.lg), child: KeyedSubtree(key: const Key('local-video'), child: engine.localView())),
            ),
          SafeArea(
            child: Column(children: [
              const SizedBox(height: NexaSpace.xl * 2),
              if (!showVideo)
                CircleAvatar(radius: 56, child: Text(calls.peerName.isEmpty ? '?' : calls.peerName.characters.first.toUpperCase(), style: theme.textTheme.headlineLarge)),
              const SizedBox(height: NexaSpace.md),
              Text(calls.peerName, style: theme.textTheme.headlineSmall?.copyWith(color: Colors.white)),
              const SizedBox(height: NexaSpace.xs),
              Text(status, key: const Key('call-status'), style: theme.textTheme.bodyMedium?.copyWith(color: Colors.white70)),
              if (phase == CallPhase.active && calls.quality != null && calls.quality != CallQuality.good)
                Padding(
                  padding: const EdgeInsets.only(top: NexaSpace.sm),
                  child: Chip(key: const Key('call-quality'), label: Text(calls.quality == CallQuality.bad ? 'Very poor connection' : 'Poor connection')),
                ),
              if (phase == CallPhase.incoming && calls.notice != null)
                Padding(
                  padding: const EdgeInsets.all(NexaSpace.md),
                  child: Text(calls.notice!, key: const Key('call-notice'), textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFFF8A80))),
                ),
              const Spacer(),
              if (phase == CallPhase.incoming)
                Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _RoundButton(key: const Key('decline-call'), icon: Icons.call_end, label: 'Decline', color: const Color(0xFFC62828), onPressed: calls.decline),
                  _RoundButton(key: const Key('accept-call'), icon: calls.video ? Icons.videocam : Icons.call, label: 'Accept', color: const Color(0xFF2E7D32), onPressed: calls.accept),
                ])
              else if (phase != CallPhase.ended)
                Wrap(alignment: WrapAlignment.center, spacing: NexaSpace.lg, runSpacing: NexaSpace.md, children: [
                  _RoundButton(key: const Key('mute'), icon: calls.muted ? Icons.mic_off : Icons.mic, label: calls.muted ? 'Unmute' : 'Mute', selected: calls.muted, onPressed: calls.toggleMute),
                  _RoundButton(key: const Key('speaker'), icon: calls.speaker ? Icons.volume_up : Icons.hearing, label: calls.speaker ? 'Speaker' : 'Phone', selected: calls.speaker, onPressed: calls.toggleSpeaker),
                  if (calls.video) ...[
                    _RoundButton(key: const Key('camera'), icon: calls.cameraOff ? Icons.videocam_off : Icons.videocam, label: calls.cameraOff ? 'Camera on' : 'Camera off', selected: calls.cameraOff, onPressed: calls.toggleCamera),
                    _RoundButton(key: const Key('flip-camera'), icon: Icons.cameraswitch_outlined, label: 'Flip', onPressed: calls.switchCamera),
                  ],
                  _RoundButton(key: const Key('hangup'), icon: Icons.call_end, label: phase == CallPhase.outgoing ? 'Cancel' : 'End', color: const Color(0xFFC62828), onPressed: calls.hangup),
                ])
              else
                TextButton(key: const Key('close-call'), onPressed: calls.dismiss, child: const Text('Close')),
              const SizedBox(height: NexaSpace.xl * 2),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({super.key, required this.icon, required this.label, required this.onPressed, this.color, this.selected = false});
  final IconData icon;
  final String label;
  final Future<void> Function() onPressed;
  final Color? color;
  final bool selected;

  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, children: [
        Semantics(
          button: true,
          toggled: color == null ? selected : null,
          label: label,
          child: IconButton.filled(
            iconSize: 30,
            style: IconButton.styleFrom(
              backgroundColor: color ?? (selected ? Colors.white : Colors.white24),
              foregroundColor: color != null ? Colors.white : (selected ? Colors.black : Colors.white),
              minimumSize: const Size(64, 64),
            ),
            onPressed: () => unawaited(onPressed()),
            icon: Icon(icon),
          ),
        ),
        const SizedBox(height: NexaSpace.xs),
        ExcludeSemantics(child: Text(label, style: const TextStyle(color: Colors.white70, fontSize: 12))),
      ]);
}

/// Recent calls, newest first, with a button to call back.
class CallHistoryScreen extends StatefulWidget {
  const CallHistoryScreen({super.key, required this.chat});
  final ChatController chat;

  @override
  State<CallHistoryScreen> createState() => _CallHistoryScreenState();
}

class _CallHistoryScreenState extends State<CallHistoryScreen> {
  List<Map<String, dynamic>>? _calls;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final r = await widget.chat.auth.authed('GET', '/v1/calls?limit=50');
      if (mounted) setState(() => _calls = [for (final c in r!['calls'] as List) (c as Map).cast<String, dynamic>()]);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _callBack(Map<String, dynamic> c) async {
    final peer = (c['peer'] as Map).cast<String, dynamic>();
    final calls = widget.chat.calls;
    if (calls == null) return;
    final conv = await widget.chat.auth.authed('POST', '/v1/conversations/direct', body: {'userId': peer['id']});
    await widget.chat.refreshList();
    await calls.start(conv!['id'] as String, peer['id'] as String, video: c['media'] == 'video');
  }

  @override
  Widget build(BuildContext context) {
    final list = _calls;
    return Scaffold(
      appBar: AppBar(title: const Text('Calls')),
      body: _error != null
          ? Center(child: Text(_error!))
          : list == null
              ? const Center(child: CircularProgressIndicator())
              : list.isEmpty
                  ? const Center(child: Text('No calls yet.'))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        itemCount: list.length,
                        separatorBuilder: (_, _) => const Divider(height: 1),
                        itemBuilder: (context, i) {
                          final c = list[i];
                          final peer = (c['peer'] as Map).cast<String, dynamic>();
                          final incoming = c['direction'] == 'incoming';
                          final missed = incoming && c['answeredAt'] == null;
                          final video = c['media'] == 'video';
                          final when = DateTime.tryParse(c['createdAt'] as String? ?? '')?.toLocal();
                          final outcome = missed
                              ? 'Missed'
                              : c['endReason'] == 'completed'
                                  ? formatDuration((c['durationSeconds'] as num?)?.toInt() ?? 0)
                                  : (c['endReason'] as String? ?? c['state'] as String).replaceAll('_', ' ');
                          return ListTile(
                            key: Key('call-${c['id']}'),
                            leading: Icon(incoming ? Icons.call_received : Icons.call_made, color: missed ? Theme.of(context).colorScheme.error : null),
                            title: Text(peer['displayName'] as String, style: missed ? TextStyle(color: Theme.of(context).colorScheme.error) : null),
                            subtitle: Text('${video ? 'Video' : 'Voice'} · $outcome${when == null ? '' : ' · ${MaterialLocalizations.of(context).formatShortDate(when)} ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(when))}'}'),
                            trailing: peer['username'] == null
                                ? null
                                : IconButton(
                                    tooltip: 'Call ${peer['displayName']} back',
                                    icon: Icon(video ? Icons.videocam_outlined : Icons.call_outlined),
                                    onPressed: () => unawaited(_callBack(c)),
                                  ),
                          );
                        },
                      ),
                    ),
    );
  }
}
