import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService, Queryable } from '../database/database.service';
import { MediaService } from '../media/media.service';
import { userSummary } from './follows.service';

export const STORY_TTL_HOURS = 24;

export interface StoryInput {
  kind: 'text' | 'image' | 'video';
  body: string;
  background: string;
  mediaId?: string;
  audience: 'public' | 'followers';
}

interface StoryRow {
  id: string;
  author_id: string;
  username: string | null;
  display_name: string;
  kind: StoryInput['kind'];
  body: string;
  background: string;
  audience: StoryInput['audience'];
  media: Record<string, unknown> | null;
  created_at: Date;
  expires_at: Date;
  viewed: boolean;
  view_count: string | null;
}

/** $1 is the viewer. View counts are only filled in for the viewer's own stories. */
const STORY_SELECT = `
  SELECT s.id, s.author_id, u.username, u.display_name, s.kind, s.body, s.background, s.audience, s.created_at, s.expires_at,
         CASE WHEN md.id IS NULL THEN NULL ELSE json_build_object(
           'id', md.id, 'kind', md.kind, 'contentType', md.content_type, 'byteSize', md.byte_size,
           'width', md.width, 'height', md.height, 'durationMs', md.duration_ms) END AS media,
         EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = $1) AS viewed,
         CASE WHEN s.author_id = $1 THEN (SELECT count(*) FROM story_views v WHERE v.story_id = s.id) END AS view_count
    FROM stories s JOIN users u ON u.id = s.author_id LEFT JOIN media md ON md.id = s.media_id`;

function storyDto(s: StoryRow) {
  return {
    id: s.id,
    author: userSummary({ id: s.author_id, username: s.username, display_name: s.display_name }),
    kind: s.kind,
    body: s.body,
    background: s.background,
    audience: s.audience,
    media: s.media,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    viewed: s.viewed,
    viewCount: s.view_count === null ? null : Number(s.view_count),
  };
}

/** Stories last 24 hours. A sweep deletes expired ones and their files; reads ignore them before that. */
@Injectable()
export class StoriesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Stories');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly media: MediaService,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.STORY_SWEEP_INTERVAL_SECONDS;
    if (!every) return;
    this.timer = setInterval(() => this.purgeExpired().catch((e) => this.logger.warn(`story sweep failed: ${e.message}`)), every * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async create(userId: string, input: StoryInput) {
    await this.limits.consume({ name: 'story:create', limit: 50, windowSeconds: 86400 }, userId);
    if (input.kind === 'text') {
      if (input.mediaId) throw Errors.validation([{ path: 'mediaId', message: 'Text stories cannot carry media' }]);
      if (!input.body.trim()) throw Errors.validation([{ path: 'body', message: 'Write something for your story' }]);
    } else {
      if (!input.mediaId) throw Errors.validation([{ path: 'mediaId', message: `A ${input.kind} story needs a mediaId` }]);
      const m = await this.media.requireAttachable(userId, input.mediaId);
      if (m.kind !== input.kind) throw Errors.validation([{ path: 'kind', message: `Media is ${m.kind}, not ${input.kind}` }]);
    }
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO stories (author_id, kind, body, background, media_id, audience, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7)) RETURNING id`,
      [userId, input.kind, input.body, input.background, input.mediaId ?? null, input.audience, STORY_TTL_HOURS],
    );
    return this.get(userId, r!.id);
  }

  async get(viewerId: string, storyId: string) {
    const s = await this.db.one<StoryRow>(`${STORY_SELECT} WHERE s.id = $2 AND can_view_story($1, s.id)`, [viewerId, storyId]);
    if (!s) throw Errors.notFound('Story');
    return storyDto(s);
  }

  /**
   * The story tray: you first, then people you follow with stories you haven't seen,
   * newest first, then the ones you've seen.
   */
  async tray(viewerId: string) {
    const { rows } = await this.db.query<StoryRow>(
      `${STORY_SELECT}
        WHERE (s.author_id = $1 OR follows_actively($1, s.author_id)) AND can_view_story($1, s.id)
        ORDER BY s.created_at`,
      [viewerId],
    );
    const byAuthor = new Map<string, ReturnType<typeof storyDto>[]>();
    for (const r of rows) {
      const list = byAuthor.get(r.author_id) ?? [];
      list.push(storyDto(r));
      byAuthor.set(r.author_id, list);
    }
    const groups = [...byAuthor.values()].map((stories) => ({
      author: stories[0].author,
      stories,
      allViewed: stories.every((s) => s.viewed || s.author.id === viewerId),
      latestAt: stories[stories.length - 1].createdAt,
    }));
    groups.sort((a, b) => {
      const rank = (g: (typeof groups)[number]) => (g.author.id === viewerId ? 0 : g.allViewed ? 2 : 1);
      return rank(a) - rank(b) || new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
    });
    return { groups };
  }

  async byUser(viewerId: string, userId: string) {
    const { rows } = await this.db.query<StoryRow>(
      `${STORY_SELECT} WHERE s.author_id = $2 AND can_view_story($1, s.id) ORDER BY s.created_at`,
      [viewerId, userId],
    );
    return { stories: rows.map(storyDto) };
  }

  /** Records that the viewer saw the story. The author's own views aren't counted. */
  async markViewed(viewerId: string, storyId: string) {
    const s = await this.db.one<{ author_id: string }>('SELECT author_id FROM stories WHERE id = $2 AND can_view_story($1, id)', [viewerId, storyId]);
    if (!s) throw Errors.notFound('Story');
    if (s.author_id !== viewerId) {
      await this.db.query('INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [storyId, viewerId]);
    }
  }

  /** Who saw your story. Only the author can ask; blocked people are left out. */
  async viewers(userId: string, storyId: string) {
    const s = await this.db.one('SELECT 1 FROM stories WHERE id = $1 AND author_id = $2 AND expires_at > now()', [storyId, userId]);
    if (!s) throw Errors.notFound('Story');
    const { rows } = await this.db.query<{ id: string; username: string | null; display_name: string; viewed_at: Date }>(
      `SELECT u.id, u.username, u.display_name, v.viewed_at FROM story_views v JOIN users u ON u.id = v.viewer_id AND u.state = 'active'
        WHERE v.story_id = $1 AND NOT blocked_either_way($2, u.id) ORDER BY v.viewed_at DESC LIMIT 500`,
      [storyId, userId],
    );
    return { viewers: rows.map((r) => ({ user: userSummary(r), viewedAt: r.viewed_at })) };
  }

  async delete(userId: string, storyId: string) {
    const s = await this.db.one<{ media_id: string | null }>('DELETE FROM stories WHERE id = $1 AND author_id = $2 RETURNING media_id', [storyId, userId]);
    if (!s) throw Errors.notFound('Story');
    if (s.media_id) await this.release([s.media_id]);
  }

  /** Deletes expired stories, their views and (once unused) their files. Returns how many went. */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.db.query<{ media_id: string | null }>('DELETE FROM stories WHERE expires_at <= now() RETURNING media_id');
    await this.release(rows.map((r) => r.media_id).filter((x): x is string => !!x));
    return rows.length;
  }

  async scrubUser(userId: string, tx: Queryable): Promise<string[]> {
    const { rows } = await this.db.query<{ media_id: string | null }>('DELETE FROM stories WHERE author_id = $1 RETURNING media_id', [userId], tx);
    await this.db.query('DELETE FROM story_views WHERE viewer_id = $1', [userId], tx);
    return rows.map((r) => r.media_id).filter((x): x is string => !!x);
  }

  async exportFor(userId: string) {
    const { rows } = await this.db.query(
      'SELECT id, kind, body, background, media_id, audience, created_at, expires_at FROM stories WHERE author_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows;
  }

  private async release(ids: string[]) {
    for (const id of ids) await this.media.releaseIfUnused(id).catch((e) => this.logger.warn(`media release failed: ${e.message}`));
  }
}
