import 'dart:async';

import 'package:flutter/foundation.dart';

import '../auth/auth_controller.dart';
import 'chat_models.dart';
import 'realtime.dart';

/// Chat state for the signed-in user: the conversation list, loaded histories, and the
/// live connection. Every change comes from an API response or a server event.
class ChatController extends ChangeNotifier {
  ChatController({required this.auth, required String wsBase, SocketFactory? connect}) {
    rt = RealtimeConnection(
      wsBase: wsBase,
      connect: connect,
      fetchTicket: () async => (await auth.authed('POST', '/v1/realtime/tickets'))!,
      onEvent: _onEvent,
      onReady: _onReady,
    )..addListener(notifyListeners);
  }

  final AuthController auth;
  late final RealtimeConnection rt;

  List<Conversation> conversations = [];
  final Map<String, List<ChatMessage>> _messages = {};
  final Map<String, bool> hasMore = {};
  final Map<String, int> _synced = {};
  final Set<String> _loaded = {};
  final Set<String> _resyncing = {};
  final Map<String, DateTime> _typingUntil = {};
  String? activeId;
  String? lastError;

  String get me => auth.profile!.id;
  ConnectionStatus get status => rt.status;
  List<ChatMessage> messagesFor(String cid) => _messages[cid] ?? const [];
  Conversation? conversation(String cid) => conversations.where((c) => c.id == cid).firstOrNull;
  bool isTyping(String cid, String userId) => (_typingUntil['$cid:$userId']?.isAfter(DateTime.now())) ?? false;

  Future<void> start() async {
    await refreshList();
    rt.start();
  }

  Future<void> refreshList() async {
    final r = await auth.authed('GET', '/v1/conversations');
    conversations = [for (final c in r!['conversations'] as List) Conversation.fromJson(c as Map<String, dynamic>)];
    _sortList();
    notifyListeners();
  }

  Future<void> _refreshOne(String cid) async {
    try {
      final c = Conversation.fromJson((await auth.authed('GET', '/v1/conversations/$cid'))!);
      conversations = [...conversations.where((x) => x.id != cid), c];
      _sortList();
      notifyListeners();
    } catch (_) {
      // Picked up again on the next event or reconnect.
    }
  }

  void _sortList() => conversations.sort((a, b) => (b.lastMessageAt ?? DateTime(0)).compareTo(a.lastMessageAt ?? DateTime(0)));

  Future<String> openDirectByUsername(String username) async {
    final user = await auth.authed('GET', '/v1/users/${Uri.encodeComponent(username.trim().replaceFirst('@', '').toLowerCase())}');
    final c = Conversation.fromJson((await auth.authed('POST', '/v1/conversations/direct', body: {'userId': user!['id']}))!);
    conversations = [...conversations.where((x) => x.id != c.id), c];
    _sortList();
    notifyListeners();
    return c.id;
  }

  Future<String> createGroup(String title, List<String> usernames) async {
    final ids = <String>[];
    for (final u in usernames) {
      ids.add((await auth.authed('GET', '/v1/users/${Uri.encodeComponent(u.trim().replaceFirst('@', '').toLowerCase())}'))!['id'] as String);
    }
    final c = Conversation.fromJson((await auth.authed('POST', '/v1/conversations/groups', body: {'title': title.trim(), 'memberIds': ids}))!);
    _adopt(c);
    return c.id;
  }

  Future<void> addToGroup(String cid, String username) async {
    final u = await auth.authed('GET', '/v1/users/${Uri.encodeComponent(username.trim().replaceFirst('@', '').toLowerCase())}');
    _adopt(Conversation.fromJson((await auth.authed('POST', '/v1/conversations/$cid/members', body: {'userIds': [u!['id']]}))!));
  }

  Future<void> setRole(String cid, String userId, String role) async {
    _adopt(Conversation.fromJson((await auth.authed('PATCH', '/v1/conversations/$cid/members/$userId', body: {'role': role}))!));
  }

  Future<void> updateGroup(String cid, Map<String, dynamic> patch) async {
    _adopt(Conversation.fromJson((await auth.authed('PATCH', '/v1/conversations/$cid/group', body: patch))!));
  }

  /// Removes someone, or leaves when [userId] is this user.
  Future<void> removeFromGroup(String cid, String userId) async {
    await auth.authed('DELETE', '/v1/conversations/$cid/members/$userId');
    if (userId == me) {
      _forget(cid);
    } else {
      await _refreshOne(cid);
    }
    notifyListeners();
  }

  void _adopt(Conversation c) {
    conversations = [...conversations.where((x) => x.id != c.id), c];
    _sortList();
    notifyListeners();
  }

  void _forget(String cid) {
    conversations = conversations.where((c) => c.id != cid).toList();
    _loaded.remove(cid);
    _messages.remove(cid);
    if (activeId == cid) activeId = null;
  }

  /// Opens a chat (screens call this from initState, so it does not notify before its first await).
  Future<void> open(String cid) async {
    activeId = cid;
    if (_loaded.add(cid)) {
      final c = Conversation.fromJson((await auth.authed('GET', '/v1/conversations/$cid'))!);
      final page = (await auth.authed('GET', '/v1/conversations/$cid/messages?limit=50'))!;
      _synced[cid] = c.lastSeq;
      _upsert(cid, [for (final m in page['messages'] as List) ChatMessage.fromJson(m as Map<String, dynamic>)]);
      hasMore[cid] = page['hasMore'] as bool;
      conversations = [...conversations.where((x) => x.id != cid), c];
      _sortList();
      await _resync(cid);
    }
    _markRead(cid);
    notifyListeners();
  }

  void close(String cid) {
    if (activeId == cid) activeId = null;
  }

  Future<void> loadEarlier(String cid) async {
    final first = messagesFor(cid).where((m) => m.pending == Pending.none).firstOrNull;
    final page = (await auth.authed('GET', '/v1/conversations/$cid/messages?limit=50${first == null ? '' : '&before=${first.seq}'}'))!;
    _upsert(cid, [for (final m in page['messages'] as List) ChatMessage.fromJson(m as Map<String, dynamic>)]);
    hasMore[cid] = page['hasMore'] as bool;
    notifyListeners();
  }

  Future<void> sendText(String cid, String text) async {
    final body = text.trim();
    if (body.isEmpty) return;
    await _send(cid, {'kind': 'text', 'body': body});
  }

  Future<void> retry(ChatMessage m) async {
    _messages[m.conversationId]?.removeWhere((x) => x.id == m.id);
    await _send(m.conversationId, {'kind': m.kind, 'body': m.body ?? ''});
  }

  Future<void> _send(String cid, Map<String, dynamic> content) async {
    final clientId = newClientId();
    final local = ChatMessage(
      id: 'local-$clientId',
      conversationId: cid,
      seq: 0,
      changeSeq: 0,
      senderId: me,
      clientId: clientId,
      kind: content['kind'] as String,
      body: content['body'] as String?,
      createdAt: DateTime.now(),
      pending: Pending.sending,
    );
    _upsert(cid, [local]);
    notifyListeners();
    try {
      final ack = await rt.send(cid, {'clientId': clientId, ...content});
      _upsert(cid, [ChatMessage.fromJson(ack['message'] as Map<String, dynamic>)]);
    } on SendRejected catch (e) {
      lastError = e.message;
      _upsert(cid, [local.withPending(Pending.failed)]);
    }
    notifyListeners();
  }

  Future<void> react(ChatMessage m, String? emoji) => _mutate(() => auth.authed('PUT', '/v1/messages/${m.id}/reaction', body: {'emoji': emoji}));
  Future<void> edit(ChatMessage m, String body) => _mutate(() => auth.authed('PATCH', '/v1/messages/${m.id}', body: {'body': body}));
  Future<void> deleteForEveryone(ChatMessage m) => _mutate(() => auth.authed('DELETE', '/v1/messages/${m.id}'));
  Future<void> pin(ChatMessage m, bool pinned) => _mutate(() => auth.authed('PUT', '/v1/messages/${m.id}/pin', body: {'pinned': pinned}));

  Future<void> hideForMe(ChatMessage m) async {
    await auth.authed('POST', '/v1/messages/${m.id}/hide');
    _messages[m.conversationId]?.removeWhere((x) => x.id == m.id);
    notifyListeners();
  }

  Future<void> _mutate(Future<Map<String, dynamic>?> Function() call) async {
    final r = await call();
    if (r != null) {
      final m = ChatMessage.fromJson(r);
      _upsert(m.conversationId, [m]);
      notifyListeners();
    }
  }

  DateTime _lastTyping = DateTime(0);
  void typing(String cid, bool on) {
    if (on && DateTime.now().difference(_lastTyping) < const Duration(seconds: 2)) return;
    _lastTyping = on ? DateTime.now() : DateTime(0);
    rt.frame({'type': 'typing', 'conversationId': cid, 'typing': on});
  }

  // ------------------------------------------------------------------ sync

  void _upsert(String cid, List<ChatMessage> incoming, {List<String> remove = const []}) {
    final list = [...?_messages[cid]]..removeWhere((m) => remove.contains(m.id));
    for (final m in incoming) {
      final i = list.indexWhere((x) => x.id == m.id || (x.pending != Pending.none && x.clientId == m.clientId && x.senderId == m.senderId));
      if (i == -1) {
        list.add(m);
      } else if (list[i].pending != Pending.none || list[i].changeSeq <= m.changeSeq) {
        list[i] = m;
      }
    }
    int order(ChatMessage m) => m.pending == Pending.none ? m.seq : 1 << 52;
    list.sort((a, b) => order(a).compareTo(order(b)));
    _messages[cid] = list;
  }

  /// Applies every change since the last one this device saw.
  Future<void> _resync(String cid) async {
    if (!_resyncing.add(cid)) return;
    try {
      for (var guard = 0; guard < 50; guard++) {
        final page = (await auth.authed('GET', '/v1/conversations/$cid/changes?since=${_synced[cid] ?? 0}'))!;
        final changes = (page['changes'] as List).cast<Map<String, dynamic>>();
        _upsert(
          cid,
          [for (final c in changes.where((c) => c['hidden'] != true)) ChatMessage.fromJson(c)],
          remove: [for (final c in changes.where((c) => c['hidden'] == true)) c['id'] as String],
        );
        _synced[cid] = (page['nextSince'] as num).toInt();
        if (page['hasMore'] != true) break;
      }
    } finally {
      _resyncing.remove(cid);
    }
    notifyListeners();
  }

  void _onReady() {
    for (final cid in _loaded) {
      unawaited(_resync(cid));
    }
    unawaited(refreshList().catchError((_) {}));
    if (activeId != null) _markRead(activeId!);
  }

  void _markRead(String cid) {
    final last = messagesFor(cid).lastWhere((m) => m.pending == Pending.none && m.senderId != me, orElse: () => _none);
    if (identical(last, _none)) return;
    final mine = conversation(cid)?.member(me);
    if ((mine?.lastReadSeq ?? 0) >= last.seq) return;
    rt.frame({'type': 'receipt', 'conversationId': cid, 'kind': 'read', 'seq': last.seq});
  }

  void _onEvent(String type, Map<String, dynamic> d) {
    switch (type) {
      case 'message.created' || 'message.updated':
        final m = ChatMessage.fromJson(d);
        final cid = m.conversationId;
        if (_loaded.contains(cid)) {
          _upsert(cid, [m]);
          // The counter moves by one per change; a jump means something was missed.
          if (m.changeSeq > (_synced[cid] ?? 0) + 1) {
            unawaited(_resync(cid));
          } else if (m.changeSeq > (_synced[cid] ?? 0)) {
            _synced[cid] = m.changeSeq;
          }
        }
        if (type == 'message.created' && m.senderId != me) {
          _typingUntil.remove('$cid:${m.senderId}');
          rt.frame({'type': 'receipt', 'conversationId': cid, 'kind': activeId == cid ? 'read' : 'delivered', 'seq': m.seq});
        }
        unawaited(_refreshOne(cid));
      case 'message.hidden':
        final cid = d['conversationId'] as String;
        _upsert(cid, const [], remove: [d['id'] as String]);
      case 'receipt':
        final member = conversation(d['conversationId'] as String)?.member(d['userId'] as String);
        if (member != null) {
          member.lastDeliveredSeq = (d['lastDeliveredSeq'] as num).toInt();
          member.lastReadSeq = (d['lastReadSeq'] as num?)?.toInt();
        }
        if (d['userId'] == me && d['lastReadSeq'] != null) conversation(d['conversationId'] as String)?.unreadCount = 0;
      case 'typing':
        final key = '${d['conversationId']}:${d['userId']}';
        if (d['typing'] == true) {
          _typingUntil[key] = DateTime.now().add(const Duration(seconds: 6));
          Timer(const Duration(seconds: 6), notifyListeners);
        } else {
          _typingUntil.remove(key);
        }
      case 'conversation.updated' || 'conversation.changed':
        unawaited(_refreshOne(d['id'] as String));
      case 'conversation.removed':
        _forget(d['id'] as String);
    }
    notifyListeners();
  }

  @override
  void dispose() {
    rt.dispose();
    super.dispose();
  }
}

final _none = ChatMessage(id: '', conversationId: '', seq: 0, changeSeq: 0, senderId: '', clientId: '', kind: 'text', body: null, createdAt: DateTime(0));
