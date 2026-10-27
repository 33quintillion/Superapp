import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { AccessClaims } from '../auth/token.service';
import { BusinessesService } from '../business/businesses.service';
import { AuditService } from '../common/audit.service';
import { AppError, Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService, Queryable } from '../database/database.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MediaService } from '../media/media.service';
import { MessagingService } from '../messaging/messaging.service';
import { userSummary } from '../social/follows.service';

export type PlatformRole = 'moderator' | 'admin';
type SubjectType = 'user' | 'message' | 'post' | 'comment' | 'story' | 'community' | 'business' | 'mini_app';

const RANK: Record<PlatformRole, number> = { moderator: 1, admin: 2 };

/** Subjects whose removal takes the admin role: they affect a business or partner, not one post. */
const ADMIN_ONLY_REMOVAL: SubjectType[] = ['business', 'mini_app'];

const OPEN = ['open', 'in_review'];

interface ReportRow {
  id: string;
  reporter_id: string | null;
  reporter_username: string | null;
  reporter_display_name: string | null;
  subject_type: SubjectType;
  subject_id: string;
  reason: string;
  details: string;
  status: string;
  assigned_to: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string;
  actions: string[];
  created_at: Date;
  same_subject_open: string;
}

const REPORT_SELECT = `
  SELECT r.*, u.username AS reporter_username, u.display_name AS reporter_display_name,
         (SELECT count(*) FROM reports o WHERE o.subject_type = r.subject_type AND o.subject_id = r.subject_id
             AND o.status IN ('open', 'in_review') AND o.id <> r.id) AS same_subject_open
    FROM reports r LEFT JOIN users u ON u.id = r.reporter_id`;

const forbidden = (code: string, message: string) => new AppError(HttpStatus.FORBIDDEN, code, message);

/**
 * The admin dashboard's back end: who counts as platform staff, the report queue, and the
 * actions staff take (removing content, suspending accounts and businesses). Every action
 * is written to the audit log with the staff member as actor.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger('AdminService');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly businesses: BusinessesService,
    private readonly integrations: IntegrationsService,
    private readonly messaging: MessagingService,
    private readonly media: MediaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Platform staff only, with two-step verification on, and only from a session that was
   * opened with a two-step code in the last ADMIN_SESSION_MAX_HOURS. A stolen password,
   * or an old session left signed in somewhere, is not enough to reach the dashboard.
   */
  async require(auth: AccessClaims, min: PlatformRole = 'moderator'): Promise<PlatformRole> {
    const r = await this.db.one<{ role: PlatformRole; mfa_enabled_at: Date | null; mfa_verified_at: Date | null; fresh: boolean }>(
      `SELECT p.role, u.mfa_enabled_at, s.mfa_verified_at,
              s.mfa_verified_at > now() - make_interval(hours => $3) AS fresh
         FROM platform_staff p JOIN users u ON u.id = p.user_id
         JOIN sessions s ON s.id = $2 AND s.user_id = p.user_id
        WHERE p.user_id = $1`,
      [auth.userId, auth.sessionId, this.config.ADMIN_SESSION_MAX_HOURS],
    );
    if (!r) throw forbidden('not_platform_staff', 'This area is for platform staff');
    if (!r.mfa_enabled_at) throw forbidden('mfa_required', 'Turn on two-step verification, then sign in again');
    if (!r.mfa_verified_at || !r.fresh) throw forbidden('mfa_reauth_required', 'Sign in again with your two-step code to continue');
    if (RANK[r.role] < RANK[min]) throw forbidden('admin_only', 'This needs the admin role');
    return r.role;
  }

  async overview(auth: AccessClaims) {
    const role = await this.require(auth);
    const r = await this.db.one<Record<string, string>>(
      `SELECT (SELECT count(*) FROM reports WHERE status = 'open') AS open_reports,
              (SELECT count(*) FROM reports WHERE status = 'in_review') AS in_review,
              (SELECT count(*) FROM reports WHERE status IN ('open', 'in_review') AND reason = 'child_safety') AS child_safety,
              (SELECT count(*) FROM users WHERE state = 'active') AS active_users,
              (SELECT count(*) FROM users WHERE state = 'suspended') AS suspended_users,
              (SELECT count(*) FROM businesses WHERE state = 'active') AS businesses,
              (SELECT count(*) FROM integrations WHERE state = 'live') AS live_integrations`,
    );
    return {
      role,
      reports: { open: Number(r!.open_reports), inReview: Number(r!.in_review), childSafety: Number(r!.child_safety) },
      users: { active: Number(r!.active_users), suspended: Number(r!.suspended_users) },
      businesses: Number(r!.businesses),
      liveIntegrations: Number(r!.live_integrations),
    };
  }

  // ---------------------------------------------------------------- reports

  private reportView(r: ReportRow) {
    return {
      id: r.id,
      reporter: r.reporter_id ? userSummary({ id: r.reporter_id, username: r.reporter_username, display_name: r.reporter_display_name ?? '' }) : null,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      assignedTo: r.assigned_to,
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at,
      resolutionNote: r.resolution_note,
      actions: r.actions,
      otherOpenReports: Number(r.same_subject_open),
      createdAt: r.created_at,
    };
  }

  /** The queue: child-safety reports first, then oldest first. Closed reports newest first. */
  async reports(auth: AccessClaims, q: { status: 'open' | 'closed'; subjectType?: SubjectType; limit: number; offset: number }) {
    await this.require(auth);
    const params: unknown[] = [q.status === 'open' ? OPEN : ['actioned', 'dismissed'], q.limit, q.offset];
    let where = 'r.status = ANY($1)';
    if (q.subjectType) {
      params.push(q.subjectType);
      where += ` AND r.subject_type = $${params.length}`;
    }
    const order = q.status === 'open' ? `(r.reason = 'child_safety') DESC, r.created_at, r.id` : 'r.resolved_at DESC NULLS LAST, r.id';
    const { rows } = await this.db.query<ReportRow>(`${REPORT_SELECT} WHERE ${where} ORDER BY ${order} LIMIT $2 OFFSET $3`, params);
    return { reports: rows.map((r) => this.reportView(r)) };
  }

  /** One report, with what was reported as it stands now (null if it is gone). */
  async report(auth: AccessClaims, id: string) {
    await this.require(auth);
    const r = await this.db.one<ReportRow>(`${REPORT_SELECT} WHERE r.id = $1`, [id]);
    if (!r) throw Errors.notFound('Report');
    const { rows: related } = await this.db.query<ReportRow>(
      `${REPORT_SELECT} WHERE r.subject_type = $1 AND r.subject_id = $2 AND r.id <> $3 ORDER BY r.created_at DESC LIMIT 20`,
      [r.subject_type, r.subject_id, id],
    );
    await this.audit.record({ actorId: auth.userId, action: 'admin.report.viewed', targetType: 'report', targetId: id });
    return { ...this.reportView(r), subject: await this.subject(r.subject_type, r.subject_id), related: related.map((x) => this.reportView(x)) };
  }

  async claim(auth: AccessClaims, id: string) {
    await this.require(auth);
    const r = await this.db.query(`UPDATE reports SET status = 'in_review', assigned_to = $2 WHERE id = $1 AND status IN ('open', 'in_review')`, [id, auth.userId]);
    if (!r.rowCount) throw Errors.conflict('report_closed', 'This report is already closed');
    await this.audit.record({ actorId: auth.userId, action: 'admin.report.claimed', targetType: 'report', targetId: id });
    return this.report(auth, id);
  }

  /**
   * Closes the report and every other open report about the same thing, after optionally
   * removing the content and suspending whoever posted it.
   */
  async resolve(auth: AccessClaims, id: string, input: { decision: 'dismiss' | 'action'; removeContent: boolean; suspendAuthor: boolean; note: string }) {
    const role = await this.require(auth);
    if (input.decision === 'dismiss' && (input.removeContent || input.suspendAuthor)) {
      throw Errors.validation([{ path: 'decision', message: 'Dismissing a report takes no action' }]);
    }
    if (input.decision === 'action' && !input.removeContent && !input.suspendAuthor) {
      throw Errors.validation([{ path: 'decision', message: 'Choose what to do: remove the content, suspend the author, or both' }]);
    }
    const r = await this.db.one<{ subject_type: SubjectType; subject_id: string; status: string }>('SELECT subject_type, subject_id, status FROM reports WHERE id = $1', [id]);
    if (!r) throw Errors.notFound('Report');
    if (!OPEN.includes(r.status)) throw Errors.conflict('report_closed', 'This report is already closed');
    if (input.removeContent && ADMIN_ONLY_REMOVAL.includes(r.subject_type) && role !== 'admin') throw forbidden('admin_only', 'This needs the admin role');

    const actions: string[] = [];
    const releaseMedia: string[] = [];
    let author: string | null = null;
    if (input.suspendAuthor) {
      author = await this.authorOf(r.subject_type, r.subject_id);
      if (!author) throw Errors.validation([{ path: 'suspendAuthor', message: 'There is no account to suspend for this report' }]);
    }
    if (input.removeContent && r.subject_type === 'message') {
      const live = /^[0-9a-f-]{36}$/.test(r.subject_id) && (await this.db.one(`SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL AND kind <> 'system'`, [r.subject_id]));
      if (!live) throw Errors.conflict('content_gone', 'The reported content is already gone');
    }
    await this.db.tx(async (tx) => {
      if (input.removeContent) {
        // A message is removed after this commits, by the messaging service, so members' devices hear about it.
        if (r.subject_type !== 'message') {
          const removed = await this.removeContent(auth.userId, r.subject_type, r.subject_id, input.note, tx, releaseMedia);
          if (!removed) throw Errors.conflict('content_gone', 'The reported content is already gone');
        }
        actions.push('content_removed');
      }
      if (author) {
        await this.suspendUser(auth.userId, author, input.note || `Report ${id}`, tx);
        actions.push('user_suspended');
      }
      await this.db.query(
        `UPDATE reports SET status = $3, resolved_by = $4, resolved_at = now(), resolution_note = $5, actions = $6
          WHERE subject_type = $1 AND subject_id = $2 AND status IN ('open', 'in_review')`,
        [r.subject_type, r.subject_id, input.decision === 'dismiss' ? 'dismissed' : 'actioned', auth.userId, input.note, actions],
        tx,
      );
      await this.audit.record(
        { actorId: auth.userId, action: `admin.report.${input.decision === 'dismiss' ? 'dismissed' : 'actioned'}`, targetType: r.subject_type, targetId: r.subject_id, metadata: { reportId: id, actions } },
        tx,
      );
    });
    if (input.removeContent && r.subject_type === 'message') await this.messaging.removeByModerator(r.subject_id);
    for (const m of releaseMedia) await this.media.releaseIfUnused(m).catch((e) => this.logger.warn(`media release failed: ${e.message}`));
    return this.report(auth, id);
  }

  private async subject(type: SubjectType, id: string): Promise<Record<string, unknown> | null> {
    const uuid = /^[0-9a-f-]{36}$/.test(id);
    switch (type) {
      case 'user': {
        if (!uuid) return null;
        const u = await this.db.one<{ id: string; username: string | null; display_name: string; bio: string; state: string; created_at: Date }>(
          'SELECT id, username, display_name, bio, state, created_at FROM users WHERE id = $1',
          [id],
        );
        return u && { user: userSummary(u), bio: u.bio, state: u.state, joinedAt: u.created_at };
      }
      case 'message': {
        // Only the reported message is shown, never the rest of the chat.
        if (!uuid) return null;
        const m = await this.db.one<{ id: string; conversation_id: string; sender_id: string | null; username: string | null; display_name: string | null; kind: string; body: string; created_at: Date; deleted_at: Date | null }>(
          `SELECT m.id, m.conversation_id, m.sender_id, u.username, u.display_name, m.kind, m.body, m.created_at, m.deleted_at
             FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
          [id],
        );
        return m && { author: m.sender_id ? userSummary({ id: m.sender_id, username: m.username, display_name: m.display_name ?? '' }) : null, kind: m.kind, body: m.body, createdAt: m.created_at, removed: !!m.deleted_at };
      }
      case 'post': {
        if (!uuid) return null;
        const p = await this.db.one<{ author_id: string; username: string | null; display_name: string; body: string; audience: string; community_id: string | null; created_at: Date; removed_at: Date | null; media: number }>(
          `SELECT p.author_id, u.username, u.display_name, p.body, p.audience, p.community_id, p.created_at, p.removed_at,
                  (SELECT count(*)::int FROM post_media pm WHERE pm.post_id = p.id) AS media
             FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $1`,
          [id],
        );
        return p && { author: userSummary({ id: p.author_id, username: p.username, display_name: p.display_name }), body: p.body, audience: p.audience, communityId: p.community_id, mediaCount: p.media, createdAt: p.created_at, removed: !!p.removed_at };
      }
      case 'comment': {
        if (!uuid) return null;
        const c = await this.db.one<{ author_id: string; username: string | null; display_name: string; body: string; post_id: string; created_at: Date }>(
          `SELECT c.author_id, u.username, u.display_name, c.body, c.post_id, c.created_at FROM post_comments c JOIN users u ON u.id = c.author_id WHERE c.id = $1`,
          [id],
        );
        return c && { author: userSummary({ id: c.author_id, username: c.username, display_name: c.display_name }), body: c.body, postId: c.post_id, createdAt: c.created_at };
      }
      case 'story': {
        if (!uuid) return null;
        const s = await this.db.one<{ author_id: string; username: string | null; display_name: string; kind: string; body: string; created_at: Date; expires_at: Date }>(
          `SELECT s.author_id, u.username, u.display_name, s.kind, s.body, s.created_at, s.expires_at FROM stories s JOIN users u ON u.id = s.author_id WHERE s.id = $1`,
          [id],
        );
        return s && { author: userSummary({ id: s.author_id, username: s.username, display_name: s.display_name }), kind: s.kind, body: s.body, createdAt: s.created_at, expiresAt: s.expires_at };
      }
      case 'community': {
        const c = await this.db.one<{ id: string; slug: string; name: string; description: string; kind: string; deleted_at: Date | null }>(
          `SELECT id, slug, name, description, kind, deleted_at FROM communities WHERE ${uuid ? 'id' : 'slug'} = $1`,
          [id],
        );
        return c && { id: c.id, slug: c.slug, name: c.name, description: c.description, kind: c.kind, removed: !!c.deleted_at };
      }
      case 'business': {
        const b = await this.db.one<{ id: string; handle: string; name: string; description: string; state: string }>(
          `SELECT id, handle, name, description, state FROM businesses WHERE ${uuid ? 'id' : 'handle'} = $1`,
          [id],
        );
        return b && { id: b.id, handle: b.handle, name: b.name, description: b.description, state: b.state };
      }
      case 'mini_app': {
        const i = await this.db.one<{ id: string; slug: string; name: string; state: string }>(`SELECT id, slug, name, state FROM integrations WHERE ${uuid ? 'id' : 'slug'} = $1`, [id]);
        return i && { id: i.id, slug: i.slug, name: i.name, state: i.state };
      }
    }
  }

  private async authorOf(type: SubjectType, id: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const sql: Partial<Record<SubjectType, string>> = {
      user: `SELECT id AS author FROM users WHERE id = $1 AND state <> 'deleted'`,
      message: 'SELECT sender_id AS author FROM messages WHERE id = $1',
      post: 'SELECT author_id AS author FROM posts WHERE id = $1',
      comment: 'SELECT author_id AS author FROM post_comments WHERE id = $1',
      story: 'SELECT author_id AS author FROM stories WHERE id = $1',
    };
    if (!sql[type]) return null;
    return (await this.db.one<{ author: string | null }>(sql[type]!, [id]))?.author ?? null;
  }

  /** True if something was removed. Media to release after commit is pushed onto `release`. */
  private async removeContent(actorId: string, type: SubjectType, id: string, reason: string, tx: Queryable, release: string[]): Promise<boolean> {
    const uuid = /^[0-9a-f-]{36}$/.test(id);
    switch (type) {
      case 'post': {
        if (!uuid) return false;
        const r = await this.db.query(
          `UPDATE posts SET removed_at = now(), removed_by = $2, removal_reason = $3 WHERE id = $1 AND removed_at IS NULL`,
          [id, actorId, reason || 'Removed for breaking the community guidelines'],
          tx,
        );
        return !!r.rowCount;
      }
      case 'comment':
        return uuid && !!(await this.db.query('DELETE FROM post_comments WHERE id = $1', [id], tx)).rowCount;
      case 'story': {
        if (!uuid) return false;
        const s = await this.db.one<{ media_id: string | null }>('DELETE FROM stories WHERE id = $1 RETURNING media_id', [id], tx);
        if (s?.media_id) release.push(s.media_id);
        return !!s;
      }
      case 'community':
        return !!(await this.db.query(`UPDATE communities SET deleted_at = now() WHERE ${uuid ? 'id' : 'slug'} = $1 AND deleted_at IS NULL`, [id], tx)).rowCount;
      case 'business': {
        const b = await this.db.one<{ id: string }>(`SELECT id FROM businesses WHERE ${uuid ? 'id' : 'handle'} = $1`, [id], tx);
        return !!b && this.businesses.setSuspended(b.id, true, reason || 'Suspended after a report', tx);
      }
      case 'mini_app':
        return !!(await this.db.query(`UPDATE integrations SET state = 'disabled', disabled_reason = $2, updated_at = now() WHERE ${uuid ? 'id' : 'slug'} = $1 AND state <> 'disabled'`, [id, reason || 'Disabled after a report'], tx)).rowCount;
      case 'user':
        throw Errors.validation([{ path: 'removeContent', message: 'To act on an account, suspend it' }]);
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- accounts

  async users(auth: AccessClaims, q: string, limit: number) {
    const role = await this.require(auth);
    const term = q.trim().toLowerCase();
    const { rows } = await this.db.query<{ id: string; username: string | null; display_name: string; email: string | null; state: string; created_at: Date; suspension_reason: string | null; reports: string; staff_role: string | null }>(
      `SELECT u.id, u.username, u.display_name, u.email, u.state, u.created_at, u.suspension_reason,
              (SELECT count(*) FROM reports r WHERE r.subject_type = 'user' AND r.subject_id = u.id::text) AS reports,
              p.role AS staff_role
         FROM users u LEFT JOIN platform_staff p ON p.user_id = u.id
        WHERE u.state <> 'deleted' AND ($1 = '' OR u.username LIKE $3 || '%' OR u.email = $1 OR u.id::text = $1)
        ORDER BY u.username LIMIT $2`,
      [term, limit, term.replace(/[%_\\]/g, (c) => `\\${c}`)],
    );
    return {
      users: rows.map((r) => ({
        user: userSummary(r),
        // Email is personal data: admins only, for account recovery and legal requests.
        email: role === 'admin' ? r.email : undefined,
        state: r.state,
        suspensionReason: r.suspension_reason,
        reportsAgainst: Number(r.reports),
        platformRole: r.staff_role,
        joinedAt: r.created_at,
      })),
    };
  }

  async setUserSuspended(auth: AccessClaims, userId: string, suspended: boolean, reason: string) {
    await this.require(auth);
    if (suspended) await this.db.tx((tx) => this.suspendUser(auth.userId, userId, reason, tx));
    else {
      const r = await this.db.query(`UPDATE users SET state = 'active', suspended_at = NULL, suspension_reason = NULL, updated_at = now() WHERE id = $1 AND state = 'suspended'`, [userId]);
      if (!r.rowCount) throw Errors.notFound('Suspended account');
      await this.audit.record({ actorId: auth.userId, action: 'admin.user.unsuspended', targetType: 'user', targetId: userId, metadata: { reason } });
    }
    return (await this.users(auth, userId, 1)).users[0];
  }

  /** Signs the person out everywhere and stops notifications. Staff accounts are protected. */
  private async suspendUser(actorId: string, userId: string, reason: string, tx: Queryable) {
    if (userId === actorId) throw Errors.validation([{ path: 'userId', message: 'You can’t suspend yourself' }]);
    if (await this.db.one('SELECT 1 FROM platform_staff WHERE user_id = $1', [userId], tx)) {
      throw forbidden('staff_protected', 'Remove their staff role before suspending them');
    }
    const r = await this.db.query(
      `UPDATE users SET state = 'suspended', suspended_at = now(), suspension_reason = $2, updated_at = now() WHERE id = $1 AND state IN ('active', 'deactivated')`,
      [userId, reason],
      tx,
    );
    if (!r.rowCount) {
      const already = await this.db.one(`SELECT 1 FROM users WHERE id = $1 AND state = 'suspended'`, [userId], tx);
      if (already) return;
      throw Errors.notFound('User');
    }
    await this.db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'suspended' WHERE user_id = $1 AND revoked_at IS NULL`, [userId], tx);
    await this.db.query('DELETE FROM push_devices WHERE user_id = $1', [userId], tx);
    await this.audit.record({ actorId, action: 'admin.user.suspended', targetType: 'user', targetId: userId, metadata: { reason } }, tx);
  }

  // ---------------------------------------------------------------- businesses

  async businessList(auth: AccessClaims, q: { q?: string; state?: string; limit: number }) {
    await this.require(auth, 'admin');
    const params: unknown[] = [q.limit];
    let where = `b.state <> 'deleted'`;
    if (q.state) {
      params.push(q.state);
      where += ` AND b.state = $${params.length}`;
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      where += ` AND (lower(b.name) LIKE $${params.length} OR b.handle LIKE $${params.length})`;
    }
    const { rows } = await this.db.query<{ id: string; handle: string; name: string; category: string; state: string; suspension_reason: string | null; verified_at: Date | null; created_at: Date; owner_id: string | null; owner_username: string | null; owner_display_name: string | null; reports: string }>(
      `SELECT b.id, b.handle, b.name, b.category, b.state, b.suspension_reason, b.verified_at, b.created_at,
              o.user_id AS owner_id, u.username AS owner_username, u.display_name AS owner_display_name,
              (SELECT count(*) FROM reports r WHERE r.subject_type = 'business' AND r.subject_id IN (b.id::text, b.handle)) AS reports
         FROM businesses b
         LEFT JOIN business_staff o ON o.business_id = b.id AND o.role = 'owner'
         LEFT JOIN users u ON u.id = o.user_id
        WHERE ${where} ORDER BY b.created_at DESC LIMIT $1`,
      params,
    );
    return {
      businesses: rows.map((r) => ({
        id: r.id,
        handle: r.handle,
        name: r.name,
        category: r.category,
        state: r.state,
        suspensionReason: r.suspension_reason,
        verified: !!r.verified_at,
        owner: r.owner_id ? userSummary({ id: r.owner_id, username: r.owner_username, display_name: r.owner_display_name ?? '' }) : null,
        reports: Number(r.reports),
        createdAt: r.created_at,
      })),
    };
  }

  async businessAction(auth: AccessClaims, businessId: string, action: 'verify' | 'unverify' | 'suspend' | 'unsuspend', reason: string) {
    await this.require(auth, 'admin');
    let changed: boolean;
    if (action === 'verify' || action === 'unverify') {
      const r = await this.db.query(`UPDATE businesses SET verified_at = ${action === 'verify' ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1 AND state <> 'deleted'`, [businessId]);
      changed = !!r.rowCount;
    } else {
      changed = await this.businesses.setSuspended(businessId, action === 'suspend', reason);
    }
    if (!changed) throw Errors.conflict('no_change', 'The business is already in that state, or doesn’t exist');
    await this.audit.record({ actorId: auth.userId, action: `admin.business.${action}`, targetType: 'business', targetId: businessId, metadata: { reason } });
    return (await this.businessList(auth, { limit: 200 })).businesses.find((b) => b.id === businessId)!;
  }

  // ---------------------------------------------------------------- integrations (kill switch lives here)

  async integrationList(auth: AccessClaims) {
    await this.require(auth, 'admin');
    return this.integrations.adminList();
  }

  // ---------------------------------------------------------------- platform staff and audit

  async staff(auth: AccessClaims) {
    await this.require(auth, 'admin');
    const { rows } = await this.db.query<{ id: string; username: string | null; display_name: string; role: string; created_at: Date; mfa_enabled_at: Date | null }>(
      `SELECT u.id, u.username, u.display_name, p.role, p.created_at, u.mfa_enabled_at FROM platform_staff p JOIN users u ON u.id = p.user_id ORDER BY p.role DESC, p.created_at`,
    );
    return { staff: rows.map((r) => ({ user: userSummary(r), role: r.role, since: r.created_at, twoStepOn: !!r.mfa_enabled_at })) };
  }

  /** Admins add and remove moderators here. Admins themselves are granted from the command line. */
  async grantModerator(auth: AccessClaims, username: string) {
    await this.require(auth, 'admin');
    const u = await this.db.one<{ id: string }>(`SELECT id FROM users WHERE username = $1 AND state = 'active'`, [username]);
    if (!u) throw Errors.notFound('User');
    const r = await this.db.query(`INSERT INTO platform_staff (user_id, role, granted_by) VALUES ($1, 'moderator', $2) ON CONFLICT DO NOTHING`, [u.id, auth.userId]);
    if (!r.rowCount) throw Errors.conflict('already_staff', 'They are already platform staff');
    await this.audit.record({ actorId: auth.userId, action: 'admin.staff.granted', targetType: 'user', targetId: u.id, metadata: { role: 'moderator' } });
    return this.staff(auth);
  }

  async revokeModerator(auth: AccessClaims, userId: string) {
    await this.require(auth, 'admin');
    const r = await this.db.query(`DELETE FROM platform_staff WHERE user_id = $1 AND role = 'moderator'`, [userId]);
    if (!r.rowCount) throw Errors.notFound('Moderator');
    await this.audit.record({ actorId: auth.userId, action: 'admin.staff.revoked', targetType: 'user', targetId: userId, metadata: { role: 'moderator' } });
  }

  async auditLog(auth: AccessClaims, q: { action?: string; before?: number; limit: number }) {
    await this.require(auth, 'admin');
    const params: unknown[] = [q.limit];
    let where = 'TRUE';
    if (q.action) {
      params.push(`${q.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      where += ` AND a.action LIKE $${params.length}`;
    }
    if (q.before) {
      params.push(q.before);
      where += ` AND a.id < $${params.length}`;
    }
    const { rows } = await this.db.query<{ id: string; actor_id: string | null; username: string | null; display_name: string | null; action: string; target_type: string | null; target_id: string | null; metadata: unknown; created_at: Date }>(
      `SELECT a.id, a.actor_id, u.username, u.display_name, a.action, a.target_type, a.target_id, a.metadata, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where} ORDER BY a.id DESC LIMIT $1`,
      params,
    );
    // IP addresses stay out of the dashboard; they're in the database for security investigations.
    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        actor: r.actor_id ? userSummary({ id: r.actor_id, username: r.username, display_name: r.display_name ?? '' }) : null,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    };
  }
}
