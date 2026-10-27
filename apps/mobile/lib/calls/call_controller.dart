import 'dart:async';

import 'package:flutter/foundation.dart';

import '../chat/chat_controller.dart';
import '../chat/chat_models.dart';
import '../chat/realtime.dart';
import 'call_engine.dart';

enum CallPhase { idle, outgoing, incoming, connecting, active, reconnecting, ended }

enum CallQuality { good, poor, bad }

class Call {
  Call(this.j);
  final Map<String, dynamic> j;
  String get id => j['id'] as String;
  String get conversationId => j['conversationId'] as String;
  String get callerId => j['callerId'] as String;
  String get calleeId => j['calleeId'] as String;
  bool get video => j['media'] == 'video';
  String get state => j['state'] as String;
  String? get endReason => j['endReason'] as String?;
  String get callerConnectionId => j['callerConnectionId'] as String;
  String? get calleeConnectionId => j['calleeConnectionId'] as String?;
  bool get callerReconnecting => j['callerReconnecting'] == true;
  bool get calleeReconnecting => j['calleeReconnecting'] == true;
  int get durationSeconds => (j['durationSeconds'] as num?)?.toInt() ?? 0;
  bool get answered => j['answeredAt'] != null;
}

/// One sentence for how a call ended, from this person's side.
String callEndedText(Call c, String me, String peerName) {
  final caller = c.callerId == me;
  return switch (c.endReason) {
    'completed' => 'Call ended · ${formatDuration(c.durationSeconds)}',
    'declined' => caller ? '$peerName declined the call' : 'Call declined',
    'missed' => caller ? 'No answer' : 'Missed call',
    'busy' => caller ? '$peerName is on another call' : 'Missed call',
    'cancelled' => caller ? 'Call cancelled' : 'Missed call',
    'failed' => 'Call failed: the connection couldn’t be set up',
    'connection_lost' => 'Call ended: the connection was lost',
    _ => 'Call ended',
  };
}

/// How long media may stay broken (ICE restarts included) before the call is given up.
const recoveryWindow = Duration(seconds: 20);
const _videoBitrate = {CallQuality.good: 1500000, CallQuality.poor: 400000, CallQuality.bad: 150000};

/// One-to-one calls for the signed-in user. Mirrors the web app: the caller always makes
/// the offers (including ICE restarts), a dropped socket resumes the call on the new one,
/// and connection quality is measured from the peer connection's own statistics.
class CallController extends ChangeNotifier {
  CallController({required this.chat, CallEngine Function()? engine}) : _newEngine = engine ?? WebRtcEngine.new {
    chat.addEventTap(_onEvent);
    chat.addReadyTap(() => unawaited(_onReady()));
    chat.calls = this;
  }

  final ChatController chat;
  final CallEngine Function() _newEngine;

  CallPhase phase = CallPhase.idle;
  Call? call;
  bool video = false;
  String peerName = '';
  bool muted = false;
  bool cameraOff = false;
  bool speaker = false;
  CallQuality? quality;
  bool? relayed;
  DateTime? connectedAt;
  /// Something the person should know (permission blocked, how the call ended).
  String? notice;
  CallEngine? engine;

  Future<void>? _peerReady;
  Future<void> _signals = Future.value();
  bool _reportedConnected = false;
  DateTime? _brokenSince;
  String? _lastPeerConn;
  final _timers = <Timer>[];
  Timer? _statsTimer;
  int _lastLost = 0, _lastReceived = 0;

  String get me => chat.me;
  RealtimeConnection get rt => chat.rt;
  bool get busy => phase != CallPhase.idle && phase != CallPhase.ended;
  bool get _isCaller => call?.callerId == me;

  void _set(void Function() fn) {
    fn();
    notifyListeners();
  }

  String _nameFor(String conversationId, String peerId) => chat.conversation(conversationId)?.nameOf(peerId) ?? 'Someone';

  // ---------------------------------------------------------------- actions

  Future<void> start(String conversationId, String peerId, {required bool video}) async {
    if (busy) return;
    _reset();
    _set(() {
      phase = CallPhase.outgoing;
      this.video = video;
      peerName = _nameFor(conversationId, peerId);
      speaker = video;
      notice = null;
    });
    final e = engine = _newEngine();
    try {
      await e.openMedia(video: video);
    } on MediaAccessError catch (err) {
      return _finish(err.describe(video: video));
    }
    final Map<String, dynamic> r;
    try {
      r = await rt.request({'type': 'call.start', 'conversationId': conversationId, 'media': video ? 'video' : 'audio'});
    } on SendRejected catch (err) {
      return _finish(err.message);
    }
    final c = Call(r);
    _set(() => call = c);
    if (c.state == 'ended') return _ended(c);
    unawaited(_ensurePeer());
  }

  Future<void> accept() async {
    final c = call;
    if (c == null || phase != CallPhase.incoming) return;
    _set(() {
      phase = CallPhase.connecting;
      notice = null;
      speaker = c.video;
    });
    final e = engine = _newEngine();
    try {
      await e.openMedia(video: c.video);
    } on MediaAccessError catch (err) {
      await e.close();
      engine = null;
      // Keep ringing so they can allow access and try again, or decline.
      return _set(() {
        phase = CallPhase.incoming;
        notice = err.describe(video: c.video);
      });
    }
    await _ensurePeer();
    try {
      final r = await rt.request({'type': 'call.accept', 'callId': c.id});
      _set(() => call = Call(r));
    } on SendRejected catch (err) {
      _finish(err.code == 'call_not_ringing' ? 'The call has already ended' : 'Couldn’t answer the call');
    }
  }

  Future<void> decline() async {
    final c = call;
    if (c == null) return;
    try {
      await rt.request({'type': 'call.decline', 'callId': c.id});
    } catch (_) {
      await chat.auth.authed('POST', '/v1/calls/${c.id}/decline').catchError((_) => null);
    }
  }

  Future<void> hangup({bool failed = false}) async {
    final c = call;
    if (c == null || !busy) return _finish(null);
    Map<String, dynamic>? r;
    try {
      r = await rt.request({'type': 'call.hangup', 'callId': c.id, 'failed': failed});
    } catch (_) {
      r = await chat.auth.authed('POST', '/v1/calls/${c.id}/hangup', body: {'failed': failed}).catchError((_) => null);
    }
    if (r != null) {
      _ended(Call(r));
    } else {
      _finish(null);
    }
  }

  Future<void> toggleMute() async {
    _set(() => muted = !muted);
    await engine?.setMuted(muted);
  }

  Future<void> toggleCamera() async {
    _set(() => cameraOff = !cameraOff);
    await engine?.setCameraOff(cameraOff);
  }

  Future<void> toggleSpeaker() async {
    _set(() => speaker = !speaker);
    await engine?.setSpeaker(speaker).catchError((_) {});
  }

  Future<void> switchCamera() async => engine?.switchCamera();

  void dismiss() {
    if (phase == CallPhase.ended) _set(_clearView);
  }

  // ---------------------------------------------------------------- events

  void _onEvent(String type, Map<String, dynamic> d) {
    if (type == 'call.updated') {
      _onCallUpdated(Call(d));
    } else if (type == 'call.signal' && d['callId'] == call?.id) {
      final s = (d['signal'] as Map).cast<String, dynamic>();
      _signals = _signals.then((_) => _onSignal(s)).catchError((Object e) => debugPrint('call signal failed: $e'));
    }
  }

  Future<void> _onReady() async {
    final c = call;
    if (c != null && busy && phase != CallPhase.incoming) {
      // This device's socket changed: take our place in the call again.
      try {
        final r = Call(await rt.request({'type': 'call.resume', 'callId': c.id}));
        _onCallUpdated(r);
        if (_isCaller && r.state != 'ringing') await _restartIce();
      } on SendRejected catch (e) {
        if (e.code == 'call_ended') {
          final r = await chat.auth.authed('GET', '/v1/calls/${c.id}').catchError((_) => null);
          if (r != null) {
            _ended(Call(r));
          } else {
            _finish(null);
          }
        }
      }
      return;
    }
    // Opened (or came back) while being rung: show it.
    final r = await chat.auth.authed('GET', '/v1/calls/active').catchError((_) => null);
    final live = r?['call'];
    if (live is Map) _onCallUpdated(Call(live.cast<String, dynamic>()));
  }

  void _onCallUpdated(Call c) {
    final current = call;
    if (current == null || current.id != c.id) {
      if (busy || c.state != 'ringing' || c.calleeId != me) return;
      _reset();
      return _set(() {
        _clearView();
        phase = CallPhase.incoming;
        call = c;
        video = c.video;
        peerName = _nameFor(c.conversationId, c.callerId);
      });
    }
    if (c.state == 'ended') return _ended(c);
    final caller = c.callerId == me;
    if (!caller && c.state != 'ringing' && c.calleeConnectionId != rt.connectionId && phase == CallPhase.incoming) {
      // Answered on another of my devices.
      _reset();
      return _set(_clearView);
    }
    final peerConn = caller ? c.calleeConnectionId : c.callerConnectionId;
    final peerMoved = _lastPeerConn != null && peerConn != _lastPeerConn;
    _lastPeerConn = peerConn;
    _set(() => call = c);
    if (caller && c.state == 'accepted' && phase == CallPhase.outgoing) {
      _set(() => phase = CallPhase.connecting);
      unawaited(_negotiate(iceRestart: false));
    } else if (caller && peerMoved && c.state != 'ringing') {
      unawaited(_restartIce());
    }
    final peerReconnecting = caller ? c.calleeReconnecting : c.callerReconnecting;
    if (peerReconnecting && phase == CallPhase.active) {
      _set(() => phase = CallPhase.reconnecting);
    } else if (!peerReconnecting && phase == CallPhase.reconnecting && _brokenSince == null) {
      _set(() => phase = CallPhase.active);
    }
  }

  Future<void> _onSignal(Map<String, dynamic> s) async {
    if (engine == null) return;
    await _ensurePeer();
    final e = engine;
    if (e == null) return;
    switch (s['kind']) {
      case 'offer':
        final answer = await e.acceptOffer(s['sdp'] as String);
        await _signal({'kind': 'answer', 'sdp': answer});
      case 'answer':
        await e.acceptAnswer(s['sdp'] as String);
      case 'candidate':
        final c = s['candidate'];
        if (c is Map) await e.addCandidate(c.cast<String, dynamic>());
    }
  }

  // ---------------------------------------------------------------- media

  Future<void> _ensurePeer() => _peerReady ??= () async {
        final e = engine!;
        final ice = await chat.auth.authed('GET', '/v1/calls/ice-servers').catchError((_) => null) ?? const {'iceServers': [], 'iceTransportPolicy': 'all'};
        e.onCandidate = (c) => unawaited(_signal({'kind': 'candidate', 'candidate': c}).catchError((_) {}));
        e.onState = _onPeerState;
        await e.createPeer(
          iceServers: [for (final s in ice['iceServers'] as List) (s as Map).cast<String, dynamic>()],
          iceTransportPolicy: ice['iceTransportPolicy'] as String? ?? 'all',
        );
      }();

  Future<void> _negotiate({required bool iceRestart}) async {
    await _ensurePeer();
    final sdp = await engine!.createOffer(iceRestart: iceRestart);
    await _signal({'kind': 'offer', 'sdp': sdp});
  }

  Future<void> _restartIce() async {
    if (engine == null || !_isCaller) return;
    try {
      await _negotiate(iceRestart: true);
    } catch (e) {
      debugPrint('ICE restart failed: $e');
    }
  }

  Future<void> _signal(Map<String, dynamic> signal) async {
    final c = call;
    if (c == null) return;
    if (signal['kind'] == 'candidate') return rt.frame({'type': 'call.signal', 'callId': c.id, 'signal': signal});
    await rt.request({'type': 'call.signal', 'callId': c.id, 'signal': signal});
  }

  void _onPeerState(PeerState s) {
    switch (s) {
      case PeerState.connected:
        _brokenSince = null;
        _set(() {
          phase = CallPhase.active;
          connectedAt ??= DateTime.now();
          notice = null;
        });
        final c = call;
        if (!_reportedConnected && c != null) {
          _reportedConnected = true;
          unawaited(rt.request({'type': 'call.connected', 'callId': c.id}).then((_) {}, onError: (_) {}));
        }
        _startStats();
      case PeerState.disconnected || PeerState.failed:
        if (phase == CallPhase.active) _set(() => phase = CallPhase.reconnecting);
        _brokenSince ??= DateTime.now();
        if (s == PeerState.failed) {
          unawaited(_restartIce());
        } else {
          _later(const Duration(seconds: 3), () {
            if (_brokenSince != null) unawaited(_restartIce());
          });
        }
        // Still the same outage a full window later (nothing reconnected in between): give up.
        final since = _brokenSince;
        _later(recoveryWindow, () {
          if (since != null && identical(_brokenSince, since)) unawaited(hangup(failed: true));
        });
      case PeerState.connecting || PeerState.closed:
        break;
    }
  }

  void _startStats() {
    _statsTimer ??= Timer.periodic(const Duration(seconds: 2), (_) => unawaited(sampleQuality()));
  }

  /// Reads the connection's statistics once: quality hint and video bitrate cap.
  @visibleForTesting
  Future<void> sampleQuality() async {
    final st = await engine?.stats();
    if (st == null) return;
    final dl = st.packetsLost - _lastLost;
    final dr = st.packetsReceived - _lastReceived;
    _lastLost = st.packetsLost;
    _lastReceived = st.packetsReceived;
    final loss = dl + dr > 0 ? dl / (dl + dr) : 0.0;
    final rtt = st.rttSeconds ?? 0;
    final q = loss > 0.15 || rtt > 0.8 ? CallQuality.bad : (loss > 0.05 || rtt > 0.4 ? CallQuality.poor : CallQuality.good);
    if (q != quality) await engine?.setMaxVideoBitrate(_videoBitrate[q]!);
    if (q != quality || st.relayed != relayed) {
      _set(() {
        quality = q;
        relayed = st.relayed;
      });
    }
  }

  // ---------------------------------------------------------------- ending

  void _ended(Call c) {
    final peer = peerName.isEmpty ? 'They' : peerName;
    _teardown();
    _set(() {
      phase = CallPhase.ended;
      call = c;
      notice = callEndedText(c, me, peer);
      quality = null;
    });
    _later(const Duration(seconds: 4), dismiss);
  }

  void _finish(String? message) {
    _teardown();
    _set(() {
      if (message == null) {
        _clearView();
      } else {
        phase = CallPhase.ended;
        notice = message;
      }
    });
    if (message != null) _later(const Duration(seconds: 5), dismiss);
  }

  void _clearView() {
    phase = CallPhase.idle;
    call = null;
    notice = null;
    muted = false;
    cameraOff = false;
    quality = null;
    relayed = null;
    connectedAt = null;
  }

  void _teardown() {
    _statsTimer?.cancel();
    _statsTimer = null;
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
    final e = engine;
    engine = null;
    _peerReady = null;
    if (e != null) unawaited(e.close());
  }

  void _reset() {
    _teardown();
    _reportedConnected = false;
    _brokenSince = null;
    _lastPeerConn = null;
    _lastLost = 0;
    _lastReceived = 0;
    _signals = Future.value();
  }

  void _later(Duration d, void Function() fn) => _timers.add(Timer(d, fn));

  @override
  void dispose() {
    _teardown();
    super.dispose();
  }
}
