import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/calls/call_controller.dart';
import 'package:nexa/calls/call_engine.dart';
import 'package:nexa/chat/chat_models.dart';
import 'package:nexa/chat/realtime.dart';
import 'package:nexa/main.dart';

import 'a11y_helpers.dart';

// The API is faked at the HTTP and socket boundary, and call media at the CallEngine
// boundary (WebRTC needs real devices). The call controller, the realtime connection and
// the screens are the real code.

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> callJson({String id = 'call1', String caller = 'me', String callee = 'ben', String media = 'video', String state = 'ringing', String? endReason, String? calleeConn, int duration = 0, bool callerReconnecting = false, bool calleeReconnecting = false, String callerConn = 'conn1'}) => {
      'id': id,
      'conversationId': 'c1',
      'callerId': caller,
      'calleeId': callee,
      'media': media,
      'state': state,
      'endReason': endReason,
      'endedBy': null,
      'callerConnectionId': callerConn,
      'calleeConnectionId': calleeConn,
      'callerReconnecting': callerReconnecting,
      'calleeReconnecting': calleeReconnecting,
      'createdAt': '2026-10-27T09:00:00.000Z',
      'answeredAt': state == 'ringing' ? null : '2026-10-27T09:00:05.000Z',
      'connectedAt': null,
      'endedAt': state == 'ended' ? '2026-10-27T09:01:00.000Z' : null,
      'durationSeconds': duration,
    };

class FakeServer {
  final sockets = <FakeSocket>[];
  final httpCalls = <String>[];
  Map<String, dynamic>? activeCall;
  final history = <Map<String, dynamic>>[];

  Map<String, dynamic> conv() => {
        'id': 'c1',
        'kind': 'direct',
        'title': '',
        'lastSeq': 0,
        'lastMessage': null,
        'lastMessageAt': null,
        'unreadCount': 0,
        'mutedUntil': null,
        'archived': false,
        'peerId': 'ben',
        'members': [
          {'userId': 'me', 'username': 'ada', 'displayName': 'Ada', 'role': 'member', 'lastDeliveredSeq': 0, 'lastReadSeq': 0},
          {'userId': 'ben', 'username': 'ben', 'displayName': 'Ben', 'role': 'member', 'lastDeliveredSeq': 0, 'lastReadSeq': 0},
        ],
      };

  late final http.Client client = MockClient((req) async {
    final path = req.url.path;
    httpCalls.add('${req.method} $path');
    if (path == '/v1/auth/refresh') return json(200, {'accessToken': 'a1', 'refreshToken': 'r1', 'sessionId': 's', 'expiresIn': 900});
    switch ((req.method, path)) {
      case ('GET', '/v1/me'):
        return json(200, {'id': 'me', 'username': 'ada', 'displayName': 'Ada', 'email': 'ada@example.test', 'emailVerified': true});
      case ('POST', '/v1/realtime/tickets'):
        return json(201, {'ticket': 't${sockets.length}', 'path': '/v1/realtime', 'expiresIn': 60});
      case ('GET', '/v1/conversations'):
        return json(200, {'conversations': [conv()], 'nextCursor': null});
      case ('GET', '/v1/conversations/c1'):
        return json(200, conv());
      case ('GET', '/v1/conversations/c1/messages'):
        return json(200, {'messages': [], 'hasMore': false});
      case ('GET', '/v1/conversations/c1/changes'):
        return json(200, {'changes': [], 'nextSince': 0, 'hasMore': false});
      case ('GET', '/v1/calls/ice-servers'):
        return json(200, {
          'iceServers': [
            {'urls': ['stun:stun.example.test:3478']},
            {'urls': ['turn:turn.example.test:3478'], 'username': '1:me', 'credential': 'pw'},
          ],
          'iceTransportPolicy': 'all',
          'relay': true,
          'expiresAt': null,
        });
      case ('GET', '/v1/calls/active'):
        return json(200, {'call': activeCall});
      case ('GET', '/v1/calls'):
        return json(200, {'calls': history, 'nextCursor': null});
    }
    return json(404, {'error': {'code': 'not_found', 'message': 'nope'}});
  });

  Future<RealtimeSocket> connect(Uri uri) async {
    final s = FakeSocket(this, 'conn${sockets.length + 1}');
    sockets.add(s);
    scheduleMicrotask(() => s.push({'type': 'ready', 'data': {'connectionId': s.id}}));
    return s;
  }

  FakeSocket get socket => sockets.last;
}

/// Answers call frames the way the API does; tests push the other person's actions.
class FakeSocket implements RealtimeSocket {
  FakeSocket(this.server, this.id);
  final FakeServer server;
  final String id;
  final _in = StreamController<dynamic>();
  final sent = <Map<String, dynamic>>[];
  bool open = true;
  /// Overrides the ack for a frame type (e.g. to answer with an error).
  final replies = <String, Map<String, dynamic>>{};

  @override
  Stream<dynamic> get stream => _in.stream;

  Iterable<Map<String, dynamic>> framesOf(String type) => sent.where((f) => f['type'] == type);
  Iterable<Map<String, dynamic>> signals(String kind) => framesOf('call.signal').where((f) => (f['signal'] as Map)['kind'] == kind);

  @override
  void add(String data) {
    final f = jsonDecode(data) as Map<String, dynamic>;
    sent.add(f);
    final ref = f['ref'];
    if (ref == null) return;
    final type = f['type'] as String;
    if (replies.containsKey(type)) return push({...replies[type]!, 'ref': ref});
    final data2 = switch (type) {
      'call.start' => callJson(media: f['media'] as String, callerConn: id),
      'call.accept' => callJson(caller: 'ben', callee: 'me', state: 'accepted', calleeConn: id, media: 'audio'),
      'call.decline' => callJson(caller: 'ben', callee: 'me', state: 'ended', endReason: 'declined', media: 'audio'),
      'call.hangup' => callJson(state: 'ended', endReason: f['failed'] == true ? 'failed' : 'completed', calleeConn: 'ben1', duration: 5),
      'call.resume' => callJson(state: 'connected', calleeConn: 'ben1', callerConn: id),
      _ => <String, dynamic>{'ok': true},
    };
    push({'type': 'ack', 'ref': ref, 'data': data2});
  }

  void push(Map<String, dynamic> f) {
    if (open) _in.add(jsonEncode(f));
  }

  Future<void> drop() async {
    open = false;
    await _in.close();
  }

  @override
  Future<void> close() async {
    if (open) await drop();
  }
}

class FakeEngine extends CallEngine {
  MediaAccessError? refuse;
  bool? openedVideo;
  List<Map<String, dynamic>>? iceServers;
  final offers = <bool>[]; // iceRestart flag of each offer made
  final remote = <String>[];
  final candidates = <Map<String, dynamic>>[];
  bool muted = false, cameraOff = false, closed = false;
  bool? speaker;
  final bitrates = <int>[];
  CallStats? nextStats;

  @override
  Future<void> openMedia({required bool video}) async {
    if (refuse != null) throw refuse!;
    openedVideo = video;
  }

  @override
  Future<void> createPeer({required List<Map<String, dynamic>> iceServers, required String iceTransportPolicy}) async => this.iceServers = iceServers;
  @override
  Future<String> createOffer({bool iceRestart = false}) async {
    offers.add(iceRestart);
    return 'offer-sdp-${offers.length}';
  }

  @override
  Future<String> acceptOffer(String sdp) async {
    remote.add(sdp);
    return 'answer-sdp';
  }

  @override
  Future<void> acceptAnswer(String sdp) async => remote.add(sdp);
  @override
  Future<void> addCandidate(Map<String, dynamic> candidate) async => candidates.add(candidate);
  @override
  Future<void> setMuted(bool m) async => muted = m;
  @override
  Future<void> setCameraOff(bool off) async => cameraOff = off;
  @override
  Future<void> setSpeaker(bool on) async => speaker = on;
  @override
  Future<void> switchCamera() async {}
  @override
  Future<void> setMaxVideoBitrate(int bps) async => bitrates.add(bps);
  @override
  Future<CallStats?> stats() async => nextStats;
  @override
  Widget localView() => const ColoredBox(color: Colors.blue);
  @override
  Widget remoteView() => const ColoredBox(color: Colors.green);
  @override
  Future<void> close() async => closed = true;
}

Future<(FakeServer, List<FakeEngine>)> launch(WidgetTester tester, {MediaAccessError? refuse}) async {
  final server = FakeServer();
  final engines = <FakeEngine>[];
  final auth = AuthController(ApiClient(client: server.client, baseUrl: 'http://api.test'), MemorySessionStore()..token = 'r0');
  await auth.restore();
  expect(auth.status, AuthStatus.signedIn);
  await tester.pumpWidget(NexaApp(
    auth: auth,
    connectSocket: server.connect,
    callEngine: () {
      final e = FakeEngine()..refuse = refuse;
      engines.add(e);
      return e;
    },
  ));
  await tester.pumpAndSettle();
  return (server, engines);
}

Future<void> openChat(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('open-chats')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('conv-ben')));
  await tester.pumpAndSettle();
}

Future<void> finish(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 30));
  await tester.pumpWidget(const SizedBox());
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('outgoing video call: rings, connects, controls work, hangs up', (tester) async {
    final (server, engines) = await launch(tester);
    await openChat(tester);
    await tester.tap(find.byKey(const Key('video-call')));
    await tester.pumpAndSettle();
    final s = server.socket;
    expect(s.framesOf('call.start').single, containsPair('media', 'video'));
    expect(find.text('Ringing…'), findsOneWidget);
    expect(find.text('Ben'), findsWidgets);
    final e = engines.single;
    expect(e.openedVideo, true);
    // TURN credentials from the API go straight into the peer connection.
    expect(e.iceServers, [
      {'urls': ['stun:stun.example.test:3478']},
      {'urls': ['turn:turn.example.test:3478'], 'username': '1:me', 'credential': 'pw'},
    ]);

    // Ben answers: Ada (the caller) makes the offer.
    s.push({'type': 'call.updated', 'data': callJson(state: 'accepted', calleeConn: 'ben1')});
    await tester.pumpAndSettle();
    expect(find.text('Connecting…'), findsOneWidget);
    await expectAccessible(tester);
    expect((s.signals('offer').single['signal'] as Map)['sdp'], 'offer-sdp-1');
    s.push({'type': 'call.signal', 'data': {'callId': 'call1', 'from': 'ben', 'signal': {'kind': 'answer', 'sdp': 'ben-answer'}}});
    s.push({'type': 'call.signal', 'data': {'callId': 'call1', 'from': 'ben', 'signal': {'kind': 'candidate', 'candidate': {'candidate': 'candidate:1', 'sdpMid': '0', 'sdpMLineIndex': 0}}}});
    await tester.pumpAndSettle();
    expect(e.remote, ['ben-answer']);
    expect(e.candidates.single['candidate'], 'candidate:1');
    e.onCandidate!({'candidate': 'candidate:mine', 'sdpMid': '0', 'sdpMLineIndex': 0});
    expect((s.signals('candidate').single['signal'] as Map)['candidate'], containsPair('candidate', 'candidate:mine'));

    e.onState!(PeerState.connected);
    await tester.pumpAndSettle();
    expect(find.text('0:00'), findsOneWidget);
    expect(s.framesOf('call.connected'), hasLength(1));
    expect(find.byKey(const Key('remote-video')), findsOneWidget);
    expect(find.byKey(const Key('local-video')), findsOneWidget);

    await tester.tap(find.byKey(const Key('mute')));
    await tester.tap(find.byKey(const Key('camera')));
    await tester.tap(find.byKey(const Key('speaker')));
    await tester.pumpAndSettle();
    expect(e.muted, true);
    expect(e.cameraOff, true);
    expect(e.speaker, false); // video calls start on the loudspeaker
    expect(find.byKey(const Key('local-video')), findsNothing);
    expect(find.text('Unmute'), findsOneWidget);

    await tester.tap(find.byKey(const Key('hangup')));
    await tester.pumpAndSettle();
    expect(s.framesOf('call.hangup').single['failed'], false);
    expect(find.text('Call ended · 0:05'), findsOneWidget);
    expect(e.closed, true);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('call-status')), findsNothing); // the call screen closed
    await finish(tester);
  });

  testWidgets('incoming voice call: rings anywhere in the app, answers, and replies to the offer', (tester) async {
    final (server, engines) = await launch(tester);
    final s = server.socket;
    s.push({'type': 'call.updated', 'data': callJson(caller: 'ben', callee: 'me', media: 'audio', callerConn: 'ben1')});
    await tester.pumpAndSettle();
    expect(find.text('Incoming voice call…'), findsOneWidget);
    expect(find.text('Ben'), findsOneWidget);

    await tester.tap(find.byKey(const Key('accept-call')));
    await tester.pumpAndSettle();
    expect(engines.single.openedVideo, false);
    expect(s.framesOf('call.accept').single['callId'], 'call1');
    s.push({'type': 'call.signal', 'data': {'callId': 'call1', 'from': 'ben', 'signal': {'kind': 'offer', 'sdp': 'ben-offer'}}});
    await tester.pumpAndSettle();
    expect(engines.single.remote, ['ben-offer']);
    expect((s.signals('answer').single['signal'] as Map)['sdp'], 'answer-sdp');
    // Only the caller makes offers.
    expect(engines.single.offers, isEmpty);
    await finish(tester);
  });

  testWidgets('blocked microphone: outgoing call is not placed; incoming keeps ringing with an explanation', (tester) async {
    final (server, _) = await launch(tester, refuse: MediaAccessError(MediaProblem.denied));
    await openChat(tester);
    await tester.tap(find.byKey(const Key('voice-call')));
    await tester.pumpAndSettle();
    expect(find.text('Allow Nexa to use your microphone in Settings to make calls.'), findsOneWidget);
    expect(server.socket.framesOf('call.start'), isEmpty);
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();

    server.socket.push({'type': 'call.updated', 'data': callJson(id: 'call2', caller: 'ben', callee: 'me', media: 'video', callerConn: 'ben1')});
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('accept-call')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('call-notice')), findsOneWidget);
    expect(find.text('Allow Nexa to use your camera and microphone in Settings to make calls.'), findsOneWidget);
    expect(find.text('Incoming video call…'), findsOneWidget);
    expect(server.socket.framesOf('call.accept'), isEmpty);
    await tester.tap(find.byKey(const Key('decline-call')));
    await tester.pumpAndSettle();
    expect(server.socket.framesOf('call.decline').single['callId'], 'call2');
    await finish(tester);
  });

  testWidgets('answered on another device: this one stops ringing', (tester) async {
    final (server, _) = await launch(tester);
    final s = server.socket;
    s.push({'type': 'call.updated', 'data': callJson(caller: 'ben', callee: 'me', callerConn: 'ben1')});
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('accept-call')), findsOneWidget);
    s.push({'type': 'call.updated', 'data': callJson(caller: 'ben', callee: 'me', state: 'accepted', calleeConn: 'my-tablet', callerConn: 'ben1')});
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('accept-call')), findsNothing);
    await finish(tester);
  });

  testWidgets('media that breaks is restarted, then given up as failed', (tester) async {
    final (server, engines) = await launch(tester);
    await openChat(tester);
    await tester.tap(find.byKey(const Key('video-call')));
    await tester.pumpAndSettle();
    final s = server.socket;
    s.push({'type': 'call.updated', 'data': callJson(state: 'accepted', calleeConn: 'ben1')});
    await tester.pumpAndSettle();
    final e = engines.single;
    e.onState!(PeerState.connected);
    await tester.pumpAndSettle();

    e.onState!(PeerState.failed);
    await tester.pump();
    await tester.pump();
    expect(find.text('Reconnecting…'), findsOneWidget);
    expect(e.offers, [false, true]); // an ICE restart offer went out
    await tester.pump(const Duration(seconds: 21));
    await tester.pumpAndSettle();
    expect(s.framesOf('call.hangup').single['failed'], true);
    expect(find.text('Call failed: the connection couldn’t be set up'), findsOneWidget);
    await finish(tester);
  });

  testWidgets('a dropped socket resumes the call on the new one and restarts ICE', (tester) async {
    final (server, engines) = await launch(tester);
    await openChat(tester);
    await tester.tap(find.byKey(const Key('video-call')));
    await tester.pumpAndSettle();
    final first = server.socket;
    first.push({'type': 'call.updated', 'data': callJson(state: 'accepted', calleeConn: 'ben1')});
    await tester.pumpAndSettle();
    engines.single.onState!(PeerState.connected);
    await tester.pumpAndSettle();

    await first.drop();
    await tester.pump(const Duration(seconds: 2)); // the reconnect backoff
    await tester.pumpAndSettle();
    final second = server.socket;
    expect(second, isNot(same(first)));
    expect(second.framesOf('call.resume').single['callId'], 'call1');
    expect(engines.single.offers, [false, true]);
    expect(second.signals('offer'), hasLength(1));
    expect(find.byKey(const Key('call-status')), findsOneWidget); // still in the call
    await finish(tester);
  });

  testWidgets('poor network: shown on screen and video bitrate is capped', (tester) async {
    final (server, engines) = await launch(tester);
    await openChat(tester);
    await tester.tap(find.byKey(const Key('video-call')));
    await tester.pumpAndSettle();
    server.socket.push({'type': 'call.updated', 'data': callJson(state: 'accepted', calleeConn: 'ben1')});
    await tester.pumpAndSettle();
    final e = engines.single;
    e.onState!(PeerState.connected);
    e.nextStats = CallStats(rttSeconds: 0.05, packetsLost: 0, packetsReceived: 100, relayed: true);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('call-quality')), findsNothing);
    e.nextStats = CallStats(rttSeconds: 0.5, packetsLost: 8, packetsReceived: 200, relayed: true);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('Poor connection'), findsOneWidget);
    expect(e.bitrates, [1500000, 400000]);
    await finish(tester);
  });

  testWidgets('call history lists calls and missed ones stand out', (tester) async {
    final (server, _) = await launch(tester);
    server.history.addAll([
      {...callJson(caller: 'ben', callee: 'me', state: 'ended', endReason: 'missed'), 'answeredAt': null, 'direction': 'incoming', 'peer': {'id': 'ben', 'username': 'ben', 'displayName': 'Ben'}},
      {...callJson(id: 'call0', state: 'ended', endReason: 'completed', duration: 125, media: 'audio'), 'direction': 'outgoing', 'peer': {'id': 'ben', 'username': 'ben', 'displayName': 'Ben'}},
    ]);
    await tester.tap(find.byKey(const Key('open-calls')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Video · Missed'), findsOneWidget);
    expect(find.textContaining('Voice · 2:05'), findsOneWidget);
    await finish(tester);
  });

  test('call notices in the chat read naturally from each side', () {
    final missed = {'type': 'call', 'callId': 'x', 'media': 'video', 'outcome': 'missed', 'durationSeconds': 0};
    expect(describeSystem(missed, 'ben', 'me', (_) => 'Ben'), 'Missed video call');
    expect(describeSystem(missed, 'me', 'me', (_) => 'Ben'), 'Video call · no answer');
    final done = {'type': 'call', 'callId': 'x', 'media': 'audio', 'outcome': 'completed', 'durationSeconds': 3725};
    expect(describeSystem(done, 'me', 'me', (_) => 'Ben'), '↗ Voice call · 1:02:05');
    expect(describeSystem({...done, 'outcome': 'declined'}, 'ben', 'me', (_) => 'Ben'), 'You declined a voice call');
  });

  test('a failed call without a TURN relay tells the person to try another network', () {
    final failed = Call(callJson(state: 'ended', endReason: 'failed'));
    expect(callEndedText(failed, 'me', 'Ben', relay: false), 'Call failed: your networks couldn’t connect directly. Try again on Wi-Fi or another network');
    expect(callEndedText(failed, 'me', 'Ben', relay: true), 'Call failed: the connection couldn’t be set up');
    expect(callEndedText(failed, 'me', 'Ben'), 'Call failed: the connection couldn’t be set up');
  });
}
