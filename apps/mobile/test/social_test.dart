import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nexa/api/api_client.dart';
import 'package:nexa/auth/auth_controller.dart';
import 'package:nexa/auth/session_store.dart';
import 'package:nexa/chat/realtime.dart';
import 'package:nexa/contacts/contacts_book.dart';
import 'package:nexa/main.dart';
import 'package:nexa/media/media.dart';

import 'a11y_helpers.dart';
import 'media_fakes.dart';

// As in chat_test, only the HTTP and socket boundary is faked: the controllers and screens
// are the real code, and every request they make is checked against what the API expects.

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> user(String id, String name) => {'id': id, 'username': id, 'displayName': name};

class FakeApi {
  final calls = <String>[];
  final bodies = <String, Map<String, dynamic>>{};
  final sockets = <FakeSocket>[];
  final handlers = <String, http.Response Function(http.Request)>{};
  final media = FakeMedia();

  late final http.Client client = MockClient((req) async {
    final key = '${req.method} ${req.url.path}';
    calls.add('$key${req.url.hasQuery ? '?${req.url.query}' : ''}');
    final m = media.handle(req);
    if (m != null) return m;
    if (req.body.isNotEmpty) bodies[key] = jsonDecode(req.body) as Map<String, dynamic>;
    if (req.url.path == '/v1/auth/refresh') {
      return json(200, {'accessToken': 'a1', 'refreshToken': 'r1', 'sessionId': 's', 'expiresIn': 900});
    }
    switch (key) {
      case 'GET /v1/me':
        return json(200, {'id': 'me', 'username': 'ada', 'displayName': 'Ada', 'email': 'ada@example.test', 'emailVerified': true});
      case 'POST /v1/realtime/tickets':
        return json(201, {'ticket': 't', 'path': '/v1/realtime', 'expiresIn': 60});
    }
    final h = handlers[key];
    if (h != null) return h(req);
    if (req.method == 'GET' && req.url.path.endsWith('/changes')) return json(200, {'changes': <Object>[], 'nextSince': 0, 'hasMore': false});
    return json(404, {'error': {'code': 'not_found', 'message': 'not found: $key'}});
  });

  void on(String key, http.Response Function(http.Request) h) => handlers[key] = h;

  Future<RealtimeSocket> connect(Uri uri) async {
    final s = FakeSocket();
    sockets.add(s);
    scheduleMicrotask(() => s.push({'type': 'ready', 'data': {'connectionId': 'x'}}));
    return s;
  }
}

class FakeSocket implements RealtimeSocket {
  final _in = StreamController<dynamic>();
  final sent = <Map<String, dynamic>>[];

  @override
  Stream<dynamic> get stream => _in.stream;

  @override
  void add(String data) => sent.add(jsonDecode(data) as Map<String, dynamic>);

  void push(Map<String, dynamic> f) => _in.add(jsonEncode(f));

  @override
  Future<void> close() => _in.close();
}

Future<AuthController> signedIn(FakeApi api) async {
  final auth = AuthController(ApiClient(client: api.client, baseUrl: 'http://api.test'), MemorySessionStore()..token = 'r0');
  await auth.restore();
  expect(auth.status, AuthStatus.signedIn);
  return auth;
}

Future<void> openApp(WidgetTester tester, FakeApi api) async {
  final auth = await signedIn(api);
  await tester.pumpWidget(NexaApp(auth: auth, connectSocket: api.connect));
  await tester.pumpAndSettle();
}

Future<void> closeApp(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pumpAndSettle();
}

// ---------- groups ----------

class GroupState {
  String myRole = 'owner';
  String sendPolicy = 'everyone';
  final messages = <Map<String, dynamic>>[];

  Map<String, dynamic> message(int seq, String sender, String kind, {String? body, Map<String, dynamic>? system}) => {
        'id': 'g1m$seq',
        'conversationId': 'g1',
        'seq': seq,
        'changeSeq': seq,
        'senderId': sender,
        'clientId': 'g1c$seq',
        'kind': kind,
        'body': body,
        'system': system,
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

  Map<String, dynamic> conv() => {
        'id': 'g1',
        'kind': 'group',
        'title': 'Trip',
        'lastSeq': messages.length,
        'lastMessage': messages.lastOrNull,
        'lastMessageAt': messages.lastOrNull?['createdAt'],
        'unreadCount': 0,
        'mutedUntil': null,
        'archived': false,
        'peerId': null,
        'group': {'description': '', 'sendPolicy': sendPolicy, 'infoPolicy': 'admins', 'addPolicy': 'admins', 'myRole': myRole},
        'members': [
          {'userId': 'me', 'username': 'ada', 'displayName': 'Ada', 'role': myRole, 'lastDeliveredSeq': messages.length, 'lastReadSeq': messages.length},
          {'userId': 'ben', 'username': 'ben', 'displayName': 'Ben', 'role': myRole == 'owner' ? 'member' : 'owner', 'lastDeliveredSeq': 0, 'lastReadSeq': 0},
          {'userId': 'cy', 'username': 'cy', 'displayName': 'Cy', 'role': 'member', 'lastDeliveredSeq': 0, 'lastReadSeq': 0},
        ],
      };
}

void main() {
  testWidgets('groups: create, notices, sender names, admins-only setting and losing admin', (tester) async {
    final api = FakeApi();
    final g = GroupState();
    var created = false;
    api.on('GET /v1/conversations', (_) => json(200, {'conversations': [if (created) g.conv()], 'nextCursor': null}));
    api.on('GET /v1/users/ben', (_) => json(200, user('ben', 'Ben')));
    api.on('GET /v1/users/cy', (_) => json(200, user('cy', 'Cy')));
    api.on('GET /v1/users/zed', (_) => json(200, user('zed', 'Zed')));
    api.on('POST /v1/conversations/groups', (req) {
      final b = jsonDecode(req.body) as Map;
      if ((b['memberIds'] as List).contains('zed')) {
        return json(403, {'error': {'code': 'cannot_add', 'message': 'Some people can’t be added', 'details': {'userIds': ['zed']}}});
      }
      created = true;
      g.messages.add(g.message(1, 'me', 'system', system: {'type': 'group_created', 'title': b['title']}));
      return json(201, g.conv());
    });
    api.on('GET /v1/conversations/g1', (_) => json(200, g.conv()));
    api.on('GET /v1/conversations/g1/messages', (_) => json(200, {'messages': g.messages, 'hasMore': false}));
    api.on('PATCH /v1/conversations/g1/group', (req) {
      g.sendPolicy = (jsonDecode(req.body) as Map)['sendPolicy'] as String;
      g.messages.add(g.message(g.messages.length + 1, 'me', 'system', system: {'type': 'group_updated', 'sendPolicy': g.sendPolicy}));
      return json(200, g.conv());
    });

    await openApp(tester, api);
    await tester.tap(find.byKey(const Key('open-chats')));
    await tester.pumpAndSettle();

    // Someone whose privacy settings forbid it can't be added; the reason is shown.
    await tester.tap(find.byKey(const Key('new-group')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('group-title')), 'Trip');
    await tester.enterText(find.byKey(const Key('group-members')), 'ben, zed');
    await tester.tap(find.byKey(const Key('create-group')));
    await tester.pumpAndSettle();
    expect(find.text('Some of those people don’t allow you to add them to groups'), findsOneWidget);
    expect(created, isFalse);

    await tester.tap(find.byKey(const Key('new-group')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('group-title')), '  Trip ');
    await tester.enterText(find.byKey(const Key('group-members')), '@Ben, cy');
    await tester.tap(find.byKey(const Key('create-group')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/conversations/groups'], {'title': 'Trip', 'memberIds': ['ben', 'cy']});
    expect(find.text('You created the group “Trip”'), findsOneWidget);
    expect(find.text('3 members'), findsOneWidget);
    expect(find.byKey(const Key('composer')), findsOneWidget);

    // Ben writes; in a group each run of messages is labelled with its sender.
    g.messages.add(g.message(2, 'ben', 'text', body: 'when do we leave?'));
    api.sockets.last.push({'type': 'message.created', 'data': g.messages.last});
    await tester.pumpAndSettle();
    expect(find.text('when do we leave?'), findsOneWidget);
    expect(find.text('Ben'), findsOneWidget);

    // As owner, switch the group to admins-only.
    await tester.tap(find.byKey(const Key('group-info')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('admins-only-switch')));
    await tester.pumpAndSettle();
    expect(api.bodies['PATCH /v1/conversations/g1/group'], {'sendPolicy': 'admins'});
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('admins-only-switch'))).value, isTrue);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('composer')), findsOneWidget); // admins can still send

    // Ownership moves to Ben on another device; the server tells this one to refresh.
    g.myRole = 'member';
    api.sockets.last.push({'type': 'conversation.changed', 'data': {'id': 'g1'}});
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('admins-only')), findsOneWidget);
    expect(find.byKey(const Key('composer')), findsNothing);

    // Removed from the group elsewhere: the chat disappears from the list.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('conv-g1')), findsOneWidget);
    created = false;
    api.sockets.last.push({'type': 'conversation.removed', 'data': {'id': 'g1'}});
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('conv-g1')), findsNothing);

    await closeApp(tester);
  });

  testWidgets('feed: stories are marked seen, posts can be liked, commented on, reported and written', (tester) async {
    final api = FakeApi();
    final benPost = {
      'id': 'p1',
      'author': user('ben', 'Ben'),
      'community': null,
      'audience': 'followers',
      'body': 'first light at the lake',
      'media': <Object>[],
      'likeCount': 2,
      'commentCount': 0,
      'liked': false,
      'createdAt': '2026-10-26T08:00:00.000Z',
      'editedAt': null,
      'removed': null,
      'shared': null,
    };
    final comments = <Map<String, dynamic>>[];
    api.on('GET /v1/conversations', (_) => json(200, {'conversations': <Object>[], 'nextCursor': null}));
    api.on('GET /v1/stories', (_) => json(200, {
          'groups': [
            {
              'author': user('ben', 'Ben'),
              'allViewed': false,
              'stories': [
                {'id': 's1', 'author': user('ben', 'Ben'), 'kind': 'text', 'body': 'off to the lake', 'background': '#00897B', 'audience': 'followers', 'media': null, 'createdAt': '2026-10-26T07:00:00.000Z', 'expiresAt': '2026-10-27T07:00:00.000Z', 'viewed': false, 'viewCount': null},
              ],
            },
          ],
        }));
    api.on('POST /v1/stories/s1/views', (_) => http.Response('', 204));
    api.on('GET /v1/feed', (_) => json(200, {'posts': [benPost], 'nextCursor': null}));
    api.on('PUT /v1/posts/p1/like', (req) => json(200, {'liked': (jsonDecode(req.body) as Map)['liked'], 'likeCount': 3}));
    api.on('GET /v1/posts/p1/comments', (_) => json(200, {'comments': comments, 'nextCursor': null}));
    api.on('POST /v1/posts/p1/comments', (req) {
      final c = {'id': 'c1', 'postId': 'p1', 'author': user('me', 'Ada'), 'body': (jsonDecode(req.body) as Map)['body'], 'createdAt': '2026-10-26T09:00:00.000Z'};
      comments.add(c);
      return json(201, c);
    });
    api.on('POST /v1/reports', (_) => json(201, {'id': 'r1'}));
    api.on('POST /v1/posts', (req) {
      final b = jsonDecode(req.body) as Map<String, dynamic>;
      return json(201, {
        'post': {...benPost, 'id': 'p2', 'author': user('me', 'Ada'), 'audience': b['audience'], 'body': b['body'], 'likeCount': 0},
        'duplicate': false,
      });
    });

    await openApp(tester, api);
    await tester.tap(find.byKey(const Key('open-feed')));
    await tester.pumpAndSettle();
    expect(find.text('first light at the lake'), findsOneWidget);
    expect(find.text('Ben · Followers'), findsOneWidget);

    await tester.tap(find.byKey(const Key('story-ben')));
    await tester.pumpAndSettle();
    expect(find.text('off to the lake'), findsOneWidget);
    expect(api.calls, contains('POST /v1/stories/s1/views'));
    await tester.tap(find.byKey(const Key('story-body')));
    await tester.pumpAndSettle();
    expect(find.text('first light at the lake'), findsOneWidget);

    await tester.tap(find.byKey(const Key('like-p1')));
    await tester.pumpAndSettle();
    expect(api.bodies['PUT /v1/posts/p1/like'], {'liked': true});
    expect(find.descendant(of: find.byKey(const Key('like-p1')), matching: find.text('3')), findsOneWidget);
    await expectAccessible(tester);

    await tester.tap(find.byKey(const Key('comments-p1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('comment-text')), 'so early!');
    await tester.tap(find.byKey(const Key('send-comment')));
    await tester.pumpAndSettle();
    expect(find.text('so early!'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byKey(const Key('comments-p1')), matching: find.text('1')), findsOneWidget);

    await tester.tap(find.byTooltip('Report'));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/reports'], {'subjectType': 'post', 'subjectId': 'p1', 'reason': 'other'});

    await tester.tap(find.byKey(const Key('compose-post')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('post-text')), 'hello followers');
    await tester.tap(find.byKey(const Key('audience')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Followers').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('publish-post')));
    await tester.pumpAndSettle();
    final sent = api.bodies['POST /v1/posts']!;
    expect(sent['body'], 'hello followers');
    expect(sent['audience'], 'followers');
    expect(sent['clientId'], isA<String>());
    expect(find.text('hello followers'), findsOneWidget);
    expect(find.byKey(const Key('delete-p2')), findsOneWidget); // your own post: delete, not report

    await closeApp(tester);
  });

  testWidgets('photos: a post with several photos (one removed, no re-upload on retry), a photo story, and both shown', (tester) async {
    final api = FakeApi();
    final devices = FakeDevices()
      ..photos.add([
        LocalMedia(bytes: jpeg, fileName: 'a.jpg', contentType: 'image/jpeg'),
        LocalMedia(bytes: png, fileName: 'b.png', contentType: 'image/png'),
        LocalMedia(bytes: jpeg, fileName: 'c.jpg', contentType: 'image/jpeg'),
      ])
      ..photos.add([LocalMedia(bytes: jpeg, fileName: 'story.jpg', contentType: 'image/jpeg')]);
    MediaDevices.instance = devices;
    addTearDown(() => MediaDevices.instance = PlatformMediaDevices());
    final posts = <Map<String, dynamic>>[];
    final stories = <Map<String, dynamic>>[];
    var postAttempts = 0;
    api.on('GET /v1/conversations', (_) => json(200, {'conversations': <Object>[], 'nextCursor': null}));
    api.on('GET /v1/stories', (_) => json(200, {
          'groups': [
            if (stories.isNotEmpty) {'author': user('me', 'Ada'), 'allViewed': true, 'stories': stories},
          ],
        }));
    api.on('GET /v1/feed', (_) => json(200, {'posts': posts, 'nextCursor': null}));
    api.on('POST /v1/posts', (req) {
      postAttempts += 1;
      if (postAttempts == 1) return json(503, {'error': {'code': 'unavailable', 'message': 'Try again'}});
      final b = jsonDecode(req.body) as Map<String, dynamic>;
      final p = {
        'id': 'p9', 'author': user('me', 'Ada'), 'community': null, 'audience': b['audience'], 'body': b['body'], //
        'media': [for (final id in b['mediaIds'] as List) api.media.created[id]],
        'likeCount': 0, 'commentCount': 0, 'liked': false, 'createdAt': '2026-10-26T09:00:00.000Z', 'editedAt': null, 'removed': null, 'shared': null,
      };
      posts.insert(0, p);
      return json(201, {'post': p, 'duplicate': false});
    });
    api.on('POST /v1/stories', (req) {
      final b = jsonDecode(req.body) as Map<String, dynamic>;
      stories.add({
        'id': 's9', 'author': user('me', 'Ada'), 'kind': b['kind'], 'body': '', 'background': '#3D5AFE', 'audience': 'followers', //
        'media': api.media.created[b['mediaId']], 'createdAt': '2026-10-26T09:00:00.000Z', 'expiresAt': '2026-10-27T09:00:00.000Z', 'viewed': true, 'viewCount': 0,
      });
      return json(201, stories.last);
    });

    await openApp(tester, api);
    await tester.tap(find.byKey(const Key('open-feed')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('compose-post')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('add-photos')));
    await tester.pumpAndSettle();
    expect(find.text('Add more photos (3 of 10)'), findsOneWidget);
    await tester.tap(find.byKey(const Key('remove-photo-1')));
    await tester.pumpAndSettle();
    expect(find.text('Add more photos (2 of 10)'), findsOneWidget);

    // A post with photos and no text is allowed. The first attempt fails after the uploads.
    await tester.tap(find.byKey(const Key('publish-post')));
    await tester.pumpAndSettle();
    expect(find.text('Try again'), findsOneWidget);
    await tester.tap(find.byKey(const Key('publish-post')));
    await tester.pumpAndSettle();
    expect(api.calls.where((c) => c == 'POST /v1/media/uploads'), hasLength(2));
    expect(api.bodies['POST /v1/posts'], containsPair('mediaIds', ['md1', 'md2']));
    expect(api.media.stored.keys, ['md1', 'md2']);
    // The new post shows both photos.
    expect(find.byKey(const Key('photos-p9')), findsOneWidget);
    expect(api.calls, containsAll(['GET /v1/media/md1', 'GET /v1/media/md2']));

    await tester.tap(find.byTooltip('Add to your story'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('photo-story')));
    await tester.pumpAndSettle();
    expect(api.bodies['POST /v1/stories'], {'kind': 'image', 'mediaId': 'md3'});
    await tester.tap(find.byKey(const Key('story-me')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('story-photo-s9')), findsOneWidget);
    expect(api.calls, contains('GET /v1/media/md3'));
    await closeApp(tester);
  });

  testWidgets('communities: private ones hide posts until a request is approved; public ones can be joined and posted to', (tester) async {
    final api = FakeApi();
    Map<String, dynamic> community(String id, String slug, String visibility, Map<String, dynamic>? membership) => {
          'id': id,
          'slug': slug,
          'kind': 'community',
          'name': slug == 'garden' ? 'Garden club' : 'Book club',
          'description': '',
          'visibility': visibility,
          'memberCount': 4,
          'membership': membership,
          'createdAt': '2026-10-01T00:00:00.000Z',
        };
    api.on('GET /v1/conversations', (_) => json(200, {'conversations': <Object>[], 'nextCursor': null}));
    api.on('GET /v1/communities', (_) => json(200, {'communities': [community('k1', 'garden', 'private', null), community('k2', 'books', 'public', null)]}));
    api.on('POST /v1/communities/k1/join', (_) => json(200, community('k1', 'garden', 'private', {'role': 'member', 'state': 'pending'})));
    api.on('POST /v1/communities/k2/join', (_) => json(200, community('k2', 'books', 'public', {'role': 'member', 'state': 'active'})));
    api.on('GET /v1/communities/k2/posts', (_) => json(200, {'posts': <Object>[], 'nextCursor': null}));

    await openApp(tester, api);
    await tester.tap(find.byKey(const Key('open-communities')));
    await tester.pumpAndSettle();
    expect(find.text('Community · Private · 4 members'), findsOneWidget);

    await tester.tap(find.byKey(const Key('community-garden')));
    await tester.pumpAndSettle();
    expect(find.text('Posts are visible to members only.'), findsOneWidget);
    expect(api.calls.where((c) => c.startsWith('GET /v1/communities/k1/posts')), isEmpty);
    await tester.tap(find.byKey(const Key('join')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('join-pending')), findsOneWidget);
    expect(find.text('Posts are visible to members only.'), findsOneWidget);
    expect(find.byKey(const Key('compose-community-post')), findsNothing);
    await tester.pageBack();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('community-books')));
    await tester.pumpAndSettle();
    expect(find.text('No posts yet.'), findsOneWidget);
    expect(find.byKey(const Key('compose-community-post')), findsNothing);
    await tester.tap(find.byKey(const Key('join')));
    await tester.pumpAndSettle();
    expect(find.text('4 members · You: member'), findsOneWidget);
    expect(find.byKey(const Key('compose-community-post')), findsOneWidget);

    await closeApp(tester);
  });

  testWidgets('sets, shows and removes the profile photo from the home screen', (tester) async {
    final api = FakeApi();
    String? avatar;
    Map<String, dynamic> me() => {'id': 'me', 'username': 'ada', 'displayName': 'Ada', 'email': 'ada@example.test', 'emailVerified': true, 'avatarMediaId': avatar};
    api.on('PUT /v1/me/avatar', (req) {
      avatar = (jsonDecode(req.body) as Map)['mediaId'] as String;
      return json(200, me());
    });
    api.on('DELETE /v1/me/avatar', (_) {
      avatar = null;
      return json(200, me());
    });
    final devices = FakeDevices()..photos.add([LocalMedia(bytes: png, fileName: 'me.png', contentType: 'image/png')]);
    MediaDevices.instance = devices;
    addTearDown(() => MediaDevices.instance = PlatformMediaDevices());

    await openApp(tester, api);
    expect(find.byKey(const Key('photo-remove')), findsNothing);
    await tester.tap(find.byKey(const Key('edit-photo')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('photo-remove')), findsNothing);
    await tester.tap(find.byKey(const Key('photo-choose')));
    await tester.pumpAndSettle();

    // Uploaded as an image, checked by the API, then made the photo, and shown.
    expect(api.media.created['md1']!['kind'], 'image');
    expect(api.media.stored['md1'], png);
    expect(api.bodies['PUT /v1/me/avatar'], {'mediaId': 'md1'});
    expect(api.calls, contains('GET /v1/media/md1'));
    expect(find.byKey(const Key('avatar-md1')), findsOneWidget);
    await expectAccessible(tester);

    await tester.tap(find.byKey(const Key('edit-photo')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('photo-remove')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('DELETE /v1/me/avatar'));
    expect(find.byKey(const Key('avatar-md1')), findsNothing);
    expect(find.text('A'), findsOneWidget);

    await closeApp(tester);
  });

  testWidgets('find people you know: opt in to being found, check contacts only when asked, follow', (tester) async {
    final api = FakeApi();
    var findable = false;
    api.on('GET /v1/me/privacy', (_) => json(200, {'discoverableByEmail': findable}));
    api.on('PATCH /v1/me/privacy', (req) {
      findable = (jsonDecode(req.body) as Map)['discoverableByEmail'] as bool;
      return json(200, {'discoverableByEmail': findable});
    });
    api.on('POST /v1/contacts/match', (_) => json(200, {
          'matches': [
            {'matched': 'bo@example.test', 'user': {'id': 'u-bo', 'username': 'bo', 'displayName': 'Bo', 'avatarMediaId': null}},
          ],
        }));
    api.on('POST /v1/users/u-bo/follow', (_) => json(200, {'following': 'active', 'followsYou': false}));
    final book = _FakeBook();
    ContactsBook.instance = book;
    addTearDown(() => ContactsBook.instance = PlatformContactsBook());

    await openApp(tester, api);
    await tester.tap(find.byKey(const Key('open-find-people')));
    await tester.pumpAndSettle();
    // Opening the screen doesn't touch the address book.
    expect(book.reads, 0);
    expect(api.calls.where((c) => c.contains('contacts')), isEmpty);
    await expectAccessible(tester);

    await tester.tap(find.byKey(const Key('findable-by-email')));
    await tester.pumpAndSettle();
    expect(api.bodies['PATCH /v1/me/privacy'], {'discoverableByEmail': true});

    // Permission refused: explained, nothing sent.
    book.allowed = false;
    await tester.tap(find.byKey(const Key('check-contacts')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('contacts-note')), findsOneWidget);
    expect(api.calls.where((c) => c.contains('contacts/match')), isEmpty);

    book.allowed = true;
    await tester.tap(find.byKey(const Key('check-contacts')));
    await tester.pumpAndSettle();
    // Addresses lower-cased and de-duplicated across contacts.
    expect(api.bodies['POST /v1/contacts/match'], {
      'emails': ['bo@example.test', 'cy@example.test'],
      'phones': ['+447700900123', '07700 900456'],
    });
    expect(find.text('@bo · bo@example.test'), findsOneWidget);
    await tester.tap(find.byKey(const Key('follow-u-bo')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('POST /v1/users/u-bo/follow'));
    expect(find.text('Following'), findsOneWidget);

    await closeApp(tester);
  });
}

class _FakeBook implements ContactsBook {
  bool allowed = true;
  int reads = 0;
  @override
  Future<List<AddressBookEntry>?> read() async {
    reads += 1;
    if (!allowed) return null;
    return const [
      AddressBookEntry(name: 'Bo', emails: ['Bo@Example.test '], phones: ['+447700900123']),
      AddressBookEntry(name: 'Cy', emails: ['cy@example.test', 'bo@example.test'], phones: ['07700 900456']),
    ];
  }
}
