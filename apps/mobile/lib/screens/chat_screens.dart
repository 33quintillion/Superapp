import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../chat/chat_controller.dart';
import '../chat/chat_models.dart';
import '../chat/realtime.dart';
import '../theme/tokens.g.dart';

class ChatListScreen extends StatelessWidget {
  const ChatListScreen({super.key, required this.chat});
  final ChatController chat;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: chat,
        builder: (context, _) {
          final visible = chat.conversations.where((c) => !c.archived).toList();
          return Scaffold(
            appBar: AppBar(title: const Text('Chats'), actions: [_StatusChip(status: chat.status)]),
            floatingActionButton: FloatingActionButton(
              key: const Key('new-chat'),
              tooltip: 'New chat',
              onPressed: () => _newChat(context),
              child: const Icon(Icons.edit_outlined),
            ),
            body: visible.isEmpty
                ? const Center(child: Text('No chats yet. Start one with someone’s username.'))
                : ListView.separated(
                    itemCount: visible.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, i) {
                      final c = visible[i];
                      final peer = c.peer(chat.me);
                      return ListTile(
                        key: Key('conv-${peer?.username}'),
                        leading: CircleAvatar(child: Text(_initial(peer?.displayName))),
                        title: Text(peer?.displayName ?? 'Chat'),
                        subtitle: Text(c.lastMessage?.preview ?? 'No messages yet', maxLines: 1, overflow: TextOverflow.ellipsis),
                        trailing: c.unreadCount > 0 ? Badge(label: Text('${c.unreadCount}')) : null,
                        onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatScreen(chat: chat, conversationId: c.id))),
                      );
                    },
                  ),
          );
        },
      );

  Future<void> _newChat(BuildContext context) async {
    final ctrl = TextEditingController();
    final username = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New chat'),
        content: TextField(key: const Key('username'), controller: ctrl, autofocus: true, decoration: const InputDecoration(labelText: 'Username')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(key: const Key('open-chat'), onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Open')),
        ],
      ),
    );
    if (username == null || username.trim().isEmpty || !context.mounted) return;
    try {
      final id = await chat.openDirectByUsername(username);
      if (!context.mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatScreen(chat: chat, conversationId: id)));
    } on ApiException catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.status == 404 ? 'No one with that username' : e.message)));
    }
  }
}

String _initial(String? name) => (name == null || name.isEmpty) ? '?' : name.characters.first.toUpperCase();

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final ConnectionStatus status;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(right: NexaSpace.md),
        child: Center(
          child: Text(
            switch (status) {
              ConnectionStatus.online => 'Connected',
              ConnectionStatus.connecting => 'Connecting…',
              ConnectionStatus.offline => 'Offline',
            },
            key: const Key('connection'),
            style: Theme.of(context).textTheme.labelSmall,
          ),
        ),
      );
}

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.chat, required this.conversationId});
  final ChatController chat;
  final String conversationId;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _text = TextEditingController();
  Timer? _idle;

  ChatController get chat => widget.chat;
  String get cid => widget.conversationId;

  @override
  void initState() {
    super.initState();
    unawaited(chat.open(cid).catchError((Object e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }));
  }

  @override
  void dispose() {
    chat.close(cid);
    _idle?.cancel();
    _text.dispose();
    super.dispose();
  }

  void _onChanged(String _) {
    chat.typing(cid, true);
    _idle?.cancel();
    _idle = Timer(const Duration(seconds: 3), () => chat.typing(cid, false));
  }

  Future<void> _submit() async {
    final t = _text.text;
    if (t.trim().isEmpty) return;
    _text.clear();
    _idle?.cancel();
    chat.typing(cid, false);
    await chat.sendText(cid, t);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: chat,
        builder: (context, _) {
          final c = chat.conversation(cid);
          final peer = c?.peer(chat.me);
          final msgs = chat.messagesFor(cid);
          final typing = peer != null && chat.isTyping(cid, peer.userId);
          return Scaffold(
            appBar: AppBar(
              title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(peer?.displayName ?? 'Chat'),
                if (typing) Text('typing…', key: const Key('typing'), style: Theme.of(context).textTheme.labelSmall),
              ]),
              actions: [_StatusChip(status: chat.status)],
            ),
            body: Column(children: [
              Expanded(
                child: ListView.builder(
                  key: const Key('thread'),
                  reverse: true,
                  padding: const EdgeInsets.all(NexaSpace.md),
                  itemCount: msgs.length + ((chat.hasMore[cid] ?? false) ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i == msgs.length) {
                      return TextButton(onPressed: () => chat.loadEarlier(cid), child: const Text('Load earlier messages'));
                    }
                    final m = msgs[msgs.length - 1 - i];
                    return _Bubble(chat: chat, m: m, peerDelivered: peer?.lastDeliveredSeq ?? 0, peerRead: peer?.lastReadSeq);
                  },
                ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.all(NexaSpace.sm),
                  child: Row(children: [
                    Expanded(
                      child: TextField(
                        key: const Key('composer'),
                        controller: _text,
                        onChanged: _onChanged,
                        onSubmitted: (_) => _submit(),
                        maxLength: 4000,
                        decoration: const InputDecoration(hintText: 'Message', counterText: ''),
                      ),
                    ),
                    IconButton(key: const Key('send'), tooltip: 'Send', icon: const Icon(Icons.send), onPressed: _submit),
                  ]),
                ),
              ),
            ]),
          );
        },
      );
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.chat, required this.m, required this.peerDelivered, required this.peerRead});
  final ChatController chat;
  final ChatMessage m;
  final int peerDelivered;
  final int? peerRead;

  @override
  Widget build(BuildContext context) {
    final mine = m.senderId == chat.me;
    final scheme = Theme.of(context).colorScheme;
    final String? ticks = !mine
        ? null
        : switch (m.pending) {
            Pending.sending => 'Sending…',
            Pending.failed => 'Not sent',
            Pending.none => (peerRead ?? -1) >= m.seq ? 'Read' : (peerDelivered >= m.seq ? 'Delivered' : 'Sent'),
          };
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: m.pending == Pending.none && m.deletedAt == null ? () => _actions(context, mine) : null,
        onTap: m.pending == Pending.failed ? () => chat.retry(m) : null,
        child: Container(
          key: Key('msg-${m.clientId}'),
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
          margin: const EdgeInsets.symmetric(vertical: NexaSpace.xs),
          padding: const EdgeInsets.symmetric(horizontal: NexaSpace.md, vertical: NexaSpace.sm),
          decoration: BoxDecoration(color: mine ? scheme.primaryContainer : scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(NexaRadius.lg)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            if (m.forwarded) Text('Forwarded', style: Theme.of(context).textTheme.labelSmall),
            if (m.replyPreview != null) Text('↩ ${m.replyPreview}', style: Theme.of(context).textTheme.labelSmall),
            if (m.deletedAt != null)
              const Text('This message was deleted', style: TextStyle(fontStyle: FontStyle.italic))
            else ...[
              if (m.media != null) _MediaView(chat: chat, media: m.media!),
              if ((m.body ?? '').isNotEmpty) Text(m.body!),
            ],
            Row(mainAxisSize: MainAxisSize.min, children: [
              if (m.editedAt != null && m.deletedAt == null) Text('edited · ', style: Theme.of(context).textTheme.labelSmall),
              Text(TimeOfDay.fromDateTime(m.createdAt.toLocal()).format(context), style: Theme.of(context).textTheme.labelSmall),
              if (ticks != null) Text(' · $ticks', key: Key('ticks-${m.clientId}'), style: Theme.of(context).textTheme.labelSmall),
            ]),
            if (m.reactions.isNotEmpty) Text(m.reactions.map((r) => r.emoji).join(' '), key: Key('reactions-${m.clientId}')),
          ]),
        ),
      ),
    );
  }

  Future<void> _actions(BuildContext context, bool mine) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(children: [
          Padding(
            padding: const EdgeInsets.all(NexaSpace.md),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              for (final e in ['👍', '❤️', '😂', '😮']) TextButton(key: Key('react-$e'), onPressed: () => Navigator.pop(ctx, 'react:$e'), child: Text(e, style: const TextStyle(fontSize: 24))),
            ]),
          ),
          ListTile(leading: const Icon(Icons.push_pin_outlined), title: Text(m.pinnedAt == null ? 'Pin' : 'Unpin'), onTap: () => Navigator.pop(ctx, 'pin')),
          if (mine && m.kind == 'text') ListTile(leading: const Icon(Icons.edit_outlined), title: const Text('Edit'), onTap: () => Navigator.pop(ctx, 'edit')),
          if (mine) ListTile(leading: const Icon(Icons.delete_outline), title: const Text('Delete for everyone'), onTap: () => Navigator.pop(ctx, 'delete')),
          ListTile(leading: const Icon(Icons.visibility_off_outlined), title: const Text('Delete for me'), onTap: () => Navigator.pop(ctx, 'hide')),
        ]),
      ),
    );
    if (action == null || !context.mounted) return;
    try {
      if (action.startsWith('react:')) {
        final e = action.substring(6);
        final mineNow = m.reactions.where((r) => r.userId == chat.me).firstOrNull?.emoji;
        await chat.react(m, mineNow == e ? null : e);
      } else if (action == 'pin') {
        await chat.pin(m, m.pinnedAt == null);
      } else if (action == 'delete') {
        await chat.deleteForEveryone(m);
      } else if (action == 'hide') {
        await chat.hideForMe(m);
      } else if (action == 'edit') {
        final ctrl = TextEditingController(text: m.body);
        final body = await showDialog<String>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Edit message'),
            content: TextField(controller: ctrl, autofocus: true),
            actions: [FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Save'))],
          ),
        );
        if (body != null && body.trim().isNotEmpty) await chat.edit(m, body);
      }
    } on ApiException catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }
}

/// Fetches a short-lived download link, then shows images inline and other files as a tile.
class _MediaView extends StatefulWidget {
  const _MediaView({required this.chat, required this.media});
  final ChatController chat;
  final ChatMedia media;
  @override
  State<_MediaView> createState() => _MediaViewState();
}

class _MediaViewState extends State<_MediaView> {
  String? _url;

  @override
  void initState() {
    super.initState();
    if (widget.media.kind == 'image') {
      widget.chat.auth.authed('GET', '/v1/media/${widget.media.id}').then((r) {
        if (mounted) setState(() => _url = r?['url'] as String?);
      }).catchError((_) {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.media;
    if (m.kind == 'image') {
      return _url == null
          ? const SizedBox(width: 160, height: 120, child: Center(child: CircularProgressIndicator()))
          : ClipRRect(borderRadius: BorderRadius.circular(NexaRadius.md), child: Image.network(_url!, width: 220, fit: BoxFit.cover));
    }
    final label = m.kind == 'voice' ? 'Voice note${m.durationMs == null ? '' : ' (${(m.durationMs! / 1000).round()}s)'}' : (m.fileName.isEmpty ? m.kind : m.fileName);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(m.kind == 'voice' || m.kind == 'audio' ? Icons.mic_none : Icons.insert_drive_file_outlined),
      const SizedBox(width: NexaSpace.xs),
      Flexible(child: Text(label)),
    ]);
  }
}
