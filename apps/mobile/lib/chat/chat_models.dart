/// Messaging data as the API returns it. Messages are not end-to-end encrypted yet;
/// the server can read them (see docs/adr/0004-end-to-end-encryption.md).
library;

enum Pending { none, sending, failed }

class ChatMedia {
  ChatMedia({required this.id, required this.kind, required this.contentType, required this.byteSize, required this.fileName, this.durationMs});
  factory ChatMedia.fromJson(Map<String, dynamic> j) => ChatMedia(
        id: j['id'] as String,
        kind: j['kind'] as String,
        contentType: j['contentType'] as String,
        byteSize: (j['byteSize'] as num).toInt(),
        fileName: j['fileName'] as String? ?? '',
        durationMs: (j['durationMs'] as num?)?.toInt(),
      );
  final String id;
  final String kind;
  final String contentType;
  final int byteSize;
  final String fileName;
  final int? durationMs;
}

class Reaction {
  Reaction(this.userId, this.emoji);
  final String userId;
  final String emoji;
}

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.conversationId,
    required this.seq,
    required this.changeSeq,
    required this.senderId,
    required this.clientId,
    required this.kind,
    required this.body,
    required this.createdAt,
    this.media,
    this.replyPreview,
    this.forwarded = false,
    this.reactions = const [],
    this.editedAt,
    this.deletedAt,
    this.pinnedAt,
    this.pending = Pending.none,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> j) {
    final reply = j['replyTo'] as Map<String, dynamic>?;
    DateTime? date(String k) => j[k] == null ? null : DateTime.parse(j[k] as String);
    return ChatMessage(
      id: j['id'] as String,
      conversationId: j['conversationId'] as String,
      seq: (j['seq'] as num).toInt(),
      changeSeq: (j['changeSeq'] as num).toInt(),
      senderId: j['senderId'] as String,
      clientId: j['clientId'] as String,
      kind: j['kind'] as String,
      body: j['body'] as String?,
      media: j['media'] == null ? null : ChatMedia.fromJson(j['media'] as Map<String, dynamic>),
      replyPreview: reply == null ? null : (reply['deleted'] == true ? 'Message deleted' : reply['preview'] as String? ?? ''),
      forwarded: j['forwarded'] as bool? ?? false,
      reactions: [for (final r in (j['reactions'] as List? ?? const [])) Reaction(r['userId'] as String, r['emoji'] as String)],
      editedAt: date('editedAt'),
      deletedAt: date('deletedAt'),
      pinnedAt: date('pinnedAt'),
      createdAt: DateTime.parse(j['createdAt'] as String),
    );
  }

  final String id;
  final String conversationId;
  final int seq;
  final int changeSeq;
  final String senderId;
  final String clientId;
  final String kind;
  final String? body;
  final ChatMedia? media;
  final String? replyPreview;
  final bool forwarded;
  final List<Reaction> reactions;
  final DateTime? editedAt;
  final DateTime? deletedAt;
  final DateTime? pinnedAt;
  final DateTime createdAt;
  final Pending pending;

  ChatMessage withPending(Pending p) => ChatMessage(
        id: id,
        conversationId: conversationId,
        seq: seq,
        changeSeq: changeSeq,
        senderId: senderId,
        clientId: clientId,
        kind: kind,
        body: body,
        createdAt: createdAt,
        media: media,
        replyPreview: replyPreview,
        forwarded: forwarded,
        reactions: reactions,
        editedAt: editedAt,
        deletedAt: deletedAt,
        pinnedAt: pinnedAt,
        pending: p,
      );

  String get preview {
    if (deletedAt != null) return 'Message deleted';
    if (kind == 'text') return body ?? '';
    const labels = {'image': '📷 Photo', 'video': '🎬 Video', 'audio': '🎵 Audio', 'voice': '🎤 Voice note', 'file': '📄 File'};
    return '${labels[kind] ?? kind}${(body ?? '').isEmpty ? '' : ' $body'}';
  }
}

class ChatMember {
  ChatMember({required this.userId, required this.username, required this.displayName, required this.lastDeliveredSeq, this.lastReadSeq});
  factory ChatMember.fromJson(Map<String, dynamic> j) => ChatMember(
        userId: j['userId'] as String,
        username: j['username'] as String?,
        displayName: j['displayName'] as String? ?? '',
        lastDeliveredSeq: (j['lastDeliveredSeq'] as num).toInt(),
        lastReadSeq: (j['lastReadSeq'] as num?)?.toInt(),
      );
  final String userId;
  final String? username;
  final String displayName;
  int lastDeliveredSeq;
  /// Null when read receipts are switched off on either side.
  int? lastReadSeq;
}

class Conversation {
  Conversation({
    required this.id,
    required this.lastSeq,
    required this.unreadCount,
    required this.members,
    this.lastMessage,
    this.lastMessageAt,
    this.archived = false,
    this.mutedUntil,
  });
  factory Conversation.fromJson(Map<String, dynamic> j) => Conversation(
        id: j['id'] as String,
        lastSeq: (j['lastSeq'] as num).toInt(),
        unreadCount: (j['unreadCount'] as num).toInt(),
        members: [for (final m in j['members'] as List) ChatMember.fromJson(m as Map<String, dynamic>)],
        lastMessage: j['lastMessage'] == null ? null : ChatMessage.fromJson(j['lastMessage'] as Map<String, dynamic>),
        lastMessageAt: j['lastMessageAt'] == null ? null : DateTime.parse(j['lastMessageAt'] as String),
        archived: j['archived'] as bool? ?? false,
        mutedUntil: j['mutedUntil'] == null ? null : DateTime.parse(j['mutedUntil'] as String),
      );

  final String id;
  final int lastSeq;
  int unreadCount;
  final List<ChatMember> members;
  final ChatMessage? lastMessage;
  final DateTime? lastMessageAt;
  final bool archived;
  final DateTime? mutedUntil;

  ChatMember? peer(String me) => members.where((m) => m.userId != me).firstOrNull;
  ChatMember? member(String id) => members.where((m) => m.userId == id).firstOrNull;
}
