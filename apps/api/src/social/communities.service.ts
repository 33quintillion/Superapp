import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { userSummary } from './follows.service';

export type CommunityRole = 'owner' | 'admin' | 'moderator' | 'member';
type MemberState = 'active' | 'pending' | 'banned';

export interface CommunityInput {
  slug: string;
  name: string;
  description: string;
  kind: 'community' | 'channel';
  visibility: 'public' | 'private';
}

const RANK: Record<CommunityRole, number> = { owner: 3, admin: 2, moderator: 1, member: 0 };

interface CommunityRow {
  id: string;
  slug: string;
  kind: CommunityInput['kind'];
  name: string;
  description: string;
  visibility: CommunityInput['visibility'];
  created_at: Date;
  member_count: string;
  my_role: CommunityRole | null;
  my_state: MemberState | null;
}

/** $1 is the viewer. */
const COMMUNITY_SELECT = `
  SELECT c.id, c.slug, c.kind, c.name, c.description, c.visibility, c.created_at,
         (SELECT count(*) FROM community_members x WHERE x.community_id = c.id AND x.state = 'active') AS member_count,
         me.role AS my_role, me.state AS my_state
    FROM communities c LEFT JOIN community_members me ON me.community_id = c.id AND me.user_id = $1`;

function communityDto(c: CommunityRow) {
  return {
    id: c.id,
    slug: c.slug,
    kind: c.kind,
    name: c.name,
    description: c.description,
    visibility: c.visibility,
    memberCount: Number(c.member_count),
    membership: c.my_state ? { role: c.my_role!, state: c.my_state } : null,
    createdAt: c.created_at,
  };
}

/**
 * Communities are groups of people around a topic with a shared post feed. A channel is a
 * community where only admins post. Public ones can be read by anyone and joined freely;
 * private ones show their name and description, but members, posts and joining need approval.
 * Banned people get the same 404 as for a community that doesn't exist.
 */
@Injectable()
export class CommunitiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, input: CommunityInput) {
    await this.limits.consume({ name: 'community:create', limit: 5, windowSeconds: 86400 }, userId);
    try {
      const id = await this.db.tx(async (tx) => {
        const c = await this.db.one<{ id: string }>(
          `INSERT INTO communities (slug, kind, name, description, visibility, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [input.slug, input.kind, input.name, input.description, input.visibility, userId],
          tx,
        );
        await this.db.query(`INSERT INTO community_members (community_id, user_id, role, state) VALUES ($1, $2, 'owner', 'active')`, [c!.id, userId], tx);
        return c!.id;
      });
      return this.get(userId, id);
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).constraint === 'communities_slug_key') {
        throw Errors.conflict('slug_taken', 'That address is already taken');
      }
      throw err;
    }
  }

  /** By id or slug. */
  async get(viewerId: string, ref: string) {
    const c = await this.db.one<CommunityRow>(
      `${COMMUNITY_SELECT} WHERE ${isUuid(ref) ? 'c.id = $2' : 'c.slug = $2'} AND c.deleted_at IS NULL AND me.state IS DISTINCT FROM 'banned'`,
      [viewerId, ref.toLowerCase()],
    );
    if (!c) throw Errors.notFound('Community');
    return communityDto(c);
  }

  /** Discovery by name or address, plus the viewer's own communities when no query is given. */
  async search(viewerId: string, q: string | undefined, limit: number) {
    const terms = q?.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 6) ?? [];
    if (!terms.length) {
      const { rows } = await this.db.query<CommunityRow>(
        `${COMMUNITY_SELECT} WHERE c.deleted_at IS NULL AND me.state IN ('active', 'pending') ORDER BY me.updated_at DESC LIMIT $2`,
        [viewerId, limit],
      );
      return { communities: rows.map(communityDto) };
    }
    const tsquery = terms.map((t) => `${t.toLowerCase().replace(/[-_]/g, ' ').trim().split(/\s+/).join(':* & ')}:*`).join(' & ');
    const { rows } = await this.db.query<CommunityRow>(
      `${COMMUNITY_SELECT}
        WHERE c.deleted_at IS NULL AND me.state IS DISTINCT FROM 'banned'
          AND to_tsvector('simple', c.name || ' ' || c.slug) @@ to_tsquery('simple', $3)
        ORDER BY (SELECT count(*) FROM community_members x WHERE x.community_id = c.id AND x.state = 'active') DESC, c.created_at
        LIMIT $2`,
      [viewerId, limit, tsquery],
    );
    return { communities: rows.map(communityDto) };
  }

  async update(userId: string, communityId: string, patch: Partial<Pick<CommunityInput, 'name' | 'description' | 'visibility'>>) {
    const me = await this.requireRole(userId, communityId, 'admin');
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length) {
      await this.db.query(
        `UPDATE communities SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [communityId, ...entries.map(([, v]) => v)],
      );
      // Going public lets in everyone who was waiting.
      if (patch.visibility === 'public') {
        await this.db.query(`UPDATE community_members SET state = 'active', updated_at = now() WHERE community_id = $1 AND state = 'pending'`, [communityId]);
      }
      await this.audit.record({ actorId: userId, action: 'community.updated', targetType: 'community', targetId: communityId, metadata: { fields: entries.map(([k]) => k), role: me } });
    }
    return this.get(userId, communityId);
  }

  async delete(userId: string, communityId: string) {
    await this.requireRole(userId, communityId, 'owner');
    await this.db.query('UPDATE communities SET deleted_at = now() WHERE id = $1', [communityId]);
    await this.audit.record({ actorId: userId, action: 'community.deleted', targetType: 'community', targetId: communityId });
  }

  async join(userId: string, communityId: string) {
    const c = await this.get(userId, communityId);
    if (!c.membership) {
      await this.limits.consume({ name: 'community:join', limit: 100, windowSeconds: 86400 }, userId);
      await this.db.query(
        `INSERT INTO community_members (community_id, user_id, role, state) VALUES ($1, $2, 'member', $3) ON CONFLICT DO NOTHING`,
        [c.id, userId, c.visibility === 'public' ? 'active' : 'pending'],
      );
    }
    return this.get(userId, c.id);
  }

  /** Leaving, or withdrawing a join request. The owner hands the community over first. */
  async leave(userId: string, communityId: string) {
    const r = await this.db.one<{ role: CommunityRole; state: MemberState }>(
      'SELECT role, state FROM community_members WHERE community_id = $1 AND user_id = $2',
      [communityId, userId],
    );
    if (!r || r.state === 'banned') throw Errors.notFound('Community');
    if (r.role === 'owner') throw Errors.conflict('owner_cannot_leave', 'Hand the community over to someone else before leaving');
    await this.db.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, userId]);
  }

  /** Active members for anyone who can see the community; pending and banned lists for moderators. */
  async members(viewerId: string, communityId: string, state: MemberState, limit: number) {
    if (state === 'active') {
      const ok = await this.db.one<{ ok: boolean }>('SELECT can_view_community($1, $2) AS ok', [viewerId, communityId]);
      if (!ok?.ok) throw Errors.notFound('Community');
    } else {
      await this.requireRole(viewerId, communityId, 'moderator');
    }
    const { rows } = await this.db.query<{ id: string; username: string | null; display_name: string; role: CommunityRole; created_at: Date }>(
      `SELECT u.id, u.username, u.display_name, m.role, m.created_at FROM community_members m JOIN users u ON u.id = m.user_id AND u.state = 'active'
        WHERE m.community_id = $2 AND m.state = $3 AND NOT blocked_either_way($1, u.id)
        ORDER BY ${state === 'active' ? `CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END,` : ''} m.created_at
        LIMIT $4`,
      [viewerId, communityId, state, limit],
    );
    return { members: rows.map((r) => ({ user: userSummary(r), role: r.role, state, since: r.created_at })) };
  }

  /**
   * Moderation. Approving requests and banning plain members needs moderator; changing roles
   * needs a higher rank than both the person's current and new role; handing over ownership
   * is the owner's alone (they become an admin).
   */
  async setMember(actorId: string, communityId: string, targetId: string, change: { role?: CommunityRole; state?: 'active' | 'banned' }) {
    if (actorId === targetId) throw Errors.validation([{ path: 'userId', message: 'You cannot change your own membership here' }]);
    await this.db.tx(async (tx) => {
      await this.db.query('SELECT 1 FROM communities WHERE id = $1 FOR UPDATE', [communityId], tx);
      const myRole = await this.requireRole(actorId, communityId, 'moderator', tx);
      const target = await this.db.one<{ role: CommunityRole; state: MemberState }>(
        'SELECT role, state FROM community_members WHERE community_id = $1 AND user_id = $2',
        [communityId, targetId],
        tx,
      );
      if (change.state === 'banned') {
        if (target && RANK[target.role] >= RANK[myRole]) throw outranked();
        const user = await this.db.one(`SELECT 1 FROM users WHERE id = $1 AND state <> 'deleted'`, [targetId], tx);
        if (!user) throw Errors.notFound('User');
        await this.db.query(
          `INSERT INTO community_members (community_id, user_id, role, state) VALUES ($1, $2, 'member', 'banned')
           ON CONFLICT (community_id, user_id) DO UPDATE SET role = 'member', state = 'banned', updated_at = now()`,
          [communityId, targetId],
          tx,
        );
        await this.audit.record({ actorId, action: 'community.member.banned', targetType: 'user', targetId, metadata: { communityId } }, tx);
        return;
      }
      if (!target || target.state === 'banned') throw Errors.notFound('Member');
      if (change.state === 'active' && target.state === 'pending') {
        await this.db.query(`UPDATE community_members SET state = 'active', updated_at = now() WHERE community_id = $1 AND user_id = $2`, [communityId, targetId], tx);
      }
      if (change.role && change.role !== target.role) {
        if (target.state !== 'active' && change.state !== 'active') throw Errors.conflict('not_a_member', 'Approve the request first');
        if (change.role === 'owner') {
          if (myRole !== 'owner') throw Errors.forbidden('Only the owner can hand over the community');
          await this.db.query(`UPDATE community_members SET role = 'admin', updated_at = now() WHERE community_id = $1 AND user_id = $2`, [communityId, actorId], tx);
        } else if (RANK[target.role] >= RANK[myRole] || RANK[change.role] >= RANK[myRole]) {
          throw outranked();
        }
        await this.db.query(`UPDATE community_members SET role = $3, updated_at = now() WHERE community_id = $1 AND user_id = $2`, [communityId, targetId, change.role], tx);
        await this.audit.record({ actorId, action: 'community.member.role', targetType: 'user', targetId, metadata: { communityId, role: change.role } }, tx);
      }
    });
    const r = await this.db.one<{ role: CommunityRole; state: MemberState }>(
      'SELECT role, state FROM community_members WHERE community_id = $1 AND user_id = $2',
      [communityId, targetId],
    );
    return { userId: targetId, role: r!.role, state: r!.state };
  }

  /** Removes a member, declines a request, or lifts a ban. */
  async removeMember(actorId: string, communityId: string, targetId: string) {
    if (actorId === targetId) return this.leave(actorId, communityId);
    const myRole = await this.requireRole(actorId, communityId, 'moderator');
    const target = await this.db.one<{ role: CommunityRole; state: MemberState }>(
      'SELECT role, state FROM community_members WHERE community_id = $1 AND user_id = $2',
      [communityId, targetId],
    );
    if (!target) throw Errors.notFound('Member');
    if (RANK[target.role] >= RANK[myRole]) throw outranked();
    await this.db.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, targetId]);
    await this.audit.record({ actorId, action: target.state === 'banned' ? 'community.member.unbanned' : 'community.member.removed', targetType: 'user', targetId, metadata: { communityId } });
  }

  /**
   * Account deletion. Communities the user owns pass to the highest-ranked, longest-standing
   * member; with nobody left they are deleted.
   */
  async scrubUser(userId: string, tx: Queryable) {
    const owned = await this.db.query<{ community_id: string }>(`SELECT community_id FROM community_members WHERE user_id = $1 AND role = 'owner'`, [userId], tx);
    await this.db.query('DELETE FROM community_members WHERE user_id = $1', [userId], tx);
    for (const { community_id } of owned.rows) {
      const next = await this.db.one<{ user_id: string }>(
        `SELECT m.user_id FROM community_members m JOIN users u ON u.id = m.user_id AND u.state = 'active'
          WHERE m.community_id = $1 AND m.state = 'active'
          ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, m.created_at LIMIT 1`,
        [community_id],
        tx,
      );
      if (next) await this.db.query(`UPDATE community_members SET role = 'owner', updated_at = now() WHERE community_id = $1 AND user_id = $2`, [community_id, next.user_id], tx);
      else await this.db.query('UPDATE communities SET deleted_at = now() WHERE id = $1', [community_id], tx);
    }
  }

  async exportFor(userId: string) {
    const { rows } = await this.db.query(
      `SELECT c.id, c.slug, c.name, m.role, m.state, m.created_at FROM community_members m JOIN communities c ON c.id = m.community_id
        WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId],
    );
    return rows;
  }

  /** Returns the caller's role if it is at least `min`. Non-members (and banned people) get a 404. */
  private async requireRole(userId: string, communityId: string, min: CommunityRole, db?: Queryable): Promise<CommunityRole> {
    const r = await this.db.one<{ role: CommunityRole }>(
      `SELECT m.role FROM community_members m JOIN communities c ON c.id = m.community_id AND c.deleted_at IS NULL
        WHERE m.community_id = $1 AND m.user_id = $2 AND m.state = 'active'`,
      [communityId, userId],
      db,
    );
    if (!r) throw Errors.notFound('Community');
    if (RANK[r.role] < RANK[min]) throw Errors.forbidden(`Only community ${min === 'moderator' ? 'moderators' : `${min}s`} can do this`);
    return r.role;
  }
}

const outranked = () => new AppError(HttpStatus.FORBIDDEN, 'outranked', 'You can only manage people with a lower role than yours');

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
