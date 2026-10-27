import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { MediaService } from '../media/media.service';
import { userSummary } from './follows.service';

export type Audience = 'public' | 'followers' | 'only_me';

export interface PostInput {
  clientId: string;
  body: string;
  audience: Audience;
  mediaIds: string[];
  sharedPostId?: string;
  communityId?: string;
}

export const MAX_POST_MEDIA = 10;
const MODERATOR_ROLES = ['owner', 'admin', 'moderator'];

interface PostRow {
  id: string;
  author_id: string;
  username: string | null;
  display_name: string;
  client_id: string;
  community_id: string | null;
  community: { id: string; slug: string; name: string; kind: string } | null;
  audience: Audience;
  body: string;
  shared_post_id: string | null;
  created_at: Date;
  edited_at: Date | null;
  removed_at: Date | null;
  removal_reason: string | null;
  media: Record<string, unknown>[];
  like_count: string;
  comment_count: string;
  liked: boolean;
}

/**
 * Every read goes through can_view_post() in the database, with the viewer as $1, so the
 * feed, profiles, communities, comments, likes and media downloads apply the same rules.
 * Counts and comment lists leave out people the viewer has blocked or been blocked by.
 */
const POST_SELECT = `
  SELECT p.id, p.author_id, u.username, u.display_name, p.client_id, p.community_id, p.audience, p.body, p.shared_post_id,
         p.created_at, p.edited_at, p.removed_at, p.removal_reason,
         CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'kind', c.kind) END AS community,
         COALESCE((SELECT json_agg(json_build_object(
                     'id', md.id, 'kind', md.kind, 'contentType', md.content_type, 'byteSize', md.byte_size,
                     'width', md.width, 'height', md.height, 'durationMs', md.duration_ms) ORDER BY pm.position)
                     FROM post_media pm JOIN media md ON md.id = pm.media_id AND md.state = 'ready' WHERE pm.post_id = p.id), '[]'::json) AS media,
         (SELECT count(*) FROM post_likes l JOIN users lu ON lu.id = l.user_id AND lu.state = 'active'
           WHERE l.post_id = p.id AND NOT blocked_either_way($1, l.user_id)) AS like_count,
         (SELECT count(*) FROM post_comments pc JOIN users cu ON cu.id = pc.author_id AND cu.state = 'active'
           WHERE pc.post_id = p.id AND NOT blocked_either_way($1, pc.author_id)) AS comment_count,
         EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN communities c ON c.id = p.community_id`;

function postDto(p: PostRow) {
  return {
    id: p.id,
    author: userSummary({ id: p.author_id, username: p.username, display_name: p.display_name }),
    clientId: p.client_id,
    community: p.community,
    audience: p.audience,
    body: p.body,
    media: p.media,
    likeCount: Number(p.like_count),
    commentCount: Number(p.comment_count),
    liked: p.liked,
    createdAt: p.created_at,
    editedAt: p.edited_at,
    // Only the author ever sees a removed post, with the moderator's reason.
    removed: p.removed_at ? { at: p.removed_at, reason: p.removal_reason } : null,
  };
}

type PostDto = ReturnType<typeof postDto> & { shared: (ReturnType<typeof postDto> | { id: string; unavailable: true }) | null };

@Injectable()
export class PostsService {
  private readonly logger = new Logger('Posts');

  constructor(
    private readonly db: DatabaseService,
    private readonly media: MediaService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /** Idempotent on clientId: a retry returns the original post with duplicate=true. */
  async create(userId: string, input: PostInput) {
    const existing = await this.db.one<{ id: string }>('SELECT id FROM posts WHERE author_id = $1 AND client_id = $2', [userId, input.clientId]);
    if (existing) return { post: (await this.get(userId, existing.id))!, duplicate: true };
    await this.limits.consume({ name: 'post:create', limit: 30, windowSeconds: 3600 }, userId);
    if (!input.body.trim() && !input.mediaIds.length && !input.sharedPostId) {
      throw Errors.validation([{ path: 'body', message: 'Write something, add a photo or video, or share a post' }]);
    }
    let postId: string;
    try {
      postId = await this.db.tx(async (tx) => {
        if (input.communityId) await this.assertCanPostIn(userId, input.communityId, tx);
        let sharedId = input.sharedPostId ?? null;
        if (sharedId) {
          const shared = await this.db.one<{ id: string; shared_post_id: string | null; plain_share: boolean }>(
            `SELECT p.id, p.shared_post_id, (p.body = '' AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id)) AS plain_share
               FROM posts p WHERE p.id = $2 AND can_view_post($1, p.id)`,
            [userId, sharedId],
            tx,
          );
          if (!shared) throw Errors.notFound('Post');
          // Sharing a plain share shares the original instead.
          if (shared.plain_share && shared.shared_post_id) sharedId = shared.shared_post_id;
        }
        for (const mediaId of input.mediaIds) {
          const m = await this.media.requireAttachable(userId, mediaId, tx);
          if (m.kind !== 'image' && m.kind !== 'video') throw Errors.validation([{ path: 'mediaIds', message: 'Posts can carry photos and videos' }]);
        }
        const row = await this.db.one<{ id: string }>(
          `INSERT INTO posts (author_id, client_id, community_id, audience, body, shared_post_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [userId, input.clientId, input.communityId ?? null, input.communityId ? 'public' : input.audience, input.body, sharedId],
          tx,
        );
        if (input.mediaIds.length) {
          await this.db.query(
            `INSERT INTO post_media (post_id, position, media_id) SELECT $1, i - 1, m FROM unnest($2::uuid[]) WITH ORDINALITY AS t(m, i)`,
            [row!.id, input.mediaIds],
            tx,
          );
        }
        return row!.id;
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        const dup = await this.db.one<{ id: string }>('SELECT id FROM posts WHERE author_id = $1 AND client_id = $2', [userId, input.clientId]);
        if (dup) return { post: (await this.get(userId, dup.id))!, duplicate: true };
      }
      throw err;
    }
    return { post: (await this.get(userId, postId))!, duplicate: false };
  }

  async get(viewerId: string, postId: string): Promise<PostDto> {
    const [post] = await this.load(viewerId, [postId]);
    if (!post) throw Errors.notFound('Post');
    return post;
  }

  /** Home feed: your posts, posts of people you follow, and posts in your communities. */
  /**
   * Your posts, posts by people you follow, and posts in your communities, newest first.
   * Built on read, so it walks each source's own index and takes at most a page from each,
   * instead of scanning every post newest-first until a page of visible ones turns up
   * (which took seconds for people who follow few accounts: docs/hardening.md#feed).
   * The visibility rules are applied inside each source, so a page is never short, and
   * load() checks every post with can_view_post again.
   */
  async feed(viewerId: string, opts: { limit: number; cursor?: string }) {
    const params: unknown[] = [viewerId, opts.limit + 1];
    let cursorSql = '';
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      cursorSql = 'AND (p.created_at, p.id) < ($3::timestamptz, $4::uuid)';
    }
    const newest = `ORDER BY p.created_at DESC, p.id DESC LIMIT $2`;
    const { rows } = await this.db.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM (
         (SELECT p.id, p.created_at FROM posts p WHERE p.author_id = $1 ${cursorSql} ${newest})
         UNION
         -- Following someone shows their public and followers posts, once they are active and not blocked.
         (SELECT x.id, x.created_at FROM follows f
            JOIN users u ON u.id = f.followee_id AND u.state = 'active'
            CROSS JOIN LATERAL (
              SELECT p.id, p.created_at FROM posts p
               WHERE p.author_id = f.followee_id AND p.community_id IS NULL AND p.removed_at IS NULL AND p.audience <> 'only_me' ${cursorSql}
               ${newest}) x
           WHERE f.follower_id = $1 AND f.state = 'active' AND NOT blocked_either_way($1, f.followee_id))
         UNION
         (SELECT x.id, x.created_at FROM community_members m
            JOIN communities c ON c.id = m.community_id AND c.deleted_at IS NULL
            CROSS JOIN LATERAL (
              SELECT p.id, p.created_at FROM posts p WHERE p.community_id = m.community_id AND can_view_post($1, p.id) ${cursorSql} ${newest}) x
           WHERE m.user_id = $1 AND m.state = 'active')
       ) feed ORDER BY created_at DESC, id DESC LIMIT $2`,
      params,
    );
    const ids = rows.slice(0, opts.limit);
    const posts = await this.load(viewerId, ids.map((r) => r.id));
    const last = ids[ids.length - 1];
    return { posts, nextCursor: rows.length > opts.limit && last ? encodeCursor(last.created_at, last.id) : null };
  }

  /** A person's own timeline (not their community posts). */
  async byUser(viewerId: string, userId: string, opts: { limit: number; cursor?: string }) {
    const visible = await this.db.one(`SELECT 1 FROM users WHERE id = $2 AND (id = $1 OR (state = 'active' AND NOT blocked_either_way($1, $2)))`, [viewerId, userId]);
    if (!visible) throw Errors.notFound('User');
    return this.page(viewerId, `p.author_id = $3 AND p.community_id IS NULL`, [userId], opts);
  }

  async byCommunity(viewerId: string, communityId: string, opts: { limit: number; cursor?: string }) {
    const ok = await this.db.one<{ ok: boolean }>('SELECT can_view_community($1, $2) AS ok', [viewerId, communityId]);
    if (!ok?.ok) throw Errors.notFound('Community');
    return this.page(viewerId, `p.community_id = $3`, [communityId], opts);
  }

  async update(userId: string, postId: string, patch: { body?: string; audience?: Audience }) {
    const p = await this.db.one<{ author_id: string; community_id: string | null; body: string; has_media: boolean; shared_post_id: string | null }>(
      `SELECT author_id, community_id, body, EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = posts.id) AS has_media, shared_post_id FROM posts WHERE id = $1`,
      [postId],
    );
    if (!p || !(await this.canView(userId, postId))) throw Errors.notFound('Post');
    if (p.author_id !== userId) throw Errors.forbidden('Only the author can edit a post');
    if (patch.audience !== undefined && p.community_id) throw Errors.validation([{ path: 'audience', message: 'Community posts follow the community’s visibility' }]);
    const body = patch.body ?? p.body;
    if (!body.trim() && !p.has_media && !p.shared_post_id) throw Errors.validation([{ path: 'body', message: 'A post cannot be empty' }]);
    await this.db.query(
      `UPDATE posts SET body = $2, audience = COALESCE($3, audience), edited_at = CASE WHEN $2 <> body THEN now() ELSE edited_at END WHERE id = $1`,
      [postId, body, patch.audience ?? null],
    );
    return this.get(userId, postId);
  }

  /** The author deletes for good; likes, comments and attached files go with it. */
  async delete(userId: string, postId: string) {
    const media = await this.db.tx(async (tx) => {
      const p = await this.db.one<{ author_id: string }>('SELECT author_id FROM posts WHERE id = $1 FOR UPDATE', [postId], tx);
      if (!p || !(await this.canView(userId, postId, tx))) throw Errors.notFound('Post');
      if (p.author_id !== userId) throw Errors.forbidden('Only the author can delete a post');
      const m = await this.db.query<{ media_id: string }>('SELECT media_id FROM post_media WHERE post_id = $1', [postId], tx);
      await this.db.query('DELETE FROM posts WHERE id = $1', [postId], tx);
      return m.rows.map((r) => r.media_id);
    });
    await this.releaseMedia(media);
  }

  /**
   * Moderator removal in a community: the post disappears for everyone but its author,
   * who sees the reason. Recorded in the audit log.
   */
  async moderate(moderatorId: string, postId: string, removed: boolean, reason: string) {
    const p = await this.db.one<{ community_id: string | null; author_id: string }>('SELECT community_id, author_id FROM posts WHERE id = $1', [postId]);
    const role = p?.community_id
      ? await this.db.one<{ role: string }>(
          `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND state = 'active'`,
          [p.community_id, moderatorId],
        )
      : null;
    if (!p || !role || !(await this.canView(moderatorId, postId, undefined, true))) throw Errors.notFound('Post');
    if (!MODERATOR_ROLES.includes(role.role)) throw Errors.forbidden('Only community moderators can remove posts');
    await this.db.query(
      removed
        ? `UPDATE posts SET removed_at = COALESCE(removed_at, now()), removed_by = $2, removal_reason = $3 WHERE id = $1`
        : `UPDATE posts SET removed_at = NULL, removed_by = NULL, removal_reason = NULL WHERE id = $1`,
      removed ? [postId, moderatorId, reason] : [postId],
    );
    await this.audit.record({
      actorId: moderatorId,
      action: removed ? 'community.post.removed' : 'community.post.restored',
      targetType: 'post',
      targetId: postId,
      metadata: { communityId: p.community_id, authorId: p.author_id, reason },
    });
  }

  async like(userId: string, postId: string, liked: boolean) {
    if (!(await this.canView(userId, postId))) throw Errors.notFound('Post');
    if (liked) {
      await this.limits.consume({ name: 'post:like', limit: 600, windowSeconds: 3600 }, userId);
      await this.db.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, userId]);
    } else {
      await this.db.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
    }
    const p = await this.get(userId, postId);
    return { liked: p.liked, likeCount: p.likeCount };
  }

  async likes(viewerId: string, postId: string) {
    if (!(await this.canView(viewerId, postId))) throw Errors.notFound('Post');
    const { rows } = await this.db.query<{ id: string; username: string | null; display_name: string }>(
      `SELECT u.id, u.username, u.display_name FROM post_likes l JOIN users u ON u.id = l.user_id AND u.state = 'active'
        WHERE l.post_id = $2 AND NOT blocked_either_way($1, u.id) ORDER BY l.created_at DESC LIMIT 200`,
      [viewerId, postId],
    );
    return { users: rows.map(userSummary) };
  }

  async comments(viewerId: string, postId: string, opts: { limit: number; cursor?: string }) {
    if (!(await this.canView(viewerId, postId))) throw Errors.notFound('Post');
    const params: unknown[] = [viewerId, postId, opts.limit + 1];
    let cursorSql = '';
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      cursorSql = `AND (c.created_at, c.id) > ($4::timestamptz, $5::uuid)`;
    }
    const { rows } = await this.db.query<{ id: string; author_id: string; username: string | null; display_name: string; body: string; created_at: Date }>(
      `SELECT c.id, c.author_id, u.username, u.display_name, c.body, c.created_at
         FROM post_comments c JOIN users u ON u.id = c.author_id AND u.state = 'active'
        WHERE c.post_id = $2 AND NOT blocked_either_way($1, c.author_id) ${cursorSql}
        ORDER BY c.created_at, c.id LIMIT $3`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      comments: page.map((c) => ({
        id: c.id,
        postId,
        author: userSummary({ id: c.author_id, username: c.username, display_name: c.display_name }),
        body: c.body,
        createdAt: c.created_at,
      })),
      nextCursor: rows.length > opts.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async comment(userId: string, postId: string, body: string) {
    if (!(await this.canView(userId, postId))) throw Errors.notFound('Post');
    await this.limits.consume({ name: 'post:comment', limit: 120, windowSeconds: 3600 }, userId);
    const c = await this.db.one<{ id: string; created_at: Date }>(
      'INSERT INTO post_comments (post_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, created_at',
      [postId, userId, body],
    );
    const me = (await this.db.one<{ id: string; username: string | null; display_name: string }>('SELECT id, username, display_name FROM users WHERE id = $1', [userId]))!;
    return { id: c!.id, postId, author: userSummary(me), body, createdAt: c!.created_at };
  }

  /** The commenter, the post's author, or a moderator of the post's community. */
  async deleteComment(userId: string, commentId: string) {
    const c = await this.db.one<{ id: string; post_id: string; author_id: string; post_author: string; community_id: string | null }>(
      `SELECT c.id, c.post_id, c.author_id, p.author_id AS post_author, p.community_id FROM post_comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
      [commentId],
    );
    if (!c || !(await this.canView(userId, c.post_id, undefined, true))) throw Errors.notFound('Comment');
    let allowed = c.author_id === userId || c.post_author === userId;
    let asModerator = false;
    if (!allowed && c.community_id) {
      const r = await this.db.one<{ role: string }>(
        `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND state = 'active'`,
        [c.community_id, userId],
      );
      allowed = asModerator = !!r && MODERATOR_ROLES.includes(r.role);
    }
    if (!allowed) throw Errors.forbidden('You can’t delete this comment');
    await this.db.query('DELETE FROM post_comments WHERE id = $1', [commentId]);
    if (asModerator) {
      await this.audit.record({ actorId: userId, action: 'community.comment.removed', targetType: 'comment', targetId: commentId, metadata: { postId: c.post_id, authorId: c.author_id } });
    }
  }

  /** Account deletion: everything this user posted, commented and liked. Returns media to release after commit. */
  async scrubUser(userId: string, tx: Queryable): Promise<string[]> {
    const m = await this.db.query<{ media_id: string }>(
      'SELECT pm.media_id FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE p.author_id = $1',
      [userId],
      tx,
    );
    await this.db.query('DELETE FROM posts WHERE author_id = $1', [userId], tx);
    await this.db.query('DELETE FROM post_comments WHERE author_id = $1', [userId], tx);
    await this.db.query('DELETE FROM post_likes WHERE user_id = $1', [userId], tx);
    return m.rows.map((r) => r.media_id);
  }

  async exportFor(userId: string) {
    const [posts, comments, likes] = await Promise.all([
      this.db.query(
        `SELECT p.id, p.community_id, p.audience, p.body, p.shared_post_id, p.created_at, p.edited_at, p.removed_at, p.removal_reason,
                COALESCE(array_agg(pm.media_id ORDER BY pm.position) FILTER (WHERE pm.media_id IS NOT NULL), '{}') AS media_ids
           FROM posts p LEFT JOIN post_media pm ON pm.post_id = p.id WHERE p.author_id = $1 GROUP BY p.id ORDER BY p.created_at`,
        [userId],
      ),
      this.db.query('SELECT id, post_id, body, created_at FROM post_comments WHERE author_id = $1 ORDER BY created_at', [userId]),
      this.db.query('SELECT post_id, created_at FROM post_likes WHERE user_id = $1 ORDER BY created_at', [userId]),
    ]);
    return { posts: posts.rows, comments: comments.rows, likes: likes.rows };
  }

  // ---------------------------------------------------------------- internals

  /** includeRemoved lets moderators act on a post they already removed. */
  private async canView(viewerId: string, postId: string, db?: Queryable, includeRemoved = false) {
    const r = await this.db.one<{ ok: boolean }>(
      includeRemoved
        ? `SELECT (can_view_post($1, $2) OR EXISTS (
             SELECT 1 FROM posts p WHERE p.id = $2 AND p.removed_at IS NOT NULL AND p.community_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = p.community_id AND m.user_id = $1
                               AND m.state = 'active' AND m.role IN ('owner', 'admin', 'moderator')))) AS ok`
        : 'SELECT can_view_post($1, $2) AS ok',
      [viewerId, postId],
      db,
    );
    return !!r?.ok;
  }

  private async assertCanPostIn(userId: string, communityId: string, tx: Queryable) {
    const r = await this.db.one<{ kind: string; role: string | null; state: string | null }>(
      `SELECT c.kind, m.role, m.state FROM communities c
         LEFT JOIN community_members m ON m.community_id = c.id AND m.user_id = $2
        WHERE c.id = $1 AND can_view_community($2, c.id)`,
      [communityId, userId],
      tx,
    );
    if (!r) throw Errors.notFound('Community');
    if (r.state !== 'active') throw Errors.forbidden('Join this community to post in it');
    if (r.kind === 'channel' && r.role !== 'owner' && r.role !== 'admin') throw Errors.forbidden('Only admins post in this channel');
  }

  private async page(viewerId: string, where: string, extra: unknown[], opts: { limit: number; cursor?: string }) {
    const params: unknown[] = [viewerId, opts.limit + 1, ...extra];
    let cursorSql = '';
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      cursorSql = `AND (p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    // $1 is the viewer, $2 the limit, and the caller's own parameters start at $3.
    const sql = `SELECT p.id, p.created_at FROM posts p WHERE ${where} AND can_view_post($1, p.id) ${cursorSql}
                  ORDER BY p.created_at DESC, p.id DESC LIMIT $2`;
    const { rows } = await this.db.query<{ id: string; created_at: Date }>(sql, params);
    const ids = rows.slice(0, opts.limit);
    const posts = await this.load(viewerId, ids.map((r) => r.id));
    const last = ids[ids.length - 1];
    return { posts, nextCursor: rows.length > opts.limit && last ? encodeCursor(last.created_at, last.id) : null };
  }

  /** Loads posts in the given order, each with its shared post checked separately for this viewer. */
  private async load(viewerId: string, ids: string[]): Promise<PostDto[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.query<PostRow>(`${POST_SELECT} WHERE p.id = ANY($2::uuid[]) AND can_view_post($1, p.id)`, [viewerId, ids]);
    const sharedIds = [...new Set(rows.map((r) => r.shared_post_id).filter((x): x is string => !!x))];
    const shared = sharedIds.length
      ? (await this.db.query<PostRow>(`${POST_SELECT} WHERE p.id = ANY($2::uuid[]) AND can_view_post($1, p.id)`, [viewerId, sharedIds])).rows
      : [];
    const sharedById = new Map(shared.map((s) => [s.id, s]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is PostRow => !!r)
      .map((r) => {
        const s = r.shared_post_id ? sharedById.get(r.shared_post_id) : undefined;
        return {
          ...postDto(r),
          // The original is checked against this viewer: sharing never widens its audience.
          shared: r.shared_post_id ? (s ? postDto(s) : { id: r.shared_post_id, unavailable: true as const }) : null,
        };
      });
  }

  private async releaseMedia(ids: string[]) {
    for (const id of ids) await this.media.releaseIfUnused(id).catch((e) => this.logger.warn(`media release failed: ${e.message}`));
  }
}
