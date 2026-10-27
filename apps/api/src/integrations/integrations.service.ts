import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { Errors } from '../common/errors';
import { DatabaseService } from '../database/database.service';

/**
 * What an integration may ask a person for. Nothing here exposes messages, contacts or
 * tokens (ADR 0006). The partner API that would use these grants is not built yet.
 */
export const SCOPES = {
  'profile.basic': 'Your display name and username',
  email: 'Your email address',
  'orders.read': 'Orders you place through it',
  'bookings.read': 'Bookings you make through it',
  'notifications.send': 'Send you notifications',
} as const;
export type Scope = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as Scope[];

export const INTEGRATION_CATEGORIES = ['food', 'bookings', 'tickets', 'travel', 'shopping', 'utilities', 'other'] as const;

export interface IntegrationInput {
  slug: string;
  name: string;
  description: string;
  category: (typeof INTEGRATION_CATEGORIES)[number];
  developerName: string;
  developerContact: string;
  homepageUrl: string;
  scopes: Scope[];
  version: string;
}

interface Row {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  developer_name: string;
  developer_contact: string;
  homepage_url: string;
  scopes: Scope[];
  version: string;
  state: 'draft' | 'live' | 'disabled';
  disabled_reason: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  granted_scopes: Scope[] | null;
  granted_at: Date | null;
}

const SELECT = `
  SELECT i.*, g.scopes AS granted_scopes, g.granted_at FROM integrations i
    LEFT JOIN integration_grants g ON g.integration_id = i.id AND g.user_id = $1`;

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private view(r: Row, admin = false) {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      category: r.category,
      developer: { name: r.developer_name, ...(admin ? { contact: r.developer_contact } : {}) },
      homepageUrl: r.homepage_url,
      scopes: r.scopes.map((s) => ({ scope: s, description: SCOPES[s] })),
      version: r.version,
      state: r.state,
      ...(admin ? { disabledReason: r.disabled_reason, reviewedAt: r.reviewed_at, createdAt: r.created_at, updatedAt: r.updated_at } : {}),
      // A switched-off integration keeps the person's grant on record but can't use it.
      grant: r.granted_scopes ? { scopes: r.granted_scopes, grantedAt: r.granted_at, active: r.state === 'live' } : null,
    };
  }

  // ---------------------------------------------------------------- people

  async catalogue(userId: string, category?: string) {
    const params: unknown[] = [userId];
    let where = `i.state = 'live'`;
    if (category) {
      params.push(category);
      where += ` AND i.category = $2`;
    }
    const { rows } = await this.db.query<Row>(`${SELECT} WHERE ${where} ORDER BY i.name`, params);
    return { integrations: rows.map((r) => this.view(r)) };
  }

  async get(userId: string, slug: string) {
    const r = await this.db.one<Row>(`${SELECT} WHERE i.slug = $2 AND (i.state = 'live' OR g.user_id IS NOT NULL)`, [userId, slug]);
    if (!r) throw Errors.notFound('Integration');
    return this.view(r);
  }

  /** Grants exactly the scopes chosen, which must be ones the integration asks for. */
  async connect(userId: string, slug: string, scopes: Scope[]) {
    const i = await this.db.one<{ id: string; scopes: Scope[]; state: string }>('SELECT id, scopes, state FROM integrations WHERE slug = $1', [slug]);
    if (!i || i.state !== 'live') throw Errors.notFound('Integration');
    const extra = scopes.filter((s) => !i.scopes.includes(s));
    if (extra.length) throw Errors.validation([{ path: 'scopes', message: `It doesn’t ask for: ${extra.join(', ')}` }]);
    const unique = [...new Set(scopes)].sort();
    await this.db.query(
      `INSERT INTO integration_grants (user_id, integration_id, scopes) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, integration_id) DO UPDATE SET scopes = EXCLUDED.scopes, granted_at = date_trunc('milliseconds', now())`,
      [userId, i.id, unique],
    );
    await this.audit.record({ actorId: userId, action: 'integration.connected', targetType: 'integration', targetId: i.id, metadata: { scopes: unique } });
    return this.get(userId, slug);
  }

  async connected(userId: string) {
    const { rows } = await this.db.query<Row>(`${SELECT} WHERE g.user_id IS NOT NULL ORDER BY g.granted_at DESC`, [userId]);
    return { integrations: rows.map((r) => this.view(r)) };
  }

  async disconnect(userId: string, slug: string) {
    const r = await this.db.one<{ integration_id: string }>(
      `DELETE FROM integration_grants g USING integrations i WHERE g.integration_id = i.id AND i.slug = $2 AND g.user_id = $1 RETURNING g.integration_id`,
      [userId, slug],
    );
    if (!r) throw Errors.notFound('Connection');
    await this.audit.record({ actorId: userId, action: 'integration.disconnected', targetType: 'integration', targetId: r.integration_id });
  }

  /**
   * The check a partner-facing API must make before handing over anything: the integration
   * is live and the person granted this scope. Used by tests until that API exists.
   */
  async hasGrant(userId: string, integrationId: string, scope: Scope) {
    return !!(await this.db.one(
      `SELECT 1 FROM integration_grants g JOIN integrations i ON i.id = g.integration_id
        WHERE g.user_id = $1 AND g.integration_id = $2 AND i.state = 'live' AND $3 = ANY(g.scopes)`,
      [userId, integrationId, scope],
    ));
  }

  // ---------------------------------------------------------------- platform admins

  async adminList() {
    const { rows } = await this.db.query<Row & { grant_count: string }>(
      `SELECT i.*, NULL::text[] AS granted_scopes, NULL::timestamptz AS granted_at,
              (SELECT count(*) FROM integration_grants g WHERE g.integration_id = i.id) AS grant_count
         FROM integrations i ORDER BY i.state, i.name`,
    );
    return { integrations: rows.map((r) => ({ ...this.view(r, true), connections: Number(r.grant_count) })) };
  }

  private async adminGet(id: string) {
    const r = await this.db.one<Row>(`SELECT i.*, NULL::text[] AS granted_scopes, NULL::timestamptz AS granted_at FROM integrations i WHERE i.id = $1`, [id]);
    if (!r) throw Errors.notFound('Integration');
    return this.view(r, true);
  }

  async create(adminId: string, input: IntegrationInput) {
    const r = await this.db
      .one<{ id: string }>(
        `INSERT INTO integrations (slug, name, description, category, developer_name, developer_contact, homepage_url, scopes, version, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [input.slug, input.name, input.description, input.category, input.developerName, input.developerContact, input.homepageUrl, [...new Set(input.scopes)].sort(), input.version, adminId],
      )
      .catch((e) => {
        if (e.code === '23505') throw Errors.conflict('slug_taken', 'That address is taken');
        throw e;
      });
    await this.audit.record({ actorId: adminId, action: 'admin.integration.created', targetType: 'integration', targetId: r!.id });
    return this.adminGet(r!.id);
  }

  /**
   * Edits go back to draft for another review when the integration asks for more than it
   * did. Narrowing scopes trims every existing grant to match.
   */
  async update(adminId: string, id: string, patch: Partial<Omit<IntegrationInput, 'slug'>>) {
    await this.db.tx(async (tx) => {
      const cur = await this.db.one<{ scopes: Scope[]; state: string }>('SELECT scopes, state FROM integrations WHERE id = $1 FOR UPDATE', [id], tx);
      if (!cur) throw Errors.notFound('Integration');
      const columns: Record<string, string> = {
        name: 'name', description: 'description', category: 'category', developerName: 'developer_name',
        developerContact: 'developer_contact', homepageUrl: 'homepage_url', scopes: 'scopes', version: 'version',
      };
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, col] of Object.entries(columns)) {
        if (k in patch) {
          const v = (patch as Record<string, unknown>)[k];
          params.push(k === 'scopes' ? [...new Set(v as Scope[])].sort() : v);
          sets.push(`${col} = $${params.length}`);
        }
      }
      const widened = patch.scopes?.some((s) => !cur.scopes.includes(s));
      if (widened && cur.state === 'live') sets.push(`state = 'draft', reviewed_at = NULL, reviewed_by = NULL`);
      if (sets.length) await this.db.query(`UPDATE integrations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params, tx);
      if (patch.scopes) {
        await this.db.query(
          `UPDATE integration_grants SET scopes = ARRAY(SELECT unnest(scopes) INTERSECT SELECT unnest($2::text[]) ORDER BY 1) WHERE integration_id = $1`,
          [id, patch.scopes],
          tx,
        );
      }
      await this.audit.record({ actorId: adminId, action: 'admin.integration.updated', targetType: 'integration', targetId: id, metadata: { fields: Object.keys(patch), backToReview: !!widened } }, tx);
    });
    return this.adminGet(id);
  }

  /** Publish after review, or flip the kill switch. Switching off takes effect on the next check. */
  async setState(adminId: string, id: string, state: 'live' | 'disabled' | 'draft', reason: string) {
    const r = await this.db.query(
      state === 'live'
        ? `UPDATE integrations SET state = 'live', disabled_reason = NULL, reviewed_by = $2, reviewed_at = now(), updated_at = now() WHERE id = $1`
        : state === 'disabled'
          ? `UPDATE integrations SET state = 'disabled', disabled_reason = $2, updated_at = now() WHERE id = $1`
          : `UPDATE integrations SET state = 'draft', reviewed_by = NULL, reviewed_at = NULL, updated_at = now() WHERE id = $1`,
      state === 'live' ? [id, adminId] : state === 'disabled' ? [id, reason] : [id],
    );
    if (!r.rowCount) throw Errors.notFound('Integration');
    await this.audit.record({ actorId: adminId, action: `admin.integration.${state === 'live' ? 'published' : state === 'disabled' ? 'disabled' : 'unpublished'}`, targetType: 'integration', targetId: id, metadata: { reason } });
    return this.adminGet(id);
  }

  async exportFor(userId: string) {
    const { rows } = await this.db.query(
      `SELECT i.slug, i.name, g.scopes, g.granted_at FROM integration_grants g JOIN integrations i ON i.id = g.integration_id WHERE g.user_id = $1 ORDER BY g.granted_at`,
      [userId],
    );
    return rows;
  }
}
