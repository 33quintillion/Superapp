import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/chat/chat_models.dart';
import 'package:nexa/chat/location_source.dart';
import 'package:nexa/chat/realtime.dart';
import 'package:nexa/main.dart';
import 'package:nexa/business/business_models.dart';
import 'package:nexa/screens/link_screens.dart';

import 'a11y_helpers.dart';

// Polls, stars, disappearing messages, view once, places and contact cards. The API is faked
// at the HTTP and socket boundary; the controller and screens are the real code.

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class FakeLocation implements LocationSource {
  ({double lat, double lng})? here = (lat: 23.1205, lng: 72.0396);
  @override
  Future<({double lat, double lng})?> current() async => here;
}

class Server {
  final messages = <Map<String, dynamic>>[];
  final calls = <String>[];
  final bodies = <String, Object?>{};
  final sockets = <Sock>[];
  int seq = 0;
  int? disappear;
  final starred = <String>{};
  String contactCode = 'ADAPQR2345';
  bool openedMini = false;
  final miniCard = <String, dynamic>{
    'id': 'mp1',
    'name': 'Janpath Dining',
    'tagline': 'Order ahead',
    'icon': '🍛',
    'accent': 'burgundy',
    'hasMenu': true,
    'business': {'id': 'b1', 'handle': 'janpath', 'name': 'Hotel New Janpath', 'verified': false},
  };

  Map<String, dynamic> add(String sender, String kind, {String body = '', Map<String, dynamic> extra = const {}, String? clientId}) {
    seq += 1;
    final m = <String, dynamic>{
      'id': 'm$seq',
      'conversationId': 'c1',
      'seq': seq,
      'changeSeq': seq,
      'senderId': sender,
      'clientId': clientId ?? 'client-$seq-xyz',
      'kind': kind,
      'body': body,
      'media': null,
      'replyTo': null,
      'forwarded': false,
      'mentions': <String>[],
      'reactions': <Object>[],
      'editedAt': null,
      'deletedAt': null,
      'pinnedAt': null,
      'createdAt': DateTime.utc(2026, 10, 31, 9, seq).toIso8601String(),
      'viewOnce': false,
      'openedBy': null,
      'expiresAt': disappear == null ? null : DateTime.now().toUtc().add(Duration(seconds: disappear!)).toIso8601String(),
      ...extra,
    };
    messages.add(m);
    return m;
  }

  Map<String, dynamic> conv() => {
        'id': 'c1',
        'kind': 'direct',
        'title': '',
        'lastSeq': seq,
        'lastMessage': messages.isEmpty ? null : messages.last,
        'lastMessageAt': messages.isEmpty ? null : messages.last['createdAt'],
        'unreadCount': 0,
        'mutedUntil': null,
        'archived': false,
        'disappearSeconds': disappear,
        'peerId': 'ben',
        'members': [
          {'userId': 'me', 'username': 'ada', 'displayName': 'Ada', 'role': 'member', 'lastDeliveredSeq': seq, 'lastReadSeq': seq},
          {'userId': 'ben', 'username': 'ben', 'displayName': 'Ben', 'role': 'member', 'lastDeliveredSeq': seq, 'lastReadSeq': seq},
        ],
      };

  Map<String, dynamic> byId(String id) => messages.firstWhere((m) => m['id'] == id);

  Map<String, dynamic> bump(Map<String, dynamic> m) {
    seq += 1;
    m['changeSeq'] = seq;
    return m;
  }

  late final http.Client client = MockClient((req) async {
    final path = req.url.path;
    final key = '${req.method} $path';
    calls.add(key);
    if (req.body.isNotEmpty) bodies[key] = jsonDecode(req.body);
    if (path == '/v1/auth/refresh') return json(200, {'accessToken': 'a1', 'refreshToken': 'r1', 'sessionId': 's', 'expiresIn': 900});
    switch ((req.method, path)) {
      case ('GET', '/v1/me'):
        return json(200, {'id': 'me', 'username': 'ada', 'displayName': 'Ada', 'email': null, 'emailVerified': false});
      case ('POST', '/v1/realtime/tickets'):
        return json(201, {'ticket': 't', 'path': '/v1/realtime', 'expiresIn': 60});
      case ('GET', '/v1/conversations'):
        return json(200, {'conversations': [conv()], 'nextCursor': null});
      case ('GET', '/v1/conversations/c1'):
        return json(200, conv());
      case ('GET', '/v1/conversations/c1/messages'):
        return json(200, {'messages': messages, 'hasMore': false});
      case ('GET', '/v1/conversations/c1/changes'):
        return json(200, {'changes': <Object>[], 'nextSince': seq, 'hasMore': false});
      case ('GET', '/v1/messages/starred'):
        return json(200, {'messages': [for (final m in messages) if (starred.contains(m['id'])) m], 'nextCursor': null});
      case ('GET', '/v1/ai/features'):
        return json(200, {'translate': true, 'transcribe': true, 'languages': {'hi': 'Hindi', 'gu': 'Gujarati'}});
      case ('POST', '/v1/messages/m1/translate'):
        return json(200, {'messageId': 'm1', 'to': 'gu', 'text': 'ગેટ કોડ 4521 છે'});
      case ('GET', '/v1/mini-programs'):
        return json(200, {'miniPrograms': [miniCard]});
      case ('GET', '/v1/me/mini-programs/recent'):
        return json(200, {'miniPrograms': openedMini ? [miniCard] : <Object>[]});
      case ('GET', '/v1/mini-programs/mp1'):
        openedMini = true;
        return json(200, {
          ...miniCard,
          'pages': [
            {
              'id': 'home',
              'title': 'Home',
              'blocks': [
                {'type': 'heading', 'text': 'Welcome to Hotel New Janpath'},
                {'type': 'button', 'label': 'See the menu', 'action': {'type': 'page', 'pageId': 'menu'}},
                {'type': 'hours'},
              ],
            },
            {
              'id': 'menu',
              'title': 'Menu',
              'blocks': [
                {'type': 'items', 'title': 'Today'},
                {'type': 'button', 'label': 'Order for pickup', 'action': {'type': 'order'}},
              ],
            },
          ],
          'business': {...miniCard['business'] as Map, 'ordersEnabled': true, 'bookingsEnabled': false, 'phone': null},
        });
      case ('GET', '/v1/businesses/b1/items'):
        return json(200, {'items': [{'id': 'i1', 'name': 'Masala dosa', 'description': '', 'priceMinor': 12000, 'currency': 'INR', 'available': true, 'stock': null, 'position': 0}]});
      case ('GET', '/v1/businesses/b1/hours'):
        return json(200, {'hours': [{'weekday': 1, 'opens': '08:00', 'closes': '22:00'}]});
      case ('GET', '/v1/me/contact-code'):
        return json(200, {'code': contactCode, 'qr': 'SUPERAPP-ADD:$contactCode'});
      case ('POST', '/v1/me/contact-code/reset'):
        contactCode = 'NEWPQR2345';
        return json(200, {'code': contactCode, 'qr': 'SUPERAPP-ADD:$contactCode'});
      case ('GET', '/v1/contact-codes/BENPQR2345'):
        return json(200, {'id': 'ben', 'username': 'ben', 'displayName': 'Ben', 'avatarMediaId': null, 'self': false});
      case ('POST', '/v1/conversations/direct'):
        return json(200, conv());
      case ('PUT', '/v1/conversations/c1/disappearing'):
        disappear = (jsonDecode(req.body) as Map)['seconds'] as int?;
        return json(200, conv());
    }
    final vote = RegExp(r'^/v1/messages/(m\d+)/vote$').firstMatch(path);
    if (vote != null) {
      final m = byId(vote.group(1)!);
      final options = ((jsonDecode(req.body) as Map)['options'] as List).cast<int>();
      final poll = m['poll'] as Map<String, dynamic>;
      poll['votes'] = [
        for (final v in poll['votes'] as List) if (v['userId'] != 'me') v,
        for (final o in options) {'userId': 'me', 'option': o},
      ];
      return json(200, bump(m));
    }
    final star = RegExp(r'^/v1/messages/(m\d+)/star$').firstMatch(path);
    if (star != null) {
      final on = (jsonDecode(req.body) as Map)['starred'] as bool;
      if (on) {
        starred.add(star.group(1)!);
      } else {
        starred.remove(star.group(1)!);
      }
      return json(200, {'messageId': star.group(1), 'starred': on});
    }
    final open = RegExp(r'^/v1/messages/(m\d+)/open$').firstMatch(path);
    if (open != null) {
      final m = byId(open.group(1)!);
      if ((m['openedBy'] as List).contains('me')) return json(409, {'error': {'code': 'already_opened', 'message': 'You’ve already opened this'}});
      m['openedBy'] = [...m['openedBy'] as List, 'me'];
      bump(m);
      for (final s in sockets) {
        s.push({'type': 'message.updated', 'data': m});
      }
      return json(200, {'url': 'http://storage.test/once.png', 'expiresIn': 60, 'media': m['media']});
    }
    final user = RegExp(r'^/v1/users/([a-z0-9_]+)$').firstMatch(path);
    if (user != null) return json(200, {'id': 'u-${user.group(1)}', 'username': user.group(1), 'displayName': 'Chandra'});
    return json(404, {'error': {'code': 'not_found', 'message': 'nope'}});
  });

  Future<RealtimeSocket> connect(Uri uri) async {
    final s = Sock(this);
    sockets.add(s);
    scheduleMicrotask(() => s.push({'type': 'ready', 'data': {'connectionId': 'x'}}));
    return s;
  }
}

class Sock implements RealtimeSocket {
  Sock(this.server);
  final Server server;
  final _in = StreamController<dynamic>();
  final sent = <Map<String, dynamic>>[];

  @override
  Stream<dynamic> get stream => _in.stream;

  @override
  void add(String data) {
    final f = jsonDecode(data) as Map<String, dynamic>;
    sent.add(f);
    if (f['type'] != 'send') return;
    final msg = f['message'] as Map<String, dynamic>;
    final extra = <String, dynamic>{};
    if (msg['poll'] != null) extra['poll'] = {...msg['poll'] as Map<String, dynamic>, 'votes': <Object>[]};
    if (msg['location'] != null) {
      final l = msg['location'] as Map<String, dynamic>;
      final live = l['liveMinutes'] as int?;
      extra['location'] = {
        'lat': l['lat'],
        'lng': l['lng'],
        'label': l['label'] ?? '',
        'liveUntil': live == null ? null : DateTime.now().toUtc().add(Duration(minutes: live)).toIso8601String(),
        'updatedAt': DateTime.now().toUtc().toIso8601String(),
      };
    }
    if (msg['contactUserId'] != null) extra['contact'] = {'userId': msg['contactUserId'], 'username': 'chandra', 'displayName': 'Chandra'};
    final m = server.add('me', msg['kind'] as String, body: msg['body'] as String? ?? '', extra: extra, clientId: msg['clientId'] as String);
    push({'type': 'ack', 'ref': f['ref'], 'data': {'message': m, 'duplicate': false}});
    push({'type': 'message.created', 'data': m});
  }

  void push(Map<String, dynamic> f) => _in.add(jsonEncode(f));

  @override
  Future<void> close() => _in.close();
}

Future<AuthController> signedIn(Server server) async {
  final auth = AuthController(ApiClient(client: server.client, baseUrl: 'http://api.test'), MemorySessionStore()..token = 'r0');
  await auth.restore();
  return auth;
}

Future<void> openChat(WidgetTester tester, Server server) async {
  final auth = await signedIn(server);
  await tester.pumpWidget(NexaApp(auth: auth, connectSocket: server.connect));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('open-chats')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('conv-ben')));
  await tester.pumpAndSettle();
}

void main() {
  test('reads polls, places, contact cards, view once and timers from the server', () {
    final m = ChatMessage.fromJson({
      'id': 'm1',
      'conversationId': 'c1',
      'seq': 1,
      'changeSeq': 1,
      'senderId': 'ben',
      'clientId': 'abcdefgh',
      'kind': 'poll',
      'body': 'Dinner?',
      'createdAt': '2026-10-31T09:00:00Z',
      'poll': {
        'options': ['Pizza', 'Dosa'],
        'multiple': false,
        'votes': [
          {'userId': 'me', 'option': 1},
          {'userId': 'ben', 'option': 1},
        ],
      },
      'expiresAt': '2026-10-30T09:00:00Z',
    });
    expect(m.poll!.mine('me'), [1]);
    expect(m.poll!.count(1), 2);
    expect(m.poll!.voters, 2);
    expect(m.preview, '📊 Dinner?');
    expect(m.disappeared, isTrue, reason: 'its time is up');
    expect(describeSystem({'type': 'disappearing_changed', 'seconds': 604800}, 'ben', 'me', (_) => 'Ben'),
        'Ben turned on disappearing messages. New messages will disappear after 7 days.');
    expect(describeSystem({'type': 'disappearing_changed', 'seconds': null}, 'me', 'me', (_) => 'Ben'), 'You turned off disappearing messages.');
    final place = SharedLocation.fromJson({'lat': 23.12, 'lng': 72.04, 'label': '', 'liveUntil': DateTime.now().add(const Duration(minutes: 5)).toIso8601String()});
    expect(place.isLive, isTrue);
    expect(place.mapUri.toString(), contains('mlat=23.12'));
  });

  testWidgets('votes in a poll, opens a view-once photo once, and shows places and contact cards', (tester) async {
    final server = Server();
    server.add('ben', 'poll', body: 'Dinner on Friday?', extra: {
      'poll': {'options': ['Pizza', 'Dosa'], 'multiple': false, 'votes': <Object>[]},
    });
    server.add('ben', 'location', extra: {
      'location': {'lat': 23.1205, 'lng': 72.0396, 'label': 'Hotel New Janpath', 'liveUntil': null, 'updatedAt': '2026-10-31T09:00:00Z'},
    });
    server.add('ben', 'contact', extra: {
      'contact': {'userId': 'u-chandra', 'username': 'chandra', 'displayName': 'Chandra'},
    });
    server.add('ben', 'image', extra: {
      'viewOnce': true,
      'openedBy': <String>[],
      'media': {'id': 'md9', 'kind': 'image', 'contentType': 'image/png', 'byteSize': 10, 'fileName': 'x.png', 'durationMs': null},
    });
    await openChat(tester, server);

    expect(find.text('📊 Dinner on Friday?'), findsOneWidget);
    expect(find.text('Hotel New Janpath'), findsOneWidget);
    expect(find.text('Chandra'), findsOneWidget);
    expect(find.text('Photo · view once'), findsOneWidget);
    await expectAccessible(tester);

    await tester.tap(find.byKey(const Key('vote-client-1-xyz-1')));
    await tester.pumpAndSettle();
    expect(server.bodies['PUT /v1/messages/m1/vote'], {'options': [1]});
    expect(tester.widget<Text>(find.byKey(const Key('votes-client-1-xyz-1'))).data, '1');

    await tester.tap(find.byKey(const Key('once-client-4-xyz')));
    await tester.pumpAndSettle();
    expect(server.calls, contains('POST /v1/messages/m4/open'));
    expect(find.text('This won’t be shown again.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('close-once')));
    await tester.pumpAndSettle();
    expect(find.text('Opened'), findsOneWidget);
    expect(tester.widget<OutlinedButton>(find.byKey(const Key('once-client-4-xyz'))).onPressed, isNull, reason: 'only once');

    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets('sends a poll, a place and a contact card; stars a message; turns on disappearing messages', (tester) async {
    final server = Server();
    server.add('ben', 'text', body: 'the gate code is 4521');
    final fake = FakeLocation();
    LocationSource.instance = fake;
    addTearDown(() => LocationSource.instance = PlatformLocationSource());
    await openChat(tester, server);
    final socket = server.sockets.single;
    Map<String, dynamic> lastSend() => socket.sent.lastWhere((f) => f['type'] == 'send')['message'] as Map<String, dynamic>;

    await tester.tap(find.byKey(const Key('extras')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('extra-poll')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('poll-question')), 'Which day?');
    await tester.enterText(find.byKey(const Key('poll-option-0')), 'Sat');
    await tester.pump();
    await tester.enterText(find.byKey(const Key('poll-option-1')), 'Sun');
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-poll')));
    await tester.pumpAndSettle();
    expect(lastSend(), containsPair('poll', {'options': ['Sat', 'Sun'], 'multiple': false}));
    expect(lastSend()['body'], 'Which day?');
    expect(find.text('📊 Which day?'), findsOneWidget);

    await tester.tap(find.byKey(const Key('extras')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('extra-location')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('place-name')), 'Home');
    await tester.tap(find.byKey(const Key('send-here')));
    await tester.pumpAndSettle();
    expect(lastSend()['location'], {'lat': 23.1205, 'lng': 72.0396, 'label': 'Home'});
    expect(find.text('Home'), findsOneWidget);

    // No location (off, or refused): explained, nothing sent.
    fake.here = null;
    final before = socket.sent.length;
    await tester.tap(find.byKey(const Key('extras')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('extra-location')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('send-here')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Turn on location'), findsOneWidget);
    expect(socket.sent.where((f) => f['type'] == 'send').length, socket.sent.sublist(0, before).where((f) => f['type'] == 'send').length);
    await tester.pump(const Duration(seconds: 5)); // the note goes away
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('extras')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('extra-contact')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('contact-username')), '@Chandra');
    await tester.tap(find.byKey(const Key('send-contact')));
    await tester.pumpAndSettle();
    expect(lastSend()['contactUserId'], 'u-chandra');
    expect(find.text('Chandra'), findsOneWidget);

    await tester.longPress(find.text('the gate code is 4521'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('action-star')));
    await tester.pumpAndSettle();
    expect(server.bodies['PUT /v1/messages/m1/star'], {'starred': true});
    expect(find.byKey(const Key('star-client-1-xyz')), findsOneWidget);

    await tester.tap(find.byKey(const Key('chat-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-disappearing')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('disappear-86400')));
    await tester.pumpAndSettle();
    expect(server.bodies['PUT /v1/conversations/c1/disappearing'], {'seconds': 86400});
    expect(find.byKey(const Key('disappearing-on')), findsOneWidget);
    await expectAccessible(tester);

    await tester.tap(find.byKey(const Key('chat-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-starred')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('starred-m1')), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  test('reads personal QR codes, scanned or typed', () {
    expect(contactCodeFrom('SUPERAPP-ADD:BENPQR2345'), 'BENPQR2345');
    expect(contactCodeFrom('benpqr-2345'), 'BENPQR2345');
    expect(contactCodeFrom('SUPERAPP-LINK:ABCD2345'), isNull, reason: 'a computer-link code is not a contact');
    expect(contactCodeFrom('BENPQR2341'), isNull, reason: '1 is never used');
  });

  testWidgets('My QR code: shows yours, finds someone by their code and opens the chat, and resets', (tester) async {
    final server = Server();
    final auth = await signedIn(server);
    await tester.pumpWidget(NexaApp(auth: auth, connectSocket: server.connect));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const Key('open-my-qr')), 200, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byKey(const Key('open-my-qr')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('my-qr')), findsOneWidget);
    expect(find.text('ADAPQ-R2345'), findsOneWidget);
    await expectAccessible(tester);

    await tester.ensureVisible(find.byKey(const Key('type-contact-code')));
    await tester.tap(find.byKey(const Key('type-contact-code')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('typed-contact-code')), 'benpqr-2345');
    await tester.tap(find.byKey(const Key('find-contact')));
    await tester.pumpAndSettle();
    expect(find.text('Ben'), findsWidgets);
    await tester.tap(find.byKey(const Key('message-person')));
    await tester.pumpAndSettle();
    expect(server.bodies['POST /v1/conversations/direct'], {'userId': 'ben'});
    expect(find.byKey(const Key('composer')), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.byKey(const Key('reset-code')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('reset-code')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-reset')));
    await tester.pumpAndSettle();
    expect(find.text('NEWPQ-R2345'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets('translates a message into a chosen language', (tester) async {
    final server = Server();
    server.add('ben', 'text', body: 'the gate code is 4521');
    await openChat(tester, server);
    await tester.longPress(find.text('the gate code is 4521'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('action-translate')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('lang-gu')));
    await tester.pumpAndSettle();
    expect(server.bodies['POST /v1/messages/m1/translate'], {'to': 'gu'});
    expect(find.text('Translated to Gujarati: ગેટ કોડ 4521 છે'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets('mini-programs: find one, open it, move between its pages, see the live menu', (tester) async {
    final server = Server();
    final auth = await signedIn(server);
    await tester.pumpWidget(NexaApp(auth: auth, connectSocket: server.connect));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const Key('open-mini-programs')), 200, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byKey(const Key('open-mini-programs')));
    await tester.pumpAndSettle();
    expect(find.text('Janpath Dining'), findsOneWidget);
    await expectAccessible(tester);

    await tester.tap(find.byKey(const Key('mini-mp1')));
    await tester.pumpAndSettle();
    expect(find.text('Welcome to Hotel New Janpath'), findsOneWidget);
    expect(find.text('08:00–22:00'), findsOneWidget);
    await expectAccessible(tester);
    await tester.tap(find.byKey(const Key('mini-button-See the menu')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mini-page-menu')), findsOneWidget);
    expect(find.text('Masala dosa'), findsOneWidget);
    expect(find.text(formatMoney(12000, 'INR')), findsOneWidget);
    await expectAccessible(tester);

    // Back goes to the mini-program's first page, then out to the list (now with it under recent).
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mini-page-home')), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mini-recent-mp1')), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });
}
