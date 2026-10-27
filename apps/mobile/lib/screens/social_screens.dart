import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../auth/auth_controller.dart';
import '../chat/realtime.dart' show newClientId;
import '../social/social_models.dart';
import '../theme/tokens.g.dart';

Color _storyColour(String hex) => Color(int.parse('FF${hex.substring(1)}', radix: 16));

void _snack(BuildContext context, Object e) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : '$e')));
}

/// Stories from you and the people you follow, a composer, and the home feed.
class FeedScreen extends StatefulWidget {
  const FeedScreen({super.key, required this.auth});
  final AuthController auth;

  @override
  State<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<FeedScreen> {
  List<StoryGroup> _stories = [];

  AuthController get auth => widget.auth;

  @override
  void initState() {
    super.initState();
    unawaited(_loadStories());
  }

  Future<void> _loadStories() async {
    try {
      final r = await auth.authed('GET', '/v1/stories');
      if (mounted) setState(() => _stories = [for (final g in r!['groups'] as List) StoryGroup.fromJson(g as Map<String, dynamic>)]);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  final _feedKey = GlobalKey<_PostListState>();

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Feed')),
        floatingActionButton: FloatingActionButton(
          key: const Key('compose-post'),
          tooltip: 'New post',
          onPressed: () async {
            final posted = await Navigator.of(context).push<Post>(MaterialPageRoute(builder: (_) => ComposePostScreen(auth: auth)));
            if (posted != null) _feedKey.currentState?.prepend(posted);
          },
          child: const Icon(Icons.edit_outlined),
        ),
        body: PostList(
          key: _feedKey,
          auth: auth,
          path: '/v1/feed',
          empty: 'Nothing here yet. Follow people or join a community to fill your feed.',
          header: SizedBox(
            height: 88,
            child: ListView(
              key: const Key('story-tray'),
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.all(NexaSpace.sm),
              children: [
                _StoryRing(label: '+', seen: false, onTap: _addStory, tooltip: 'Add to your story'),
                for (final g in _stories)
                  _StoryRing(
                    key: Key('story-${g.author.id}'),
                    label: g.author.id == auth.profile!.id ? 'You' : g.author.displayName,
                    seen: g.allViewed,
                    onTap: () async {
                      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => StoryViewer(auth: auth, group: g)));
                      await _loadStories();
                    },
                  ),
              ],
            ),
          ),
        ),
      );

  Future<void> _addStory() async {
    final ctrl = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Your story'),
        content: TextField(key: const Key('story-text'), controller: ctrl, autofocus: true, maxLength: 500, decoration: const InputDecoration(helperText: 'Visible to your followers for 24 hours')),
        actions: [FilledButton(key: const Key('share-story'), onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Share'))],
      ),
    );
    if (text == null || text.trim().isEmpty) return;
    try {
      await auth.authed('POST', '/v1/stories', body: {'kind': 'text', 'body': text.trim()});
      await _loadStories();
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }
}

class _StoryRing extends StatelessWidget {
  const _StoryRing({super.key, required this.label, required this.seen, required this.onTap, this.tooltip});
  final String label;
  final bool seen;
  final VoidCallback onTap;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: NexaSpace.xs),
      child: Tooltip(
        message: tooltip ?? label,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Container(
            width: 64,
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: seen ? scheme.outlineVariant : scheme.primary, width: 3)),
            alignment: Alignment.center,
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.labelSmall),
          ),
        ),
      ),
    );
  }
}

/// Shows one person's stories in turn and records each as seen.
class StoryViewer extends StatefulWidget {
  const StoryViewer({super.key, required this.auth, required this.group});
  final AuthController auth;
  final StoryGroup group;

  @override
  State<StoryViewer> createState() => _StoryViewerState();
}

class _StoryViewerState extends State<StoryViewer> {
  int _i = 0;

  @override
  void initState() {
    super.initState();
    _markSeen();
  }

  void _markSeen() {
    final s = widget.group.stories[_i];
    if (s.author.id != widget.auth.profile!.id && !s.viewed) unawaited(widget.auth.authed('POST', '/v1/stories/${s.id}/views').catchError((_) => null));
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.group.stories[_i];
    return Scaffold(
      backgroundColor: s.kind == 'text' ? _storyColour(s.background) : Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        foregroundColor: Colors.white,
        title: Text(s.author.displayName),
        actions: [if (s.viewCount != null) Center(child: Padding(padding: const EdgeInsets.all(NexaSpace.md), child: Text('${s.viewCount} views', key: const Key('story-views'))))],
      ),
      body: GestureDetector(
        onTap: () {
          if (_i + 1 < widget.group.stories.length) {
            setState(() => _i += 1);
            _markSeen();
          } else {
            Navigator.pop(context);
          }
        },
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(NexaSpace.xl),
            child: Text(
              s.kind == 'text' ? s.body : (s.body.isEmpty ? 'Photo story: open on the web to view' : s.body),
              key: const Key('story-body'),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: Colors.white),
            ),
          ),
        ),
      ),
    );
  }
}

/// A paged list of posts from one API path: the home feed, a person, or a community.
class PostList extends StatefulWidget {
  const PostList({super.key, required this.auth, required this.path, required this.empty, this.header});
  final AuthController auth;
  final String path;
  final String empty;
  final Widget? header;

  @override
  State<PostList> createState() => _PostListState();
}

class _PostListState extends State<PostList> {
  List<Post>? _posts;
  String? _next;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  void prepend(Post p) => setState(() => _posts = [p, ...?_posts]);

  Future<void> _load({String? cursor}) async {
    try {
      final r = await widget.auth.authed('GET', '${widget.path}${cursor == null ? '' : '?cursor=$cursor'}');
      final page = [for (final p in r!['posts'] as List) Post.fromJson(p as Map<String, dynamic>)];
      if (!mounted) return;
      setState(() {
        _posts = cursor == null ? page : [...?_posts, ...page];
        _next = r['nextCursor'] as String?;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.status == 404 ? 'Not available.' : e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final posts = _posts;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        key: const Key('post-list'),
        children: [
          ?widget.header,
          if (posts == null) Padding(padding: const EdgeInsets.all(NexaSpace.lg), child: Text(_error ?? 'Loading…')),
          if (posts != null && posts.isEmpty) Padding(padding: const EdgeInsets.all(NexaSpace.lg), child: Text(widget.empty)),
          for (final p in posts ?? const <Post>[])
            PostTile(
              key: Key('post-${p.id}'),
              auth: widget.auth,
              post: p,
              onDeleted: () => setState(() => _posts = posts!.where((x) => x.id != p.id).toList()),
            ),
          if (_next != null) TextButton(onPressed: () => _load(cursor: _next), child: const Text('Show older posts')),
        ],
      ),
    );
  }
}

class PostTile extends StatefulWidget {
  const PostTile({super.key, required this.auth, required this.post, required this.onDeleted});
  final AuthController auth;
  final Post post;
  final VoidCallback onDeleted;

  @override
  State<PostTile> createState() => _PostTileState();
}

class _PostTileState extends State<PostTile> {
  Post get p => widget.post;

  Future<void> _like() async {
    try {
      final r = await widget.auth.authed('PUT', '/v1/posts/${p.id}/like', body: {'liked': !p.liked});
      setState(() {
        p.liked = r!['liked'] as bool;
        p.likeCount = (r['likeCount'] as num).toInt();
      });
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final mine = p.author.id == widget.auth.profile!.id;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: NexaSpace.md, vertical: NexaSpace.xs),
      child: Padding(
        padding: const EdgeInsets.all(NexaSpace.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(
            [p.author.displayName, if (p.communityName != null) 'in ${p.communityName}', if (p.communityName == null) audienceLabels[p.audience] ?? ''].join(' · '),
            style: text.labelMedium,
          ),
          if (p.removedReason != null)
            Text('Removed by moderators${p.removedReason!.isEmpty ? '' : ': ${p.removedReason}'}. Only you can see it.', key: const Key('post-removed'), style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.error)),
          if (p.body.isNotEmpty) Padding(padding: const EdgeInsets.only(top: NexaSpace.xs), child: Text(p.body)),
          if (p.mediaCount > 0) Text('📷 ${p.mediaCount} photo${p.mediaCount == 1 ? '' : 's'}', style: text.labelSmall),
          if (p.shared != null || p.sharedUnavailable)
            Container(
              margin: const EdgeInsets.only(top: NexaSpace.xs),
              padding: const EdgeInsets.all(NexaSpace.sm),
              decoration: BoxDecoration(border: Border.all(color: Theme.of(context).colorScheme.outlineVariant), borderRadius: BorderRadius.circular(NexaRadius.md)),
              child: Text(p.shared == null ? 'This post isn’t available to you.' : '${p.shared!.author.displayName}: ${p.shared!.body}'),
            ),
          Row(children: [
            TextButton.icon(
              key: Key('like-${p.id}'),
              onPressed: _like,
              icon: Icon(p.liked ? Icons.favorite : Icons.favorite_border),
              label: Text('${p.likeCount}'),
            ),
            TextButton.icon(
              key: Key('comments-${p.id}'),
              onPressed: () async {
                await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CommentsScreen(auth: widget.auth, post: p)));
                if (mounted) setState(() {});
              },
              icon: const Icon(Icons.mode_comment_outlined),
              label: Text('${p.commentCount}'),
            ),
            const Spacer(),
            if (mine)
              IconButton(
                key: Key('delete-${p.id}'),
                tooltip: 'Delete',
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  try {
                    await widget.auth.authed('DELETE', '/v1/posts/${p.id}');
                    widget.onDeleted();
                  } on ApiException catch (e) {
                    if (context.mounted) _snack(context, e);
                  }
                },
              )
            else
              IconButton(
                tooltip: 'Report',
                icon: const Icon(Icons.flag_outlined),
                onPressed: () async {
                  try {
                    await widget.auth.authed('POST', '/v1/reports', body: {'subjectType': 'post', 'subjectId': p.id, 'reason': 'other'});
                    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Thanks, we’ll review it.')));
                  } on ApiException catch (e) {
                    if (context.mounted) _snack(context, e);
                  }
                },
              ),
          ]),
        ]),
      ),
    );
  }
}

class ComposePostScreen extends StatefulWidget {
  const ComposePostScreen({super.key, required this.auth, this.communityId});
  final AuthController auth;
  final String? communityId;

  @override
  State<ComposePostScreen> createState() => _ComposePostScreenState();
}

class _ComposePostScreenState extends State<ComposePostScreen> {
  final _text = TextEditingController();
  String _audience = 'public';
  bool _busy = false;
  // Kept across retries so a resend after a lost response doesn't post twice.
  final _clientId = newClientId();

  Future<void> _post() async {
    if (_text.text.trim().isEmpty) return;
    setState(() => _busy = true);
    try {
      final r = await widget.auth.authed('POST', '/v1/posts', body: {
        'clientId': _clientId,
        'body': _text.text,
        if (widget.communityId != null) 'communityId': widget.communityId else 'audience': _audience,
      });
      if (mounted) Navigator.pop(context, Post.fromJson(r!['post'] as Map<String, dynamic>));
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        _snack(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('New post'), actions: [
          TextButton(key: const Key('publish-post'), onPressed: _busy ? null : _post, child: const Text('Post')),
        ]),
        body: Padding(
          padding: const EdgeInsets.all(NexaSpace.lg),
          child: Column(children: [
            TextField(key: const Key('post-text'), controller: _text, autofocus: true, maxLines: 6, maxLength: 5000, decoration: const InputDecoration(hintText: 'What’s on your mind?')),
            if (widget.communityId == null)
              DropdownButtonFormField<String>(
                key: const Key('audience'),
                initialValue: _audience,
                decoration: const InputDecoration(labelText: 'Who can see this'),
                items: [for (final e in audienceLabels.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
                onChanged: (v) => setState(() => _audience = v ?? 'public'),
              ),
          ]),
        ),
      );
}

class CommentsScreen extends StatefulWidget {
  const CommentsScreen({super.key, required this.auth, required this.post});
  final AuthController auth;
  final Post post;

  @override
  State<CommentsScreen> createState() => _CommentsScreenState();
}

class _CommentsScreenState extends State<CommentsScreen> {
  List<Map<String, dynamic>>? _comments;
  final _text = TextEditingController();

  @override
  void initState() {
    super.initState();
    widget.auth.authed('GET', '/v1/posts/${widget.post.id}/comments').then((r) {
      if (mounted) setState(() => _comments = (r!['comments'] as List).cast<Map<String, dynamic>>());
    }).catchError((Object e) {
      if (mounted) _snack(context, e);
    });
  }

  Future<void> _send() async {
    if (_text.text.trim().isEmpty) return;
    try {
      final c = await widget.auth.authed('POST', '/v1/posts/${widget.post.id}/comments', body: {'body': _text.text});
      _text.clear();
      widget.post.commentCount += 1;
      setState(() => _comments = [...?_comments, c!]);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Comments')),
        body: Column(children: [
          Expanded(
            child: ListView(children: [
              for (final c in _comments ?? const <Map<String, dynamic>>[])
                ListTile(title: Text(c['body'] as String), subtitle: Text((c['author'] as Map)['displayName'] as String)),
            ]),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(NexaSpace.sm),
              child: Row(children: [
                Expanded(child: TextField(key: const Key('comment-text'), controller: _text, maxLength: 2000, decoration: const InputDecoration(hintText: 'Write a comment', counterText: ''))),
                IconButton(key: const Key('send-comment'), icon: const Icon(Icons.send), onPressed: _send),
              ]),
            ),
          ),
        ]),
      );
}

/// Communities you belong to, and search to find others.
class CommunitiesScreen extends StatefulWidget {
  const CommunitiesScreen({super.key, required this.auth});
  final AuthController auth;

  @override
  State<CommunitiesScreen> createState() => _CommunitiesScreenState();
}

class _CommunitiesScreenState extends State<CommunitiesScreen> {
  List<Community> _list = [];
  final _q = TextEditingController();

  @override
  void initState() {
    super.initState();
    unawaited(_search(''));
  }

  Future<void> _search(String q) async {
    try {
      final r = await widget.auth.authed('GET', '/v1/communities${q.trim().isEmpty ? '' : '?q=${Uri.encodeQueryComponent(q.trim())}'}');
      if (mounted) setState(() => _list = [for (final c in r!['communities'] as List) Community.fromJson(c as Map<String, dynamic>)]);
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Communities')),
        body: ListView(children: [
          Padding(
            padding: const EdgeInsets.all(NexaSpace.md),
            child: TextField(
              key: const Key('community-search'),
              controller: _q,
              textInputAction: TextInputAction.search,
              onSubmitted: _search,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Find communities and channels'),
            ),
          ),
          if (_list.isEmpty) const Padding(padding: EdgeInsets.all(NexaSpace.lg), child: Text('Nothing to show. Search, or join one on the web.')),
          for (final c in _list)
            ListTile(
              key: Key('community-${c.slug}'),
              title: Text(c.name),
              subtitle: Text([
                c.kind == 'channel' ? 'Channel' : 'Community',
                if (c.visibility == 'private') 'Private',
                '${c.memberCount} ${c.kind == 'channel' ? 'followers' : 'members'}',
                if (c.state == 'pending') 'Requested',
              ].join(' · ')),
              onTap: () async {
                await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CommunityScreen(auth: widget.auth, initial: c)));
                await _search(_q.text);
              },
            ),
        ]),
      );
}

class CommunityScreen extends StatefulWidget {
  const CommunityScreen({super.key, required this.auth, required this.initial});
  final AuthController auth;
  final Community initial;

  @override
  State<CommunityScreen> createState() => _CommunityScreenState();
}

class _CommunityScreenState extends State<CommunityScreen> {
  late Community c = widget.initial;
  final _posts = GlobalKey<_PostListState>();

  Future<void> _join() async {
    try {
      final r = await widget.auth.authed('POST', '/v1/communities/${c.id}/join');
      setState(() => c = Community.fromJson(r!));
    } on ApiException catch (e) {
      if (mounted) _snack(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canRead = c.visibility == 'public' || c.isMember;
    return Scaffold(
      appBar: AppBar(title: Text(c.name)),
      floatingActionButton: c.canPost
          ? FloatingActionButton(
              key: const Key('compose-community-post'),
              tooltip: 'New post',
              onPressed: () async {
                final p = await Navigator.of(context).push<Post>(MaterialPageRoute(builder: (_) => ComposePostScreen(auth: widget.auth, communityId: c.id)));
                if (p != null) _posts.currentState?.prepend(p);
              },
              child: const Icon(Icons.edit_outlined),
            )
          : null,
      body: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        ListTile(
          title: Text(c.description.isEmpty ? '/${c.slug}' : c.description),
          subtitle: Text('${c.memberCount} ${c.kind == 'channel' ? 'followers' : 'members'}${c.isMember ? ' · You: ${c.role}' : ''}', key: const Key('community-meta')),
        ),
        // Full-width buttons come from the theme, so the action sits below the details rather than in a ListTile's trailing slot.
        if (c.state == null)
          Padding(
            padding: const EdgeInsets.fromLTRB(NexaSpace.lg, 0, NexaSpace.lg, NexaSpace.md),
            child: FilledButton(key: const Key('join'), onPressed: _join, child: Text(c.visibility == 'private' ? 'Ask to join' : (c.kind == 'channel' ? 'Follow' : 'Join'))),
          )
        else if (c.state == 'pending')
          const Padding(
            padding: EdgeInsets.fromLTRB(NexaSpace.lg, 0, NexaSpace.lg, NexaSpace.md),
            child: Text('Requested. A moderator needs to approve you.', key: Key('join-pending')),
          ),
        const Divider(height: 1),
        Expanded(
          child: canRead
              ? PostList(key: _posts, auth: widget.auth, path: '/v1/communities/${c.id}/posts', empty: 'No posts yet.')
              : const Center(child: Text('Posts are visible to members only.')),
        ),
      ]),
    );
  }
}
