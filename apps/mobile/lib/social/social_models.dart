/// Feed, stories and communities as the API returns them. Who can see what is decided by
/// the server; the app only shows what it is given.
library;

class UserSummary {
  UserSummary({required this.id, required this.username, required this.displayName});
  factory UserSummary.fromJson(Map<String, dynamic> j) =>
      UserSummary(id: j['id'] as String, username: j['username'] as String?, displayName: j['displayName'] as String? ?? '');
  final String id;
  final String? username;
  final String displayName;
}

const audienceLabels = {'public': 'Everyone', 'followers': 'Followers', 'only_me': 'Only me'};

class Post {
  Post({
    required this.id,
    required this.author,
    required this.audience,
    required this.body,
    required this.likeCount,
    required this.commentCount,
    required this.liked,
    required this.createdAt,
    required this.mediaCount,
    this.communityName,
    this.shared,
    this.sharedUnavailable = false,
    this.removedReason,
  });
  factory Post.fromJson(Map<String, dynamic> j) {
    final shared = j['shared'] as Map<String, dynamic>?;
    final removed = j['removed'] as Map<String, dynamic>?;
    return Post(
      id: j['id'] as String,
      author: UserSummary.fromJson(j['author'] as Map<String, dynamic>),
      audience: j['audience'] as String,
      body: j['body'] as String? ?? '',
      likeCount: (j['likeCount'] as num).toInt(),
      commentCount: (j['commentCount'] as num).toInt(),
      liked: j['liked'] as bool,
      createdAt: DateTime.parse(j['createdAt'] as String),
      mediaCount: (j['media'] as List? ?? const []).length,
      communityName: (j['community'] as Map<String, dynamic>?)?['name'] as String?,
      shared: shared == null || shared['unavailable'] == true ? null : Post.fromJson({...shared, 'shared': null}),
      sharedUnavailable: shared?['unavailable'] == true,
      removedReason: removed == null ? null : (removed['reason'] as String? ?? ''),
    );
  }

  final String id;
  final UserSummary author;
  final String audience;
  final String body;
  int likeCount;
  int commentCount;
  bool liked;
  final DateTime createdAt;
  final int mediaCount;
  final String? communityName;
  final Post? shared;
  final bool sharedUnavailable;
  /// Set when a community moderator removed it; only the author sees such posts.
  final String? removedReason;
}

class Story {
  Story({required this.id, required this.author, required this.kind, required this.body, required this.background, required this.viewed, this.viewCount});
  factory Story.fromJson(Map<String, dynamic> j) => Story(
        id: j['id'] as String,
        author: UserSummary.fromJson(j['author'] as Map<String, dynamic>),
        kind: j['kind'] as String,
        body: j['body'] as String? ?? '',
        background: j['background'] as String? ?? '#3D5AFE',
        viewed: j['viewed'] as bool? ?? false,
        viewCount: (j['viewCount'] as num?)?.toInt(),
      );
  final String id;
  final UserSummary author;
  final String kind;
  final String body;
  final String background;
  final bool viewed;
  final int? viewCount;
}

class StoryGroup {
  StoryGroup({required this.author, required this.stories, required this.allViewed});
  factory StoryGroup.fromJson(Map<String, dynamic> j) => StoryGroup(
        author: UserSummary.fromJson(j['author'] as Map<String, dynamic>),
        stories: [for (final s in j['stories'] as List) Story.fromJson(s as Map<String, dynamic>)],
        allViewed: j['allViewed'] as bool,
      );
  final UserSummary author;
  final List<Story> stories;
  final bool allViewed;
}

class Community {
  Community({
    required this.id,
    required this.slug,
    required this.kind,
    required this.name,
    required this.description,
    required this.visibility,
    required this.memberCount,
    this.role,
    this.state,
  });
  factory Community.fromJson(Map<String, dynamic> j) {
    final m = j['membership'] as Map<String, dynamic>?;
    return Community(
      id: j['id'] as String,
      slug: j['slug'] as String,
      kind: j['kind'] as String,
      name: j['name'] as String,
      description: j['description'] as String? ?? '',
      visibility: j['visibility'] as String,
      memberCount: (j['memberCount'] as num).toInt(),
      role: m?['role'] as String?,
      state: m?['state'] as String?,
    );
  }
  final String id;
  final String slug;
  final String kind;
  final String name;
  final String description;
  final String visibility;
  final int memberCount;
  final String? role;
  /// active, pending (asked to join), or null when not a member.
  final String? state;

  bool get isMember => state == 'active';
  bool get canPost => isMember && (kind == 'community' || role == 'owner' || role == 'admin');
}
