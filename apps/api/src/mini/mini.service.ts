import { Injectable } from '@nestjs/common';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService } from '../database/database.service';
import { BusinessesService } from '../business/businesses.service';
import type { BlockT, MiniProgramT } from './mini.schemas';

interface Row {
  id: string;
  business_id: string;
  draft: MiniProgramT;
  published: MiniProgramT | null;
  published_at: Date | null;
  updated_at: Date;
}

interface ListRow {
  id: string;
  published: MiniProgramT;
  business_id: string;
  handle: string;
  business_name: string;
  verified: boolean;
}

/**
 * Mini-programs: a business's own small app inside SuperApp. Staff who may edit the business
 * edit a draft and publish it; customers see only the published copy, only while the business
 * is active. Order, book and call buttons use the business's existing order, booking and
 * contact settings, so a mini-program can never take a payment or a booking on its own terms.
 */
@Injectable()
export class MiniProgramsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly businesses: BusinessesService,
    private readonly limits: RateLimitService,
  ) {}

  /** For the business's staff: the draft and what is live. */
  async forBusiness(userId: string, businessId: string) {
    await this.businesses.requireStaff(userId, businessId, 'business.view');
    const r = await this.db.one<Row>('SELECT * FROM mini_programs WHERE business_id = $1', [businessId]);
    return r ? this.staffDto(r) : null;
  }

  async saveDraft(userId: string, businessId: string, draft: MiniProgramT) {
    await this.businesses.requireStaff(userId, businessId, 'business.edit');
    await this.limits.consume({ name: 'mini:save', limit: 300, windowSeconds: 3600 }, userId);
    const r = await this.db.one<Row>(
      `INSERT INTO mini_programs (business_id, draft) VALUES ($1, $2)
       ON CONFLICT (business_id) DO UPDATE SET draft = EXCLUDED.draft, updated_at = now() RETURNING *`,
      [businessId, JSON.stringify(draft)],
    );
    return this.staffDto(r!);
  }

  async publish(userId: string, businessId: string) {
    await this.businesses.requireStaff(userId, businessId, 'business.edit');
    const r = await this.db.one<Row>(
      `UPDATE mini_programs SET published = draft, published_at = now(), updated_at = now() WHERE business_id = $1 RETURNING *`,
      [businessId],
    );
    if (!r) throw Errors.conflict('nothing_to_publish', 'Save your mini-program first');
    return this.staffDto(r);
  }

  async unpublish(userId: string, businessId: string) {
    await this.businesses.requireStaff(userId, businessId, 'business.edit');
    const r = await this.db.one<Row>(`UPDATE mini_programs SET published = NULL, published_at = NULL, updated_at = now() WHERE business_id = $1 RETURNING *`, [businessId]);
    if (!r) throw Errors.notFound('Mini-program');
    return this.staffDto(r);
  }

  /** Published mini-programs of active businesses, by name. */
  async list(q: string | undefined, limit: number) {
    const params: unknown[] = [limit];
    let where = '';
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      where = `AND (m.published->>'name' ILIKE $2 OR b.name ILIKE $2)`;
    }
    const { rows } = await this.db.query<ListRow>(
      `SELECT m.id, m.published, b.id AS business_id, b.handle, b.name AS business_name, b.verified_at IS NOT NULL AS verified
         FROM mini_programs m JOIN businesses b ON b.id = m.business_id
        WHERE m.published IS NOT NULL AND b.state = 'active' ${where}
        ORDER BY b.verified_at IS NULL, m.published->>'name', m.id LIMIT $1`,
      params,
    );
    return { miniPrograms: rows.map(card) };
  }

  /** What this person opened lately, newest first. */
  async recents(userId: string) {
    const { rows } = await this.db.query<ListRow>(
      `SELECT m.id, m.published, b.id AS business_id, b.handle, b.name AS business_name, b.verified_at IS NOT NULL AS verified
         FROM mini_program_recents r JOIN mini_programs m ON m.id = r.mini_program_id JOIN businesses b ON b.id = m.business_id
        WHERE r.user_id = $1 AND m.published IS NOT NULL AND b.state = 'active'
        ORDER BY r.opened_at DESC LIMIT 12`,
      [userId],
    );
    return { miniPrograms: rows.map(card) };
  }

  /** Opens a published mini-program: its pages, and the business details its blocks use. */
  async open(userId: string, id: string) {
    const m = await this.db.one<{ id: string; business_id: string; published: MiniProgramT | null; published_at: Date | null }>(
      `SELECT m.id, m.business_id, m.published, m.published_at FROM mini_programs m JOIN businesses b ON b.id = m.business_id
        WHERE m.id = $1 AND m.published IS NOT NULL AND b.state = 'active'`,
      [id],
    );
    if (!m) throw Errors.notFound('Mini-program');
    const business = await this.businesses.get(userId, m.business_id);
    await this.db.query(
      `INSERT INTO mini_program_recents (user_id, mini_program_id) VALUES ($1, $2)
       ON CONFLICT (user_id, mini_program_id) DO UPDATE SET opened_at = now()`,
      [userId, m.id],
    );
    return { id: m.id, ...m.published!, publishedAt: m.published_at, business };
  }

  private staffDto(r: Row) {
    return { id: r.id, businessId: r.business_id, draft: r.draft, published: r.published, publishedAt: r.published_at, updatedAt: r.updated_at };
  }
}

function card(r: ListRow) {
  const blocks: BlockT[] = r.published.pages.flatMap((p) => p.blocks);
  return {
    id: r.id,
    name: r.published.name,
    tagline: r.published.tagline,
    icon: r.published.icon,
    accent: r.published.accent,
    business: { id: r.business_id, handle: r.handle, name: r.business_name, verified: r.verified },
    hasMenu: blocks.some((b) => b.type === 'items'),
  };
}
