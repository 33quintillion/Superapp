import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/chat/chat_controller.dart';
import 'package:nexa/chat/realtime.dart';
import 'package:nexa/main.dart';

// The API is faked at the HTTP and socket boundary only. The chat controller, the
// realtime connection (outbox, reconnects, resync) and the widgets are the real code.

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class FakeServer {
  final messages = <Map<String, dynamic>>[];
  final calls = <String>[];
  final sockets = <FakeSocket>[];
  int seq = 0;
  int benDelivered = 0;
  int? benRead = 0;
  int myRead = 0;
  String validToken = 'a1';
  int refreshes = 0;

  Map<String, dynamic> store(String sender, String clientId, String body) {
    final dup = messages.where((m) => m['senderId'] == sender && m['clientId'] == clientId).firstOrNull;
    if (dup != null) return {'message': dup, 'duplicate': true};
    seq += 1;
    final m = {
      'id': 'm$seq',
      'conversationId': 'c1',
      'seq': seq,
      'changeSeq': seq,
      'senderId': sender,
      'clientId': clientId,
      'kind': 'text',
      'body': body,
      'media': null,
      'replyTo': null,
      'forwarded': false,
      'mentions': <String>[],
      'reactions': <Object>[],
      'editedAt': null,
      'deletedAt': null,
      'pinnedAt': null,
      'pinnedBy': null,
      'createdAt': DateTime.utc(2026, 10, 26, 9, seq).toIso8601String(),
    };
    messages.add(m);
    if (sender == 'me') myRead = seq;
    return {'message': m, 'duplicate': false};
  }

  Map<String, dynamic> conv() => {
        'id': 'c1',
        'kind': 'direct',
        'title': '',
        'lastSeq': seq,
        'lastMessage': messages.isEmpty ? null : messages.last,
        'lastMessageAt': messages.isEmpty ? null : messages.last['createdAt'],
        'unreadCount': messages.where((m) => m['senderId'] == 'ben' && (m['seq'] as int) > myRead).length,
        'mutedUntil': null,
        'archived': false,
        'peerId': 'ben',
        'members': [
          {'userId': 'me', 'username': 'ada', 'displayName': 'Ada', 'role': 'member', 'lastDeliveredSeq': myRead, 'lastReadSeq': myRead},
          {'userId': 'ben', 'username': 'ben', 'displayName': 'Ben', 'role': 'member', 'lastDeliveredSeq': benDelivered, 'lastReadSeq': benRead},
        ],
      };

  late final http.Client client = MockClient((req) async {
    final path = req.url.path;
    calls.add('${req.method} $path${req.url.hasQuery ? '?${req.url.query}' : ''}');
    if (path == '/v1/auth/refresh') {
      refreshes += 1;
      return json(200, {'accessToken': validToken, 'refreshToken': 'r$refreshes', 'sessionId': 's', 'expiresIn': 900});
    }
    if (req.headers['authorization'] != 'Bearer $validToken') return json(401, {'error': {'code': 'unauthorized', 'message': 'expired'}});
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
        return json(200, {'messages': messages, 'hasMore': false});
      case ('GET', '/v1/conversations/c1/changes'):
        final since = int.parse(req.url.queryParameters['since'] ?? '0');
        return json(200, {'changes': messages.where((m) => (m['changeSeq'] as int) > since).toList(), 'nextSince': seq > since ? seq : since, 'hasMore': false});
      case ('PUT', '/v1/messages/m1/reaction'):
        final m = messages.first;
        m['reactions'] = [
          {'userId': 'me', 'emoji': (jsonDecode(req.body) as Map)['emoji']},
        ];
        seq += 1;
        m['changeSeq'] = seq;
        return json(200, m);
    }
    return json(404, {'error': {'code': 'not_found', 'message': 'nope'}});
  });

  Future<RealtimeSocket> connect(Uri uri) async {
    expect(uri.toString(), startsWith('ws://api.test/v1/realtime?ticket=t'));
    final s = FakeSocket(this);
    sockets.add(s);
    scheduleMicrotask(() => s.push({'type': 'ready', 'data': {'connectionId': 'x'}}));
    return s;
  }

  /// Ben (on another device) sends a message; it is pushed to every open socket.
  void benSends(String body) {
    final r = store('ben', 'ben-${seq + 1}-client', body);
    for (final s in sockets.where((s) => s.open)) {
      s.push({'type': 'message.created', 'data': r['message']});
    }
  }
}

class FakeSocket implements RealtimeSocket {
  FakeSocket(this.server);
  final FakeServer server;
  final _in = StreamController<dynamic>();
  final sent = <Map<String, dynamic>>[];
  bool open = true;
  /// When false, sends are swallowed as if the connection died before the ack.
  bool answers = true;

  @override
  Stream<dynamic> get stream => _in.stream;

  @override
  void add(String data) {
    final f = jsonDecode(data) as Map<String, dynamic>;
    sent.add(f);
    if (f['type'] == 'send' && answers) {
      final msg = f['message'] as Map<String, dynamic>;
      final r = server.store('me', msg['clientId'] as String, msg['body'] as String);
      push({'type': 'ack', 'ref': f['ref'], 'data': r});
      if (r['duplicate'] == false) push({'type': 'message.created', 'data': r['message']});
    }
  }

  void push(Map<String, dynamic> f) {
    if (open) _in.add(jsonEncode(f));
  }

  /// The network drops: the client sees the stream end.
  Future<void> drop() async {
    open = false;
    await _in.close();
  }

  @override
  Future<void> close() async {
    if (open) await drop();
  }
}

Future<AuthController> signedIn(FakeServer server) async {
  final auth = AuthController(ApiClient(client: server.client, baseUrl: 'http://api.test'), MemorySessionStore()..token = 'r0');
  await auth.restore();
  expect(auth.status, AuthStatus.signedIn);
  return auth;
}

void main() {
  testWidgets('chats live: history, sending, ticks, incoming messages, typing, reactions', (tester) async {
    final server = FakeServer();
    server.store('ben', 'ben-first-msg', 'hey ada');
    final auth = await signedIn(server);
    await tester.pumpWidget(NexaApp(auth: auth, connectSocket: server.connect));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('open-chats')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('connection')), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('hey ada'), findsOneWidget); // list preview

    await tester.tap(find.byKey(const Key('conv-ben')));
    await tester.pumpAndSettle();
    expect(find.text('hey ada'), findsOneWidget);
    // Opening the chat marks Ben's message read.
    final socket = server.sockets.single;
    expect(socket.sent.where((f) => f['type'] == 'receipt'), contains(predicate<Map>((f) => f['kind'] == 'read' && f['seq'] == 1)));

    await tester.enterText(find.byKey(const Key('composer')), 'hello ben');
    await tester.tap(find.byKey(const Key('send')));
    await tester.pumpAndSettle();
    final sendFrame = socket.sent.lastWhere((f) => f['type'] == 'send');
    final clientId = (sendFrame['message'] as Map)['clientId'] as String;
    expect(server.messages.last['body'], 'hello ben');
    expect(find.text(' · Sent'), findsOneWidget);
    expect(find.byKey(Key('ticks-$clientId')), findsOneWidget);

    // Ben reads it on his phone.
    socket.push({'type': 'receipt', 'data': {'conversationId': 'c1', 'userId': 'ben', 'lastDeliveredSeq': 2, 'lastReadSeq': 2}});
    await tester.pumpAndSettle();
    expect(find.text(' · Read'), findsOneWidget);

    socket.push({'type': 'typing', 'data': {'conversationId': 'c1', 'userId': 'ben', 'typing': true}});
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('typing')), findsOneWidget);
    server.benSends('how are you?');
    await tester.pumpAndSettle();
    expect(find.text('how are you?'), findsOneWidget);
    expect(find.byKey(const Key('typing')), findsNothing);
    expect(socket.sent.last, {'type': 'receipt', 'conversationId': 'c1', 'kind': 'read', 'seq': 3});

    await tester.longPress(find.text('hey ada'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('react-👍')));
    await tester.pumpAndSettle();
    expect(find.text('👍'), findsOneWidget);

    await tester.pump(const Duration(seconds: 7)); // let the typing indicator timer run out
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  test('a send whose ack was lost is re-sent after reconnecting and stored once', () async {
    final server = FakeServer();
    final auth = await signedIn(server);
    final chat = ChatController(auth: auth, wsBase: 'ws://api.test', connect: server.connect);
    await chat.start();
    await pumpEventQueue();
    await chat.open('c1');
    expect(chat.status, ConnectionStatus.online);

    final first = server.sockets.single..answers = false;
    final sending = chat.sendText('c1', 'exactly once');
    await pumpEventQueue();
    expect(chat.messagesFor('c1').single.body, 'exactly once');
    expect(server.messages, isEmpty); // the frame never reached the server
    // While offline, Ben sends two messages that this device misses.
    await first.drop();
    await pumpEventQueue();
    expect(chat.status, ConnectionStatus.offline);
    server.benSends('missed 1');
    server.benSends('missed 2');

    // The connection comes back by itself (backoff is well under 2 s on the first retry).
    await Future<void>.delayed(const Duration(milliseconds: 900));
    await sending;
    await pumpEventQueue();
    expect(server.sockets, hasLength(2));
    expect(chat.status, ConnectionStatus.online);
    final resends = server.sockets.last.sent.where((f) => f['type'] == 'send').toList();
    expect(resends, hasLength(1));
    expect((resends.single['message'] as Map)['clientId'], (first.sent.single['message'] as Map)['clientId']);
    expect(server.messages.where((m) => m['body'] == 'exactly once'), hasLength(1));
    // Missed messages were fetched from the change feed, and everything is in order.
    expect(server.calls, contains('GET /v1/conversations/c1/changes?since=0'));
    expect(chat.messagesFor('c1').map((m) => m.body), ['missed 1', 'missed 2', 'exactly once']);
    chat.dispose();
  });

  test('a rejected send is marked failed and not retried', () async {
    final server = FakeServer();
    final auth = await signedIn(server);
    final chat = ChatController(auth: auth, wsBase: 'ws://api.test', connect: server.connect);
    await chat.start();
    await pumpEventQueue();
    await chat.open('c1');
    final s = server.sockets.single..answers = false;
    final sending = chat.sendText('c1', 'blocked?');
    await pumpEventQueue();
    s.push({'type': 'error', 'ref': (s.sent.lastWhere((f) => f['type'] == 'send')['message'] as Map)['clientId'], 'error': {'code': 'cannot_message', 'message': 'You can’t message this person'}});
    await sending;
    expect(chat.messagesFor('c1').single.pending.name, 'failed');
    expect(chat.rt.pendingCount, 0);
    expect(chat.lastError, 'You can’t message this person');
    chat.dispose();
  });

  test('an expired access token is refreshed once and the call retried', () async {
    final server = FakeServer();
    final auth = await signedIn(server);
    server.validToken = 'a2'; // the access token "expires"
    final r = await auth.authed('GET', '/v1/conversations');
    expect(r!['conversations'], hasLength(1));
    expect(server.refreshes, 2);
    expect(auth.status, AuthStatus.signedIn);
  });
}
