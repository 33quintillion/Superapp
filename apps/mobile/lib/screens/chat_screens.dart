import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../chat/chat_controller.dart';
import '../chat/chat_models.dart';
import '../chat/realtime.dart';
import '../media/media.dart';
import '../theme/tokens.g.dart';
import 'business_screens.dart' show openInBrowser;
import 'call_screens.dart';

class ChatListScreen extends StatelessWidget {
  const ChatListScreen({super.key, required this.chat});
  final ChatController chat;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: chat,
        builder: (context, _) {
          final visible = chat.conversations.where((c) => !c.archived).toList();
          return Scaffold(
            appBar: AppBar(title: const Text('Chats'), actions: [
              IconButton(key: const Key('new-group'), tooltip: 'New group', icon: const Icon(Icons.group_add_outlined), onPressed: () => _newGroup(context)),
              _StatusChip(status: chat.status),
            ]),
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
                        key: c.isGroup ? ValueKey('conv-${c.id}') : Key('conv-${peer?.username}'),
                        leading: CircleAvatar(child: c.isGroup ? const Icon(Icons.group_outlined) : Text(_initial(peer?.displayName))),
                        title: Text(c.titleFor(chat.me)),
                        subtitle: Text(c.previewFor(chat.me), maxLines: 1, overflow: TextOverflow.ellipsis),
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

  Future<void> _newGroup(BuildContext context) async {
    final title = TextEditingController();
    final people = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New group'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(key: const Key('group-title'), controller: title, autofocus: true, maxLength: 100, decoration: const InputDecoration(labelText: 'Group name')),
          TextField(key: const Key('group-members'), controller: people, decoration: const InputDecoration(labelText: 'Usernames, separated by commas')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(key: const Key('create-group'), onPressed: () => Navigator.pop(ctx, true), child: const Text('Create')),
        ],
      ),
    );
    if (ok != true || title.text.trim().isEmpty || !context.mounted) return;
    final usernames = people.text.split(RegExp(r'[\s,]+')).where((u) => u.isNotEmpty).toList();
    try {
      final id = await chat.createGroup(title.text, usernames);
      if (!context.mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatScreen(chat: chat, conversationId: id)));
    } on ApiException catch (e) {
      if (!context.mounted) return;
      final text = e.status == 404 ? 'One of those usernames doesn’t exist' : (e.code == 'cannot_add' ? 'Some of those people don’t allow you to add them to groups' : e.message);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
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
  VoiceRecording? _recording;
  bool _busy = false;
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
    unawaited(_recording?.cancel());
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

  Future<void> _upload(Future<void> Function() work) async {
    setState(() => _busy = true);
    try {
      await work();
    } on Exception catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(uploadError(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendPhoto() => _upload(() async {
        final picked = await MediaDevices.instance.pickPhotos();
        if (picked.isEmpty) return;
        await chat.sendMedia(cid, picked.single, kind: 'image', caption: _text.text);
        _text.clear();
      });

  Future<void> _startVoice() async {
    try {
      final r = await MediaDevices.instance.startVoice();
      if (r == null) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Allow the microphone in your phone’s settings to record voice notes.')));
        return;
      }
      if (mounted) setState(() => _recording = r);
    } on Exception catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(uploadError(e))));
    }
  }

  Future<void> _cancelVoice() async {
    final r = _recording;
    setState(() => _recording = null);
    await r?.cancel();
  }

  Future<void> _sendVoice() async {
    final r = _recording;
    setState(() => _recording = null);
    if (r == null) return;
    await _upload(() async {
      final note = await r.stop();
      if (note == null) return;
      await chat.sendMedia(cid, note, kind: 'voice');
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: chat,
        builder: (context, _) {
          final c = chat.conversation(cid);
          final peer = c?.peer(chat.me);
          final msgs = chat.messagesFor(cid);
          final typing = c != null && c.members.any((m) => m.userId != chat.me && chat.isTyping(cid, m.userId));
          final canSend = c?.group?.canSend ?? true;
          return Scaffold(
            appBar: AppBar(
              title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(c?.titleFor(chat.me) ?? 'Chat'),
                if (typing)
                  Text('typing…', key: const Key('typing'), style: Theme.of(context).textTheme.labelSmall)
                else if (c?.isGroup ?? false)
                  Text('${c!.members.length} members', style: Theme.of(context).textTheme.labelSmall),
              ]),
              actions: [
                if (c != null) ...callActions(context, chat, c),
                if (c?.isGroup ?? false)
                  IconButton(
                    key: const Key('group-info'),
                    tooltip: 'Group info',
                    icon: const Icon(Icons.info_outline),
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => GroupInfoScreen(chat: chat, conversationId: cid))),
                  ),
                _StatusChip(status: chat.status),
              ],
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
                    if (m.kind == 'system') {
                      return Center(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: NexaSpace.xs),
                          child: Text(
                            m.system == null || c == null ? 'Group updated' : describeSystem(m.system!, m.senderId, chat.me, c.nameOf),
                            key: Key('system-${m.id}'),
                            style: Theme.of(context).textTheme.labelSmall,
                            textAlign: TextAlign.center,
                          ),
                        ),
                      );
                    }
                    final prev = i + 1 < msgs.length ? msgs[msgs.length - 2 - i] : null;
                    final others = c?.members.where((x) => x.userId != chat.me).toList() ?? const <ChatMember>[];
                    // In groups a message counts as delivered or read once everyone has it.
                    final delivered = c?.isGroup ?? false ? others.fold<int>(1 << 52, (n, x) => x.lastDeliveredSeq < n ? x.lastDeliveredSeq : n) : peer?.lastDeliveredSeq ?? 0;
                    final read = c?.isGroup ?? false
                        ? (others.any((x) => x.lastReadSeq != null) ? others.fold<int>(1 << 52, (n, x) => x.lastReadSeq != null && x.lastReadSeq! < n ? x.lastReadSeq! : n) : null)
                        : peer?.lastReadSeq;
                    return _Bubble(
                      chat: chat,
                      m: m,
                      peerDelivered: delivered,
                      peerRead: read,
                      senderName: (c?.isGroup ?? false) && m.senderId != chat.me && prev?.senderId != m.senderId ? c!.nameOf(m.senderId) : null,
                    );
                  },
                ),
              ),
              if (!canSend)
                const SafeArea(
                  top: false,
                  child: Padding(
                    padding: EdgeInsets.all(NexaSpace.md),
                    child: Text('Only admins can send messages in this group.', key: Key('admins-only')),
                  ),
                )
              else
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.all(NexaSpace.sm),
                  child: _recording != null
                      ? Row(key: const Key('recording'), children: [
                          const Icon(Icons.fiber_manual_record, color: Colors.red),
                          const SizedBox(width: NexaSpace.sm),
                          const Expanded(child: Text('Recording a voice note…')),
                          TextButton(key: const Key('cancel-voice'), onPressed: _cancelVoice, child: const Text('Cancel')),
                          IconButton(key: const Key('send-voice'), tooltip: 'Send voice note', icon: const Icon(Icons.send), onPressed: _sendVoice),
                        ])
                      : Row(children: [
                    IconButton(key: const Key('attach-photo'), tooltip: 'Send a photo', icon: const Icon(Icons.photo_outlined), onPressed: _busy ? null : _sendPhoto),
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
                    if (_busy)
                      const Padding(padding: EdgeInsets.all(NexaSpace.md), child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
                    else
                      IconButton(key: const Key('record-voice'), tooltip: 'Record a voice note', icon: const Icon(Icons.mic_none), onPressed: _startVoice),
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
  const _Bubble({required this.chat, required this.m, required this.peerDelivered, required this.peerRead, this.senderName});
  final ChatController chat;
  final ChatMessage m;
  final int peerDelivered;
  final int? peerRead;
  final String? senderName;

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
            if (senderName != null) Text(senderName!, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: scheme.primary)),
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
          : ClipRRect(borderRadius: BorderRadius.circular(NexaRadius.md), child: Image.network(_url!, width: 220, fit: BoxFit.cover, semanticLabel: 'Photo', errorBuilder: (_, _, _) => const SizedBox(width: 160, height: 48, child: Center(child: Text('Photo not available')))));
    }
    final label = m.kind == 'voice' ? 'Voice note${m.durationMs == null ? '' : ' (${(m.durationMs! / 1000).round()}s)'}' : (m.fileName.isEmpty ? m.kind : m.fileName);
    // Voice notes and files open in the phone's own player or viewer, from a short-lived link.
    return InkWell(
      key: Key('open-media-${m.id}'),
      onTap: () async {
        try {
          final r = await widget.chat.auth.authed('GET', '/v1/media/${m.id}');
          await openInBrowser(Uri.parse(r!['url'] as String));
        } on Exception catch (e) {
          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(uploadError(e))));
        }
      },
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(m.kind == 'voice' || m.kind == 'audio' ? Icons.play_circle_outline : Icons.insert_drive_file_outlined),
          const SizedBox(width: NexaSpace.xs),
          Flexible(child: Text(label)),
        ]),
      ),
    );
  }
}

/// Members, roles and settings. Actions are offered only where the server will allow them.
class GroupInfoScreen extends StatelessWidget {
  const GroupInfoScreen({super.key, required this.chat, required this.conversationId});
  final ChatController chat;
  final String conversationId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: chat,
        builder: (context, _) {
          final c = chat.conversation(conversationId);
          final g = c?.group;
          if (c == null || g == null) return const Scaffold(body: Center(child: Text('You’re no longer in this group.')));
          Future<void> run(Future<void> Function() fn) async {
            try {
              await fn();
            } on ApiException catch (e) {
              if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
            }
          }

          return Scaffold(
            appBar: AppBar(title: Text(c.titleFor(chat.me))),
            body: ListView(children: [
              if (g.description.isNotEmpty) ListTile(title: Text(g.description)),
              if (g.isAdmin)
                SwitchListTile(
                  key: const Key('admins-only-switch'),
                  title: const Text('Only admins can send'),
                  value: g.sendPolicy == 'admins',
                  onChanged: (v) => run(() => chat.updateGroup(c.id, {'sendPolicy': v ? 'admins' : 'everyone'})),
                ),
              if (g.isAdmin)
                SwitchListTile(
                  title: const Text('Anyone can add people'),
                  value: g.addPolicy == 'everyone',
                  onChanged: (v) => run(() => chat.updateGroup(c.id, {'addPolicy': v ? 'everyone' : 'admins'})),
                ),
              if (g.canAdd)
                ListTile(
                  key: const Key('add-member'),
                  leading: const Icon(Icons.person_add_alt),
                  title: const Text('Add people'),
                  onTap: () async {
                    final ctrl = TextEditingController();
                    final name = await showDialog<String>(
                      context: context,
                      builder: (ctx) => AlertDialog(
                        title: const Text('Add to group'),
                        content: TextField(key: const Key('add-username'), controller: ctrl, autofocus: true, decoration: const InputDecoration(labelText: 'Username')),
                        actions: [FilledButton(key: const Key('add-confirm'), onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Add'))],
                      ),
                    );
                    if (name != null && name.trim().isNotEmpty) await run(() => chat.addToGroup(c.id, name));
                  },
                ),
              const Divider(),
              for (final m in c.members)
                ListTile(
                  key: Key('member-${m.userId}'),
                  title: Text(m.userId == chat.me ? 'You' : m.displayName),
                  subtitle: m.role == 'member' ? null : Text(m.role == 'owner' ? 'Owner' : 'Admin'),
                  trailing: m.userId == chat.me
                      ? null
                      : PopupMenuButton<String>(
                          onSelected: (a) => run(() => a == 'remove' ? chat.removeFromGroup(c.id, m.userId) : chat.setRole(c.id, m.userId, a)),
                          itemBuilder: (_) => [
                            if (g.isAdmin && m.role == 'member') const PopupMenuItem(value: 'admin', child: Text('Make admin')),
                            if (g.myRole == 'owner' && m.role == 'admin') const PopupMenuItem(value: 'member', child: Text('Remove admin')),
                            if (m.role != 'owner' && (g.myRole == 'owner' || (g.myRole == 'admin' && m.role == 'member')))
                              const PopupMenuItem(value: 'remove', child: Text('Remove from group')),
                          ],
                        ),
                ),
              const Divider(),
              ListTile(
                key: const Key('leave-group'),
                leading: Icon(Icons.logout, color: Theme.of(context).colorScheme.error),
                title: Text('Leave group', style: TextStyle(color: Theme.of(context).colorScheme.error)),
                onTap: () async {
                  await run(() => chat.removeFromGroup(c.id, chat.me));
                  if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
                },
              ),
            ]),
          );
        },
      );
}
