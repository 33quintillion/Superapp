import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

enum PeerState { connecting, connected, disconnected, failed, closed }

enum MediaProblem { denied, notFound, inUse, other }

/// Microphone or camera could not be opened.
class MediaAccessError implements Exception {
  MediaAccessError(this.problem, [this.detail]);
  final MediaProblem problem;
  final Object? detail;

  /// Something the person can act on.
  String describe({required bool video}) {
    final what = video ? 'camera and microphone' : 'microphone';
    return switch (problem) {
      MediaProblem.denied => 'Allow SuperApp to use your $what in Settings to make calls.',
      MediaProblem.notFound => 'No $what found on this device.',
      MediaProblem.inUse => 'Your $what is being used by another app.',
      MediaProblem.other => 'Couldn’t start your $what.',
    };
  }
}

class CallStats {
  CallStats({this.rttSeconds, required this.packetsLost, required this.packetsReceived, this.relayed});
  final double? rttSeconds;
  final int packetsLost;
  final int packetsReceived;
  final bool? relayed;
}

/// The media side of a call: devices and the peer connection. The call controller drives
/// it; tests use a fake, the app uses [WebRtcEngine].
abstract class CallEngine {
  void Function(Map<String, dynamic>? candidate)? onCandidate;
  void Function(PeerState state)? onState;
  void Function()? onRemoteMedia;

  /// Asks for the microphone (and camera); the OS shows its permission prompt the first time.
  Future<void> openMedia({required bool video});
  Future<void> createPeer({required List<Map<String, dynamic>> iceServers, required String iceTransportPolicy});
  Future<String> createOffer({bool iceRestart = false});
  /// Applies the caller's offer and returns this side's answer.
  Future<String> acceptOffer(String sdp);
  Future<void> acceptAnswer(String sdp);
  Future<void> addCandidate(Map<String, dynamic> candidate);
  Future<void> setMuted(bool muted);
  Future<void> setCameraOff(bool off);
  Future<void> setSpeaker(bool on);
  Future<void> switchCamera();
  /// Caps outgoing video when the network is struggling (bits per second).
  Future<void> setMaxVideoBitrate(int bps);
  Future<CallStats?> stats();
  Widget localView();
  Widget remoteView();
  Future<void> close();
}

/// flutter_webrtc (libwebrtc) on Android and iOS.
class WebRtcEngine extends CallEngine {
  MediaStream? _local;
  RTCPeerConnection? _pc;
  final _localRenderer = RTCVideoRenderer();
  final _remoteRenderer = RTCVideoRenderer();
  bool _renderersReady = false;
  final _pendingCandidates = <RTCIceCandidate>[];
  bool _haveRemote = false;

  Future<void> _initRenderers() async {
    if (_renderersReady) return;
    await _localRenderer.initialize();
    await _remoteRenderer.initialize();
    _renderersReady = true;
  }

  @override
  Future<void> openMedia({required bool video}) async {
    await _initRenderers();
    try {
      _local = await navigator.mediaDevices.getUserMedia({
        'audio': {'echoCancellation': true, 'noiseSuppression': true, 'autoGainControl': true},
        'video': video ? {'facingMode': 'user', 'width': 1280, 'height': 720} : false,
      });
    } catch (e) {
      final s = e.toString();
      final problem = RegExp(r'ermission|NotAllowed|denied', caseSensitive: false).hasMatch(s)
          ? MediaProblem.denied
          : RegExp(r'NotFound|no device|not found', caseSensitive: false).hasMatch(s)
              ? MediaProblem.notFound
              : RegExp(r'NotReadable|in use|busy', caseSensitive: false).hasMatch(s)
                  ? MediaProblem.inUse
                  : MediaProblem.other;
      throw MediaAccessError(problem, e);
    }
    _localRenderer.srcObject = _local;
    // Voice calls start on the earpiece, video calls on the loudspeaker, like a phone.
    await Helper.setSpeakerphoneOn(video).catchError((_) {});
  }

  @override
  Future<void> createPeer({required List<Map<String, dynamic>> iceServers, required String iceTransportPolicy}) async {
    await _initRenderers();
    final pc = await createPeerConnection({'iceServers': iceServers, 'iceTransportPolicy': iceTransportPolicy, 'sdpSemantics': 'unified-plan'});
    _pc = pc;
    for (final t in _local?.getTracks() ?? <MediaStreamTrack>[]) {
      await pc.addTrack(t, _local!);
    }
    pc.onIceCandidate = (c) => onCandidate?.call({'candidate': c.candidate, 'sdpMid': c.sdpMid, 'sdpMLineIndex': c.sdpMLineIndex});
    pc.onIceGatheringState = (s) {
      if (s == RTCIceGatheringState.RTCIceGatheringStateComplete) onCandidate?.call(null);
    };
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty) {
        _remoteRenderer.srcObject = e.streams.first;
        onRemoteMedia?.call();
      }
    };
    pc.onConnectionState = (s) => onState?.call(switch (s) {
          RTCPeerConnectionState.RTCPeerConnectionStateConnected => PeerState.connected,
          RTCPeerConnectionState.RTCPeerConnectionStateDisconnected => PeerState.disconnected,
          RTCPeerConnectionState.RTCPeerConnectionStateFailed => PeerState.failed,
          RTCPeerConnectionState.RTCPeerConnectionStateClosed => PeerState.closed,
          _ => PeerState.connecting,
        });
  }

  @override
  Future<String> createOffer({bool iceRestart = false}) async {
    final offer = await _pc!.createOffer({if (iceRestart) 'iceRestart': true});
    await _pc!.setLocalDescription(offer);
    return offer.sdp!;
  }

  @override
  Future<String> acceptOffer(String sdp) async {
    await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
    await _flush();
    final answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);
    return answer.sdp!;
  }

  @override
  Future<void> acceptAnswer(String sdp) async {
    await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
    await _flush();
  }

  Future<void> _flush() async {
    _haveRemote = true;
    for (final c in _pendingCandidates.toList()) {
      await _pc!.addCandidate(c).catchError((_) {});
    }
    _pendingCandidates.clear();
  }

  @override
  Future<void> addCandidate(Map<String, dynamic> c) async {
    final cand = RTCIceCandidate(c['candidate'] as String?, c['sdpMid'] as String?, (c['sdpMLineIndex'] as num?)?.toInt());
    if (_haveRemote) {
      await _pc?.addCandidate(cand).catchError((_) {});
    } else {
      _pendingCandidates.add(cand);
    }
  }

  @override
  Future<void> setMuted(bool muted) async {
    for (final t in _local?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = !muted;
    }
  }

  @override
  Future<void> setCameraOff(bool off) async {
    for (final t in _local?.getVideoTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = !off;
    }
  }

  @override
  Future<void> setSpeaker(bool on) => Helper.setSpeakerphoneOn(on);

  @override
  Future<void> switchCamera() async {
    final v = _local?.getVideoTracks();
    if (v != null && v.isNotEmpty) await Helper.switchCamera(v.first);
  }

  @override
  Future<void> setMaxVideoBitrate(int bps) async {
    for (final s in await _pc?.getSenders() ?? <RTCRtpSender>[]) {
      if (s.track?.kind != 'video') continue;
      final p = s.parameters;
      final enc = p.encodings;
      if (enc == null || enc.isEmpty) continue;
      enc.first.maxBitrate = bps;
      await s.setParameters(p).catchError((_) => false);
    }
  }

  @override
  Future<CallStats?> stats() async {
    final pc = _pc;
    if (pc == null) return null;
    final reports = await pc.getStats();
    final byId = {for (final r in reports) r.id: r};
    double? rtt;
    bool? relayed;
    var lost = 0, received = 0;
    for (final r in reports) {
      final v = r.values;
      if (r.type == 'candidate-pair' && v['nominated'] == true && v['state'] == 'succeeded') {
        rtt = (v['currentRoundTripTime'] as num?)?.toDouble();
        final local = byId[v['localCandidateId']]?.values;
        final remote = byId[v['remoteCandidateId']]?.values;
        relayed = local?['candidateType'] == 'relay' || remote?['candidateType'] == 'relay';
      } else if (r.type == 'inbound-rtp') {
        lost += (v['packetsLost'] as num?)?.toInt() ?? 0;
        received += (v['packetsReceived'] as num?)?.toInt() ?? 0;
      }
    }
    return CallStats(rttSeconds: rtt, packetsLost: lost, packetsReceived: received, relayed: relayed);
  }

  @override
  Widget localView() => RTCVideoView(_localRenderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover);

  @override
  Widget remoteView() => RTCVideoView(_remoteRenderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover);

  @override
  Future<void> close() async {
    for (final t in _local?.getTracks() ?? <MediaStreamTrack>[]) {
      await t.stop();
    }
    await _local?.dispose();
    _local = null;
    await _pc?.close();
    _pc = null;
    if (_renderersReady) {
      _localRenderer.srcObject = null;
      _remoteRenderer.srcObject = null;
      await _localRenderer.dispose();
      await _remoteRenderer.dispose();
      _renderersReady = false;
    }
  }
}
