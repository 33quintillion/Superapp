import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService } from '../database/database.service';

export type ReportInput = { subjectType: 'user' | 'message' | 'post' | 'business' | 'mini_app'; subjectId: string; reason: string; details: string };

@Injectable()
export class SafetyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
  ) {}

  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) throw Errors.validation([{ path: 'userId', message: 'You cannot block yourself' }]);
    const target = await this.db.one(`SELECT 1 FROM users WHERE id = $1 AND state <> 'deleted'`, [blockedId]);
    if (!target) throw Errors.notFound('User');
    await this.db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [blockerId, blockedId]);
    await this.audit.record({ actorId: blockerId, action: 'safety.block', targetType: 'user', targetId: blockedId });
  }

  async unblock(blockerId: string, blockedId: string) {
    await this.db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
  }

  async listBlocks(userId: string) {
    const { rows } = await this.db.query<{ id: string; username: string | null; display_name: string; created_at: Date }>(
      `SELECT u.id, u.username, u.display_name, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name, blockedAt: r.created_at }));
  }

  /** True if either user has blocked the other. Messaging and social modules must call this. */
  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    return !!(await this.db.one(
      'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
      [a, b],
    ));
  }

  async report(reporterId: string, input: ReportInput) {
    await this.limits.consume({ name: 'report:user', limit: 20, windowSeconds: 3600 }, reporterId);
    if (input.subjectType === 'user') {
      if (input.subjectId === reporterId) throw Errors.validation([{ path: 'subjectId', message: 'You cannot report yourself' }]);
      const exists = await this.db.one('SELECT 1 FROM users WHERE id = $1', [input.subjectId]);
      if (!exists) throw Errors.notFound('User');
    }
    const r = await this.db.one<{ id: string; status: string; created_at: Date }>(
      `INSERT INTO reports (reporter_id, subject_type, subject_id, reason, details) VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
      [reporterId, input.subjectType, input.subjectId, input.reason, input.details],
    );
    return { id: r!.id, status: r!.status, createdAt: r!.created_at };
  }
}
