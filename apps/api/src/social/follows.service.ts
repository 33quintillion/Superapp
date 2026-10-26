import { Injectable } from '@nestjs/common';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';

export type FollowState = 'none' | 'pending' | 'active';

export interface UserSummaryRow {
  id: string;
  username: string | null;
  display_name: string;
}

export const userSummary = (u: UserSummaryRow) => ({ id: u.id, username: u.username, displayName: u.display_name });

/**
 * Following is one-way. Public accounts are followed straight away; private accounts
 * approve each request. A block in either direction ends follows both ways (SafetyService).
 */
@Injectable()
export class FollowsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly limits: RateLimitService,
  ) {}

  async follow(viewerId: string, targetId: string) {
    if (viewerId === targetId) throw Errors.validation([{ path: 'userId', message: 'You cannot follow yourself' }]);
    await this.limits.consume({ name: 'follow', limit: 200, windowSeconds: 86400 }, viewerId);
    const target = await this.db.one<{ private_account: boolean | null }>(
      `SELECT p.private_account FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
        WHERE u.id = $1 AND u.state = 'active' AND NOT blocked_either_way($1, $2)`,
      [targetId, viewerId],
    );
    // Same answer for unknown, deactivated and blocked, like profile lookups.
    if (!target) throw Errors.notFound('User');
    const state = target.private_account ? 'pending' : 'active';
    await this.db.query(
      `INSERT INTO follows (follower_id, followee_id, state, accepted_at) VALUES ($1, $2, $3, CASE WHEN $3 = 'active' THEN now() END)
       ON CONFLICT (follower_id, followee_id) DO NOTHING`,
      [viewerId, targetId, state],
    );
    return this.relationship(viewerId, targetId);
  }

  /** Unfollows, or withdraws a pending request. */
  async unfollow(viewerId: string, targetId: string) {
    await this.db.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [viewerId, targetId]);
    return this.relationship(viewerId, targetId);
  }

  async removeFollower(userId: string, followerId: string) {
    await this.db.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [followerId, userId]);
  }

  async requests(userId: string) {
    const { rows } = await this.db.query<UserSummaryRow & { created_at: Date }>(
      `SELECT u.id, u.username, u.display_name, f.created_at FROM follows f JOIN users u ON u.id = f.follower_id AND u.state = 'active'
        WHERE f.followee_id = $1 AND f.state = 'pending' AND NOT blocked_either_way($1, u.id)
        ORDER BY f.created_at DESC LIMIT 200`,
      [userId],
    );
    return { requests: rows.map((r) => ({ user: userSummary(r), requestedAt: r.created_at })) };
  }

  async respond(userId: string, followerId: string, approve: boolean) {
    const res = approve
      ? await this.db.query(
          `UPDATE follows SET state = 'active', accepted_at = now() WHERE follower_id = $1 AND followee_id = $2 AND state = 'pending'`,
          [followerId, userId],
        )
      : await this.db.query(`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2 AND state = 'pending'`, [followerId, userId]);
    if (!res.rowCount) throw Errors.notFound('Follow request');
  }

  /** Switching a private account to public accepts everyone who was waiting. */
  async acceptAllPending(userId: string, db?: Queryable) {
    await this.db.query(`UPDATE follows SET state = 'active', accepted_at = now() WHERE followee_id = $1 AND state = 'pending'`, [userId], db);
  }

  /**
   * Follower and following lists. Visible to the person themselves, and to others only
   * when the account is public or they are an accepted follower.
   */
  async list(viewerId: string, userId: string, which: 'followers' | 'following', opts: { limit: number; cursor?: string }) {
    await this.requireListVisible(viewerId, userId);
    const [mine, other] = which === 'followers' ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
    const params: unknown[] = [userId, viewerId, opts.limit + 1];
    let cursorSql = '';
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      cursorSql = `AND (date_trunc('milliseconds', f.accepted_at), u.id) < ($4::timestamptz, $5::uuid)`;
    }
    const { rows } = await this.db.query<UserSummaryRow & { accepted_at: Date }>(
      `SELECT u.id, u.username, u.display_name, date_trunc('milliseconds', f.accepted_at) AS accepted_at
         FROM follows f JOIN users u ON u.id = f.${other} AND u.state = 'active'
        WHERE f.${mine} = $1 AND f.state = 'active' AND NOT blocked_either_way($2, u.id) ${cursorSql}
        ORDER BY date_trunc('milliseconds', f.accepted_at) DESC, u.id DESC LIMIT $3`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return { users: page.map(userSummary), nextCursor: rows.length > opts.limit && last ? encodeCursor(last.accepted_at, last.id) : null };
  }

  async relationship(viewerId: string, targetId: string) {
    const r = await this.db.one<{ out_state: FollowState | null; in_state: FollowState | null }>(
      `SELECT (SELECT state FROM follows WHERE follower_id = $1 AND followee_id = $2) AS out_state,
              (SELECT state FROM follows WHERE follower_id = $2 AND followee_id = $1) AS in_state`,
      [viewerId, targetId],
    );
    return { following: r?.out_state ?? 'none', followsYou: r?.in_state === 'active' };
  }

  async counts(userId: string) {
    const r = await this.db.one<{ followers: string; following: string }>(
      `SELECT (SELECT count(*) FROM follows f JOIN users u ON u.id = f.follower_id AND u.state = 'active' WHERE f.followee_id = $1 AND f.state = 'active') AS followers,
              (SELECT count(*) FROM follows f JOIN users u ON u.id = f.followee_id AND u.state = 'active' WHERE f.follower_id = $1 AND f.state = 'active') AS following`,
      [userId],
    );
    return { followers: Number(r!.followers), following: Number(r!.following) };
  }

  private async requireListVisible(viewerId: string, userId: string) {
    if (viewerId === userId) return;
    const ok = await this.db.one(
      `SELECT 1 FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
        WHERE u.id = $1 AND u.state = 'active' AND NOT blocked_either_way($1, $2)
          AND (NOT COALESCE(p.private_account, false) OR follows_actively($2, $1))`,
      [userId, viewerId],
    );
    if (!ok) throw Errors.notFound('User');
  }
}
