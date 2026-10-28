import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A message that was sent but not yet stored by the server.
class OutboxEntry {
  OutboxEntry({required this.conversationId, required this.clientId, required this.kind, required this.body, required this.createdAt});
  factory OutboxEntry.fromJson(Map<String, dynamic> j) => OutboxEntry(
        conversationId: j['conversationId'] as String,
        clientId: j['clientId'] as String,
        kind: j['kind'] as String,
        body: j['body'] as String?,
        createdAt: DateTime.parse(j['createdAt'] as String),
      );
  final String conversationId;

  /// Kept across restarts, so the server stores a re-sent message once.
  final String clientId;
  final String kind;
  final String? body;
  final DateTime createdAt;

  Map<String, dynamic> toJson() => {'conversationId': conversationId, 'clientId': clientId, 'kind': kind, 'body': body, 'createdAt': createdAt.toIso8601String()};
}

/// Keeps unsent messages across app restarts, per account. Cleared on sign-out.
abstract class OutboxStore {
  Future<List<OutboxEntry>> load(String userId);
  Future<void> save(String userId, List<OutboxEntry> entries);
}

/// In the platform keystore, like the session: unsent messages are private text.
class SecureOutboxStore implements OutboxStore {
  const SecureOutboxStore([this._storage = const FlutterSecureStorage()]);
  final FlutterSecureStorage _storage;
  String _key(String userId) => 'nexa.outbox.$userId';

  @override
  Future<List<OutboxEntry>> load(String userId) async {
    final raw = await _storage.read(key: _key(userId));
    if (raw == null) return [];
    try {
      return [for (final e in jsonDecode(raw) as List) OutboxEntry.fromJson(e as Map<String, dynamic>)];
    } on Object {
      // Unreadable (an older format, or damaged): start again rather than crash at launch.
      return [];
    }
  }

  @override
  Future<void> save(String userId, List<OutboxEntry> entries) =>
      entries.isEmpty ? _storage.delete(key: _key(userId)) : _storage.write(key: _key(userId), value: jsonEncode([for (final e in entries) e.toJson()]));
}

class MemoryOutboxStore implements OutboxStore {
  final saved = <String, List<OutboxEntry>>{};
  @override
  Future<List<OutboxEntry>> load(String userId) async => [...?saved[userId]];
  @override
  Future<void> save(String userId, List<OutboxEntry> entries) async => entries.isEmpty ? saved.remove(userId) : saved[userId] = [...entries];
}
