import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { limitFor } from '../payments/entitlements';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { userSummary } from '../social/follows.service';
import { canManageRole, Permission, permissionsOf, StaffRole } from './roles';

export const CATEGORIES = ['food', 'retail', 'beauty', 'health', 'services', 'education', 'entertainment', 'other'] as const;

export interface BusinessInput {
  handle: string;
  name: string;
  description: string;
  category: (typeof CATEGORIES)[number];
  contactEmail?: string | null;
  phone?: string | null;
  address: string;
  timeZone: string;
  currency: string;
}

export type BusinessPatch = Partial<Omit<BusinessInput, 'handle' | 'currency'>> & { ordersEnabled?: boolean; bookingsEnabled?: boolean; inPersonPayments?: boolean };

export interface HoursInput {
  weekday: number;
  opens: string;
  closes: string;
}

interface BusinessRow {
  id: string;
  handle: string;
  name: string;
  description: string;
  category: string;
  contact_email: string | null;
  phone: string | null;
  address: string;
  time_zone: string;
  currency: string;
  orders_enabled: boolean;
  bookings_enabled: boolean;
  in_person_payments: boolean;
  pay_charges: boolean | null;
  pay_livemode: boolean | null;
  state: 'active' | 'suspended' | 'deleted';
  suspension_reason: string | null;
  verified_at: Date | null;
  created_at: Date;
  my_role: StaffRole | null;
  my_state: 'invited' | 'active' | null;
}

const SELECT = `
  SELECT b.id, b.handle, b.name, b.description, b.category, b.contact_email, b.phone, b.address, b.time_zone, b.currency,
         b.orders_enabled, b.bookings_enabled, b.in_person_payments, b.state, b.suspension_reason, b.verified_at, b.created_at,
         pa.charges_enabled AS pay_charges, pa.livemode AS pay_livemode,
         s.role AS my_role, s.state AS my_state
    FROM businesses b
    LEFT JOIN business_staff s ON s.business_id = b.id AND s.user_id = $1
    LEFT JOIN business_payment_accounts pa ON pa.business_id = b.id`;

/** Hidden from customers once suspended; staff still see it (and why) so they can appeal. */
const VISIBLE = `b.state <> 'deleted' AND (b.state = 'active' OR s.state = 'active')`;

/** Accepted currencies: ISO 4217 codes Node knows about. */
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

@Injectable()
export class BusinessesService {
  private readonly logger = new Logger('Businesses');
  private readonly closeHooks: ((businessId: string) => Promise<unknown>)[] = [];

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Work that runs after a business closes (refunds, ending its subscription). */
  onClose(fn: (businessId: string) => Promise<unknown>) {
    this.closeHooks.push(fn);
  }

  /** Online payment is possible when a provider is configured and the payout account (same mode) can take charges. */
  private onlinePayments(r: BusinessRow) {
    const key = this.config.STRIPE_SECRET_KEY ?? '';
    return this.config.PAYMENTS_PROVIDER !== 'none' && !!r.pay_charges && r.pay_livemode === /^(sk|rk)_live_/.test(key);
  }

  private view(r: BusinessRow) {
    const staff = r.my_state === 'active' ? r.my_role : null;
    return {
      id: r.id,
      handle: r.handle,
      name: r.name,
      description: r.description,
      category: r.category,
      contactEmail: r.contact_email,
      phone: r.phone,
      address: r.address,
      timeZone: r.time_zone,
      currency: r.currency,
      ordersEnabled: r.orders_enabled,
      bookingsEnabled: r.bookings_enabled,
      // How customers can pay for orders.
      payments: { online: this.onlinePayments(r), inPerson: r.in_person_payments || !this.onlinePayments(r) },
      verified: !!r.verified_at,
      state: r.state,
      // Only the business's own staff learn why it was suspended.
      suspensionReason: staff ? r.suspension_reason : null,
      createdAt: r.created_at,
      myRole: staff,
      permissions: staff ? permissionsOf(staff) : [],
      invited: r.my_state === 'invited' ? { role: r.my_role } : null,
    };
  }

  async create(userId: string, input: BusinessInput) {
    await this.checkTimeZone(input.timeZone);
    if (!CURRENCIES.has(input.currency)) throw Errors.validation([{ path: 'currency', message: 'Use a three-letter ISO 4217 code such as USD' }]);
    await this.limits.consume({ name: 'business:create', limit: 3, windowSeconds: 86400 }, userId);
    const id = await this.db.tx(async (tx) => {
      const r = await this.db
        .one<{ id: string }>(
          `INSERT INTO businesses (handle, name, description, category, contact_email, phone, address, time_zone, currency, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [input.handle, input.name, input.description, input.category, input.contactEmail ?? null, input.phone ?? null, input.address, input.timeZone, input.currency, userId],
          tx,
        )
        .catch((e) => {
          if (e.code === '23505') throw Errors.conflict('handle_taken', 'That address is taken');
          throw e;
        });
      await this.db.query(`INSERT INTO business_staff (business_id, user_id, role, state) VALUES ($1, $2, 'owner', 'active')`, [r!.id, userId], tx);
      await this.audit.record({ actorId: userId, action: 'business.created', targetType: 'business', targetId: r!.id }, tx);
      return r!.id;
    });
    return this.get(userId, id);
  }

  /** By id or handle. Not found for anyone who may not see it. */
  async get(viewerId: string, ref: string) {
    const byId = /^[0-9a-f-]{36}$/.test(ref);
    const r = await this.db.one<BusinessRow>(`${SELECT} WHERE ${byId ? 'b.id = $2' : 'b.handle = $2'} AND (${VISIBLE} OR s.state = 'invited')`, [viewerId, ref]);
    if (!r || (r.state !== 'active' && r.my_state !== 'active')) throw Errors.notFound('Business');
    return this.view(r);
  }

  async search(viewerId: string, q: string | undefined, category: string | undefined, limit: number) {
    const params: unknown[] = [viewerId, limit];
    let where = `b.state = 'active'`;
    if (q) {
      params.push(q.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').trim().split(/\s+/).filter(Boolean).map((w) => `${w}:*`).join(' & ') || '_');
      where += ` AND to_tsvector('simple', b.name || ' ' || b.handle) @@ to_tsquery('simple', $${params.length})`;
    }
    if (category) {
      params.push(category);
      where += ` AND b.category = $${params.length}`;
    }
    const { rows } = await this.db.query<BusinessRow>(`${SELECT} WHERE ${where} ORDER BY b.verified_at IS NULL, b.name, b.id LIMIT $2`, params);
    return { businesses: rows.map((r) => this.view(r)) };
  }

  /** Businesses I work at, and invitations waiting for me. */
  async mine(userId: string) {
    const { rows } = await this.db.query<BusinessRow>(`${SELECT} WHERE s.user_id IS NOT NULL AND b.state <> 'deleted' ORDER BY s.state DESC, b.name`, [userId]);
    return { businesses: rows.map((r) => this.view(r)) };
  }

  async update(userId: string, businessId: string, patch: BusinessPatch) {
    await this.requireStaff(userId, businessId, 'business.edit');
    if (patch.timeZone) await this.checkTimeZone(patch.timeZone);
    if (patch.inPersonPayments === false && !(await this.get(userId, businessId)).payments.online) {
      throw Errors.conflict('online_payments_unavailable', 'Set up online payments before turning off payment at pickup');
    }
    const columns: Record<string, string> = {
      name: 'name', description: 'description', category: 'category', contactEmail: 'contact_email', phone: 'phone',
      address: 'address', timeZone: 'time_zone', ordersEnabled: 'orders_enabled', bookingsEnabled: 'bookings_enabled',
      inPersonPayments: 'in_person_payments',
    };
    const sets: string[] = [];
    const params: unknown[] = [businessId];
    for (const [k, col] of Object.entries(columns)) {
      if (k in patch) {
        params.push((patch as Record<string, unknown>)[k] ?? null);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length) {
      await this.db.query(`UPDATE businesses SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      await this.audit.record({ actorId: userId, action: 'business.updated', targetType: 'business', targetId: businessId, metadata: { fields: Object.keys(patch) } });
    }
    return this.get(userId, businessId);
  }

  /** Closing a business cancels what is still open, so customers aren't left waiting. */
  async delete(userId: string, businessId: string) {
    await this.requireStaff(userId, businessId, 'business.delete');
    await this.db.tx(async (tx) => this.close(businessId, tx));
    await this.audit.record({ actorId: userId, action: 'business.deleted', targetType: 'business', targetId: businessId });
    await this.afterClose(businessId);
  }

  /** Runs the close hooks. Failures are left to the payments sweep, which settles the same things. */
  async afterClose(businessId: string) {
    for (const fn of this.closeHooks) await fn(businessId).catch((e) => this.logger.warn(`after closing ${businessId}: ${(e as Error).message}`));
  }

  private async close(businessId: string, tx: Queryable) {
    await this.db.query(`UPDATE businesses SET state = 'deleted', orders_enabled = false, bookings_enabled = false, updated_at = now() WHERE id = $1`, [businessId], tx);
    await this.db.query(
      `UPDATE orders SET status = 'cancelled', status_reason = 'The business closed', updated_at = now() WHERE business_id = $1 AND status IN ('pending_payment', 'placed', 'accepted', 'ready')`,
      [businessId],
      tx,
    );
    await this.db.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_by = 'business', updated_at = now() WHERE business_id = $1 AND status = 'confirmed' AND starts_at > now()`,
      [businessId],
      tx,
    );
    await this.db.query(`DELETE FROM business_staff WHERE business_id = $1 AND state = 'invited'`, [businessId], tx);
  }

  // ---------------------------------------------------------------- staff

  /**
   * The caller's role, if they are active staff with the permission. Not found when they
   * are not staff at all (so a business's back office can't be probed), forbidden when
   * they are staff without the permission.
   */
  async requireStaff(userId: string, businessId: string, permission: Permission, db: Queryable = this.db.pool): Promise<StaffRole> {
    const r = await this.db.one<{ role: StaffRole; state: string }>(
      `SELECT s.role, b.state FROM business_staff s JOIN businesses b ON b.id = s.business_id
        WHERE s.business_id = $1 AND s.user_id = $2 AND s.state = 'active' AND b.state <> 'deleted'`,
      [businessId, userId],
      db,
    );
    if (!r) throw Errors.notFound('Business');
    if (!permissionsOf(r.role).includes(permission)) throw Errors.forbidden('Your role at this business doesn’t allow that');
    // A suspended business can be looked at and wound down, but not changed.
    if (r.state === 'suspended' && !['business.view', 'staff.view', 'orders.view', 'bookings.view', 'business.delete', 'orders.refund', 'payments.view', 'billing.manage'].includes(permission)) {
      throw Errors.conflict('business_suspended', 'This business is suspended');
    }
    return r.role;
  }

  async staff(userId: string, businessId: string) {
    await this.requireStaff(userId, businessId, 'staff.view');
    const { rows } = await this.db.query<{ id: string; username: string | null; display_name: string; role: StaffRole; state: string; created_at: Date }>(
      `SELECT u.id, u.username, u.display_name, s.role, s.state, s.created_at FROM business_staff s JOIN users u ON u.id = s.user_id
        WHERE s.business_id = $1 ORDER BY CASE s.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, s.created_at`,
      [businessId],
    );
    return { staff: rows.map((r) => ({ user: userSummary(r), role: r.role, state: r.state, since: r.created_at })) };
  }

  async invite(userId: string, businessId: string, username: string, role: Exclude<StaffRole, 'owner'>) {
    const actor = await this.requireStaff(userId, businessId, 'staff.manage');
    if (!canManageRole(actor, role)) throw Errors.forbidden('You can’t give that role');
    await this.limits.consume({ name: 'business:invite', limit: 50, windowSeconds: 86400 }, userId);
    const max = await limitFor(this.db, businessId, 'staff');
    const n = await this.db.one<{ n: string }>('SELECT count(*) AS n FROM business_staff WHERE business_id = $1', [businessId]);
    if (Number(n!.n) >= max) throw Errors.conflict('staff_limit', `This business can have up to ${max} staff on its plan`, { limit: max });
    const target = await this.db.one<{ id: string }>(`SELECT id FROM users WHERE username = $1 AND state = 'active'`, [username]);
    if (!target) throw Errors.notFound('User');
    const r = await this.db.query(
      `INSERT INTO business_staff (business_id, user_id, role, state, invited_by) VALUES ($1, $2, $3, 'invited', $4) ON CONFLICT DO NOTHING`,
      [businessId, target.id, role, userId],
    );
    if (!r.rowCount) throw Errors.conflict('already_staff', 'They already work here or have been invited');
    await this.audit.record({ actorId: userId, action: 'business.staff.invited', targetType: 'business', targetId: businessId, metadata: { userId: target.id, role } });
    return this.staff(userId, businessId);
  }

  async acceptInvite(userId: string, businessId: string) {
    const r = await this.db.query(
      `UPDATE business_staff s SET state = 'active' FROM businesses b
        WHERE s.business_id = $1 AND s.user_id = $2 AND s.state = 'invited' AND b.id = s.business_id AND b.state = 'active'`,
      [businessId, userId],
    );
    if (!r.rowCount) throw Errors.notFound('Invitation');
    await this.audit.record({ actorId: userId, action: 'business.staff.joined', targetType: 'business', targetId: businessId });
    return this.get(userId, businessId);
  }

  async changeRole(userId: string, businessId: string, targetId: string, role: Exclude<StaffRole, 'owner'>) {
    const actor = await this.requireStaff(userId, businessId, 'staff.manage');
    if (targetId === userId) throw Errors.forbidden('You can’t change your own role');
    const t = await this.db.one<{ role: StaffRole }>('SELECT role FROM business_staff WHERE business_id = $1 AND user_id = $2', [businessId, targetId]);
    if (!t) throw Errors.notFound('Staff member');
    if (!canManageRole(actor, t.role) || !canManageRole(actor, role)) throw Errors.forbidden('You can’t give that role');
    await this.db.query('UPDATE business_staff SET role = $3 WHERE business_id = $1 AND user_id = $2', [businessId, targetId, role]);
    await this.audit.record({ actorId: userId, action: 'business.staff.role_changed', targetType: 'business', targetId: businessId, metadata: { userId: targetId, from: t.role, to: role } });
    return this.staff(userId, businessId);
  }

  /** Removing someone (managers and the owner), or leaving / declining (anyone but the owner). */
  async removeStaff(userId: string, businessId: string, targetId: string) {
    if (targetId === userId) {
      const me = await this.db.one<{ role: StaffRole }>('SELECT role FROM business_staff WHERE business_id = $1 AND user_id = $2', [businessId, userId]);
      if (!me) throw Errors.notFound('Business');
      if (me.role === 'owner') throw Errors.conflict('owner_cannot_leave', 'Hand the business to a manager before you leave');
    } else {
      const actor = await this.requireStaff(userId, businessId, 'staff.manage');
      const t = await this.db.one<{ role: StaffRole }>('SELECT role FROM business_staff WHERE business_id = $1 AND user_id = $2', [businessId, targetId]);
      if (!t) throw Errors.notFound('Staff member');
      if (!canManageRole(actor, t.role)) throw Errors.forbidden('You can’t remove them');
    }
    await this.db.query('DELETE FROM business_staff WHERE business_id = $1 AND user_id = $2', [businessId, targetId]);
    await this.audit.record({ actorId: userId, action: 'business.staff.removed', targetType: 'business', targetId: businessId, metadata: { userId: targetId } });
  }

  async transferOwnership(userId: string, businessId: string, targetId: string) {
    await this.db.tx(async (tx) => {
      await this.requireStaff(userId, businessId, 'business.transfer', tx);
      const t = await this.db.one<{ role: StaffRole }>(
        `SELECT role FROM business_staff WHERE business_id = $1 AND user_id = $2 AND state = 'active' FOR UPDATE`,
        [businessId, targetId],
        tx,
      );
      if (!t || t.role !== 'manager') throw Errors.validation([{ path: 'userId', message: 'Ownership can only go to a manager' }]);
      await this.db.query(`UPDATE business_staff SET role = 'manager' WHERE business_id = $1 AND user_id = $2`, [businessId, userId], tx);
      await this.db.query(`UPDATE business_staff SET role = 'owner' WHERE business_id = $1 AND user_id = $2`, [businessId, targetId], tx);
      await this.audit.record({ actorId: userId, action: 'business.ownership_transferred', targetType: 'business', targetId: businessId, metadata: { to: targetId } }, tx);
    });
    return this.staff(userId, businessId);
  }

  /** Active staff ids, for live updates. */
  async staffIds(businessId: string, db: Queryable = this.db.pool): Promise<string[]> {
    const { rows } = await this.db.query<{ user_id: string }>(`SELECT user_id FROM business_staff WHERE business_id = $1 AND state = 'active'`, [businessId], db);
    return rows.map((r) => r.user_id);
  }

  // ---------------------------------------------------------------- opening hours

  async hours(businessId: string) {
    const { rows } = await this.db.query<{ weekday: number; opens: string; closes: string }>(
      `SELECT weekday, to_char(opens, 'HH24:MI') AS opens, to_char(closes, 'HH24:MI') AS closes FROM business_hours WHERE business_id = $1 ORDER BY weekday, opens`,
      [businessId],
    );
    return { hours: rows };
  }

  async setHours(userId: string, businessId: string, hours: HoursInput[]) {
    await this.requireStaff(userId, businessId, 'business.edit');
    const byDay = new Map<number, HoursInput[]>();
    for (const h of hours) byDay.set(h.weekday, [...(byDay.get(h.weekday) ?? []), h]);
    for (const [day, list] of byDay) {
      list.sort((a, b) => a.opens.localeCompare(b.opens));
      for (let i = 0; i < list.length; i++) {
        if (list[i].closes <= list[i].opens) throw Errors.validation([{ path: 'hours', message: `Closing time must be after opening time (day ${day})` }]);
        if (i > 0 && list[i].opens < list[i - 1].closes) throw Errors.validation([{ path: 'hours', message: `Opening times overlap (day ${day})` }]);
      }
    }
    await this.db.tx(async (tx) => {
      await this.db.query('DELETE FROM business_hours WHERE business_id = $1', [businessId], tx);
      for (const h of hours) {
        await this.db.query('INSERT INTO business_hours (business_id, weekday, opens, closes) VALUES ($1, $2, $3, $4)', [businessId, h.weekday, h.opens, h.closes], tx);
      }
    });
    return this.hours(businessId);
  }

  // ---------------------------------------------------------------- moderation and accounts

  /** Platform staff action (admin dashboard). */
  async setSuspended(businessId: string, suspended: boolean, reason: string, tx?: Queryable) {
    const r = await this.db.query(
      suspended
        ? `UPDATE businesses SET state = 'suspended', suspension_reason = $2, updated_at = now() WHERE id = $1 AND state = 'active'`
        : `UPDATE businesses SET state = 'active', suspension_reason = NULL, updated_at = now() WHERE id = $1 AND state = 'suspended'`,
      suspended ? [businessId, reason] : [businessId],
      tx,
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Account deletion. An owner's business passes to its longest-serving manager; with no
   * manager it closes. Orders and bookings stay with the business, detached from the person.
   */
  async scrubUser(userId: string, tx: Queryable): Promise<string[]> {
    const closed: string[] = [];
    const owned = await this.db.query<{ business_id: string }>(`SELECT business_id FROM business_staff WHERE user_id = $1 AND role = 'owner'`, [userId], tx);
    for (const { business_id } of owned.rows) {
      const heir = await this.db.one<{ user_id: string }>(
        `SELECT user_id FROM business_staff WHERE business_id = $1 AND role = 'manager' AND state = 'active' ORDER BY created_at LIMIT 1`,
        [business_id],
        tx,
      );
      await this.db.query('DELETE FROM business_staff WHERE business_id = $1 AND user_id = $2', [business_id, userId], tx);
      if (heir) await this.db.query(`UPDATE business_staff SET role = 'owner' WHERE business_id = $1 AND user_id = $2`, [business_id, heir.user_id], tx);
      else {
        await this.close(business_id, tx);
        closed.push(business_id);
      }
    }
    await this.db.query('DELETE FROM business_staff WHERE user_id = $1', [userId], tx);
    await this.db.query(
      `UPDATE orders SET status = 'cancelled', status_reason = 'Customer account deleted', updated_at = now() WHERE customer_id = $1 AND status IN ('pending_payment', 'placed', 'accepted', 'ready')`,
      [userId],
      tx,
    );
    await this.db.query(`UPDATE bookings SET status = 'cancelled', cancelled_by = 'customer', updated_at = now() WHERE customer_id = $1 AND status = 'confirmed' AND starts_at > now()`, [userId], tx);
    await this.db.query(`UPDATE orders SET customer_id = NULL, note = '' WHERE customer_id = $1`, [userId], tx);
    await this.db.query(`UPDATE bookings SET customer_id = NULL, note = '' WHERE customer_id = $1`, [userId], tx);
    await this.db.query('UPDATE payments SET payer_id = NULL WHERE payer_id = $1', [userId], tx);
    return closed;
  }

  async exportFor(userId: string) {
    const [staff, orders, bookings] = await Promise.all([
      this.db.query(`SELECT b.id, b.handle, b.name, s.role, s.state, s.created_at FROM business_staff s JOIN businesses b ON b.id = s.business_id WHERE s.user_id = $1`, [userId]),
      this.db.query(
        `SELECT o.id, o.business_id, o.status, o.note, o.total_minor, o.currency, o.created_at,
                (SELECT json_agg(json_build_object('name', i.name, 'unitPriceMinor', i.unit_price_minor, 'quantity', i.quantity) ORDER BY i.position)
                   FROM order_items i WHERE i.order_id = o.id) AS items
           FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at`,
        [userId],
      ),
      this.db.query(`SELECT id, business_id, service_id, starts_at, ends_at, status, note, created_at FROM bookings WHERE customer_id = $1 ORDER BY starts_at`, [userId]),
    ]);
    return { businessRoles: staff.rows, orders: orders.rows, bookings: bookings.rows };
  }

  private async checkTimeZone(tz: string) {
    const ok = await this.db.one('SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz]);
    if (!ok) throw Errors.validation([{ path: 'timeZone', message: 'Use an IANA time zone such as Europe/London' }]);
  }
}
