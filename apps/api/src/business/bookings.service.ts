import { Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { PayableHooks, PaymentsService, paymentStatus } from '../payments/payments.service';
import { RealtimeBus } from '../realtime/realtime-bus.service';
import { userSummary } from '../social/follows.service';
import { BusinessesService } from './businesses.service';

export interface ServiceInput {
  name: string;
  description: string;
  durationMinutes: number;
  priceMinor: number;
  capacity: number;
  active: boolean;
  /** Paid online when booking; 0 means everything is paid in person. At most the price. */
  depositMinor: number;
  /** The deposit is refunded if the customer cancels at least this many hours before. */
  freeCancelHours: number;
}

/** How far ahead people can book. */
export const MAX_DAYS_AHEAD = 90;

interface ServiceRow {
  id: string;
  business_id: string;
  name: string;
  description: string;
  duration_minutes: number;
  price_minor: string;
  capacity: number;
  active: boolean;
  deposit_minor: string;
  free_cancel_hours: number;
}

type BookingStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

interface BookingRow {
  id: string;
  business_id: string;
  business_handle: string;
  business_name: string;
  time_zone: string;
  service_id: string;
  service_name: string;
  customer_id: string | null;
  customer_username: string | null;
  customer_display_name: string | null;
  starts_at: Date;
  ends_at: Date;
  status: BookingStatus;
  cancelled_by: string | null;
  note: string;
  currency: string;
  price_minor: string;
  deposit_minor: string;
  free_cancel_until: Date | null;
  refund_due: boolean;
  created_at: Date;
  pay_status: 'requires_payment' | 'succeeded' | 'cancelled' | null;
  pay_refunded: string | null;
}

const BOOKING_SELECT = `
  SELECT k.id, k.business_id, b.handle AS business_handle, b.name AS business_name, b.time_zone, k.service_id, s.name AS service_name,
         k.customer_id, u.username AS customer_username, u.display_name AS customer_display_name,
         k.starts_at, k.ends_at, k.status, k.cancelled_by, k.note, b.currency, k.price_minor, k.deposit_minor, k.free_cancel_until, k.refund_due,
         k.created_at, p.status AS pay_status, p.refunded_minor AS pay_refunded
    FROM bookings k JOIN businesses b ON b.id = k.business_id JOIN booking_services s ON s.id = k.service_id
    LEFT JOIN users u ON u.id = k.customer_id LEFT JOIN payments p ON p.booking_id = k.id`;

/** Bookings that hold a place: confirmed, and those waiting for their deposit. */
const HOLDS_PLACE = `('pending_payment', 'confirmed')`;

/**
 * Free start times for one service on one local date: steps of the service's length from
 * each opening, that end by closing, are in the future, and still have room. Opening hours
 * are in the business's time zone; the times returned are absolute (UTC).
 */
const SLOTS_SQL = `
  WITH svc AS (
    SELECT s.id, s.duration_minutes, s.capacity, b.id AS business_id, b.time_zone
      FROM booking_services s JOIN businesses b ON b.id = s.business_id
     WHERE s.id = $1 AND s.business_id = $2
  ), starts AS (
    SELECT (gs AT TIME ZONE svc.time_zone) AS starts_at, svc.duration_minutes, svc.capacity, svc.id
      FROM svc
      JOIN business_hours h ON h.business_id = svc.business_id AND h.weekday = extract(dow FROM $3::date)
      CROSS JOIN LATERAL generate_series(
        $3::date + h.opens,
        $3::date + h.closes - make_interval(mins => svc.duration_minutes),
        make_interval(mins => svc.duration_minutes)) gs
  )
  SELECT st.starts_at, st.starts_at + make_interval(mins => st.duration_minutes) AS ends_at,
         st.capacity - (SELECT count(*) FROM bookings k
                         WHERE k.service_id = st.id AND k.status IN ${HOLDS_PLACE}
                           AND tstzrange(k.starts_at, k.ends_at) && tstzrange(st.starts_at, st.starts_at + make_interval(mins => st.duration_minutes)))::int AS remaining
    FROM starts st
   WHERE st.starts_at > now() AND st.starts_at < now() + make_interval(days => ${MAX_DAYS_AHEAD})
   ORDER BY st.starts_at`;

@Injectable()
export class BookingsService implements OnModuleInit, PayableHooks {
  constructor(
    private readonly db: DatabaseService,
    private readonly businesses: BusinessesService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    private readonly bus: RealtimeBus,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit() {
    this.payments.useBookings(this);
    this.businesses.onClose(() => this.payments.settleBookings());
  }

  // ---------------------------------------------------------------- services

  private serviceView(r: ServiceRow, currency: string) {
    return {
      id: r.id,
      businessId: r.business_id,
      name: r.name,
      description: r.description,
      durationMinutes: r.duration_minutes,
      priceMinor: Number(r.price_minor),
      currency,
      capacity: r.capacity,
      active: r.active,
      depositMinor: Number(r.deposit_minor),
      freeCancelHours: r.free_cancel_hours,
    };
  }

  /** A deposit is part of the price, and needs the business to be able to take payment online. */
  private async checkDeposit(businessId: string, depositMinor: number, priceMinor: number) {
    if (depositMinor > priceMinor) throw Errors.validation([{ path: 'depositMinor', message: 'The deposit can’t be more than the price' }]);
    if (depositMinor > 0 && !(await this.payments.onlineAvailable(businessId))) {
      throw Errors.conflict('online_payments_unavailable', 'Set up payouts before asking for a deposit');
    }
  }

  async services(viewerId: string, businessRef: string, all: boolean) {
    const b = await this.businesses.get(viewerId, businessRef);
    if (all) await this.businesses.requireStaff(viewerId, b.id, 'business.view');
    const { rows } = await this.db.query<ServiceRow>(
      `SELECT * FROM booking_services WHERE business_id = $1 AND archived_at IS NULL ${all ? '' : 'AND active'} ORDER BY name, created_at`,
      [b.id],
    );
    return { services: rows.map((r) => this.serviceView(r, b.currency)) };
  }

  async createService(userId: string, businessId: string, input: ServiceInput) {
    await this.businesses.requireStaff(userId, businessId, 'services.manage');
    await this.checkDeposit(businessId, input.depositMinor, input.priceMinor);
    const r = await this.db.one<ServiceRow>(
      `INSERT INTO booking_services (business_id, name, description, duration_minutes, price_minor, capacity, active, deposit_minor, free_cancel_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [businessId, input.name, input.description, input.durationMinutes, input.priceMinor, input.capacity, input.active, input.depositMinor, input.freeCancelHours],
    );
    return this.serviceView(r!, await this.currency(businessId));
  }

  /** Changing the length, capacity, price or deposit leaves existing bookings as they are. */
  async updateService(userId: string, businessId: string, serviceId: string, patch: Partial<ServiceInput>) {
    await this.businesses.requireStaff(userId, businessId, 'services.manage');
    if ('depositMinor' in patch || 'priceMinor' in patch) {
      const cur = await this.db.one<ServiceRow>('SELECT * FROM booking_services WHERE id = $1 AND business_id = $2 AND archived_at IS NULL', [serviceId, businessId]);
      if (!cur) throw Errors.notFound('Service');
      const deposit = patch.depositMinor ?? Number(cur.deposit_minor);
      // Raising the deposit needs online payments; keeping or lowering an existing one doesn't.
      if (deposit > Number(cur.deposit_minor) || deposit > (patch.priceMinor ?? Number(cur.price_minor))) {
        await this.checkDeposit(businessId, deposit, patch.priceMinor ?? Number(cur.price_minor));
      }
    }
    const columns: Record<string, string> = {
      name: 'name',
      description: 'description',
      durationMinutes: 'duration_minutes',
      priceMinor: 'price_minor',
      capacity: 'capacity',
      active: 'active',
      depositMinor: 'deposit_minor',
      freeCancelHours: 'free_cancel_hours',
    };
    const sets: string[] = [];
    const params: unknown[] = [serviceId, businessId];
    for (const [k, col] of Object.entries(columns)) {
      if (k in patch) {
        params.push((patch as Record<string, unknown>)[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) throw Errors.validation([{ path: '', message: 'Nothing to change' }]);
    const r = await this.db.one<ServiceRow>(`UPDATE booking_services SET ${sets.join(', ')} WHERE id = $1 AND business_id = $2 AND archived_at IS NULL RETURNING *`, params);
    if (!r) throw Errors.notFound('Service');
    return this.serviceView(r, await this.currency(businessId));
  }

  async archiveService(userId: string, businessId: string, serviceId: string) {
    await this.businesses.requireStaff(userId, businessId, 'services.manage');
    const r = await this.db.query('UPDATE booking_services SET archived_at = now(), active = false WHERE id = $1 AND business_id = $2 AND archived_at IS NULL', [serviceId, businessId]);
    if (!r.rowCount) throw Errors.notFound('Service');
  }

  private async currency(businessId: string) {
    return (await this.db.one<{ currency: string }>('SELECT currency FROM businesses WHERE id = $1', [businessId]))!.currency;
  }

  // ---------------------------------------------------------------- availability

  async slots(viewerId: string, businessRef: string, serviceId: string, date: string) {
    const b = await this.businesses.get(viewerId, businessRef);
    const svc = await this.db.one('SELECT 1 FROM booking_services WHERE id = $1 AND business_id = $2 AND active AND archived_at IS NULL', [serviceId, b.id]);
    if (!svc) throw Errors.notFound('Service');
    if (!b.bookingsEnabled || b.state !== 'active') return { date, timeZone: b.timeZone, slots: [] };
    const { rows } = await this.db.query<{ starts_at: Date; ends_at: Date; remaining: number }>(SLOTS_SQL, [serviceId, b.id, date]);
    return {
      date,
      timeZone: b.timeZone,
      slots: rows.filter((r) => r.remaining > 0).map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at, remaining: r.remaining })),
    };
  }

  // ---------------------------------------------------------------- bookings

  private bookingView(r: BookingRow, forStaff: boolean) {
    const deposit = Number(r.deposit_minor);
    return {
      id: r.id,
      business: { id: r.business_id, handle: r.business_handle, name: r.business_name, timeZone: r.time_zone },
      service: { id: r.service_id, name: r.service_name },
      customer: forStaff ? (r.customer_id ? userSummary({ id: r.customer_id, username: r.customer_username, display_name: r.customer_display_name ?? '' }) : null) : undefined,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      cancelledBy: r.cancelled_by,
      note: r.note,
      currency: r.currency,
      priceMinor: Number(r.price_minor),
      // Paid online when booking. Kept on a late cancellation or a no-show; refunded otherwise.
      deposit: deposit
        ? {
            amountMinor: deposit,
            status: r.pay_status ? paymentStatus(r.pay_status, deposit, Number(r.pay_refunded ?? 0)) : null,
            refundedMinor: Number(r.pay_refunded ?? 0),
            freeCancelUntil: r.free_cancel_until,
            refundDue: r.refund_due,
          }
        : null,
      createdAt: r.created_at,
    };
  }

  private load(id: string, db: Queryable = this.db.pool) {
    return this.db.one<BookingRow>(`${BOOKING_SELECT} WHERE k.id = $1`, [id], db);
  }

  /**
   * Books a slot. The service row is locked while capacity is counted, so two people can't
   * take the last place at once. A retry with the same clientId returns the first booking.
   */
  async book(customerId: string, businessRef: string, input: { serviceId: string; startsAt: string; clientId: string; note: string }) {
    const prior = await this.db.one<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1 AND client_id = $2', [customerId, input.clientId]);
    if (prior) return { booking: this.bookingView((await this.load(prior.id))!, false), created: false };
    const b = await this.businesses.get(customerId, businessRef);
    if (b.state !== 'active') throw Errors.notFound('Business');
    if (!b.bookingsEnabled) throw Errors.conflict('bookings_closed', 'This business isn’t taking bookings right now');
    await this.limits.consume({ name: 'booking:create', limit: 20, windowSeconds: 3600 }, customerId);
    const startsAt = new Date(input.startsAt);
    const id = await this.db.tx(async (tx) => {
      const svc = await this.db.one<{ duration_minutes: number; price_minor: string; deposit_minor: string; free_cancel_hours: number }>(
        'SELECT duration_minutes, price_minor, deposit_minor, free_cancel_hours FROM booking_services WHERE id = $1 AND business_id = $2 AND active AND archived_at IS NULL FOR UPDATE',
        [input.serviceId, b.id],
        tx,
      );
      if (!svc) throw Errors.notFound('Service');
      const localDate = await this.db.one<{ d: string }>(`SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS d`, [startsAt, b.timeZone], tx);
      const { rows } = await this.db.query<{ starts_at: Date; ends_at: Date; remaining: number }>(SLOTS_SQL, [input.serviceId, b.id, localDate!.d], tx);
      const slot = rows.find((r) => r.starts_at.getTime() === startsAt.getTime());
      if (!slot) throw Errors.conflict('slot_unavailable', 'That time isn’t available to book');
      if (slot.remaining <= 0) throw Errors.conflict('slot_full', 'That time has just been booked; pick another');
      const deposit = Number(svc.deposit_minor);
      const k = await this.db.one<{ id: string }>(
        `INSERT INTO bookings (business_id, service_id, customer_id, client_id, starts_at, ends_at, note, status, price_minor, deposit_minor, free_cancel_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5::timestamptz - make_interval(hours => $11))
           ON CONFLICT (customer_id, client_id) DO NOTHING RETURNING id`,
        [b.id, input.serviceId, customerId, input.clientId, slot.starts_at, slot.ends_at, input.note, deposit ? 'pending_payment' : 'confirmed', svc.price_minor, deposit, svc.free_cancel_hours],
        tx,
      );
      // The place is held while the customer pays the deposit on the provider's page.
      if (k && deposit) await this.payments.prepareForBooking(tx, { bookingId: k.id, businessId: b.id, payerId: customerId, amountMinor: deposit, currency: b.currency });
      return k?.id ?? null;
    });
    if (!id) {
      const again = await this.db.one<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1 AND client_id = $2', [customerId, input.clientId]);
      return { booking: this.bookingView((await this.load(again!.id))!, false), created: false };
    }
    const row = (await this.load(id))!;
    if (row.status === 'confirmed') await this.bus.publish(await this.businesses.staffIds(b.id), { type: 'business.booking.created', data: this.bookingView(row, true) });
    return { booking: this.bookingView(row, false), created: true };
  }

  async get(userId: string, bookingId: string) {
    const r = await this.load(bookingId);
    if (!r) throw Errors.notFound('Booking');
    if (r.customer_id === userId) return this.bookingView(r, false);
    await this.businesses.requireStaff(userId, r.business_id, 'bookings.view').catch(() => {
      throw Errors.notFound('Booking');
    });
    return this.bookingView(r, true);
  }

  async mine(customerId: string, upcoming: boolean) {
    const { rows } = await this.db.query<BookingRow>(
      `${BOOKING_SELECT} WHERE k.customer_id = $1 AND ${upcoming ? `k.ends_at > now() AND k.status IN ${HOLDS_PLACE} ORDER BY k.starts_at` : 'TRUE ORDER BY k.starts_at DESC'} LIMIT 100`,
      [customerId],
    );
    return { bookings: rows.map((r) => this.bookingView(r, false)) };
  }

  async forBusiness(userId: string, businessId: string, from: string, to: string) {
    await this.businesses.requireStaff(userId, businessId, 'bookings.view');
    const { rows } = await this.db.query<BookingRow>(
      // Staff see a booking once its deposit is paid; an abandoned checkout is none of their business.
      `${BOOKING_SELECT} WHERE k.business_id = $1 AND k.starts_at >= $2 AND k.starts_at < $3 AND k.status <> 'pending_payment' ORDER BY k.starts_at LIMIT 500`,
      [businessId, from, to],
    );
    return { bookings: rows.map((r) => this.bookingView(r, true)) };
  }

  /**
   * Customers cancel their own upcoming booking; staff can cancel any upcoming one. A paid
   * deposit goes back when the business cancels, or when the customer cancels by the
   * free-cancellation time; after that it is kept, as the business's cancellation fee.
   */
  async cancel(userId: string, bookingId: string) {
    return this.change(bookingId, async (k, tx) => {
      const asCustomer = k.customer_id === userId;
      if (!asCustomer) {
        await this.businesses.requireStaff(userId, k.business_id, 'bookings.manage', tx).catch(() => {
          throw Errors.notFound('Booking');
        });
      }
      // A booking waiting for its deposit is the customer's to drop; it lapses by itself otherwise.
      if (!asCustomer && k.status === 'pending_payment') throw Errors.conflict('booking_unpaid', 'This booking is waiting for the customer’s deposit');
      if (k.status !== 'confirmed' && k.status !== 'pending_payment') throw Errors.conflict('booking_closed', 'This booking is no longer open');
      if (k.starts_at <= new Date()) throw Errors.conflict('booking_started', 'This booking has already started');
      const refundDue = k.status === 'confirmed' && (!asCustomer || (!!k.free_cancel_until && new Date() < k.free_cancel_until));
      return { status: 'cancelled', cancelledBy: asCustomer ? 'customer' : 'business', actor: userId, asStaff: !asCustomer, refundDue };
    });
  }

  /** After the start time, staff record whether the person came. A deposit is kept either way. */
  async setOutcome(userId: string, bookingId: string, status: 'completed' | 'no_show') {
    return this.change(bookingId, async (k, tx) => {
      await this.businesses.requireStaff(userId, k.business_id, 'bookings.manage', tx).catch(() => {
        throw k.customer_id === userId ? Errors.forbidden('Only the business can do that') : Errors.notFound('Booking');
      });
      if (k.status !== 'confirmed') throw Errors.conflict('booking_closed', 'This booking is no longer open');
      if (k.starts_at > new Date()) throw Errors.conflict('booking_not_started', 'This booking hasn’t started yet');
      return { status, cancelledBy: null, actor: userId, asStaff: true, refundDue: false };
    });
  }

  private async change(
    bookingId: string,
    decide: (
      k: { business_id: string; customer_id: string | null; status: BookingStatus; starts_at: Date; free_cancel_until: Date | null },
      tx: Queryable,
    ) => Promise<{ status: string; cancelledBy: string | null; actor: string; asStaff: boolean; refundDue: boolean }>,
  ) {
    const out = await this.db.tx(async (tx) => {
      const k = await this.db.one<{ business_id: string; customer_id: string | null; status: BookingStatus; starts_at: Date; free_cancel_until: Date | null }>(
        'SELECT business_id, customer_id, status, starts_at, free_cancel_until FROM bookings WHERE id = $1 FOR UPDATE',
        [bookingId],
        tx,
      );
      if (!k) throw Errors.notFound('Booking');
      const d = await decide(k, tx);
      await this.db.query('UPDATE bookings SET status = $2, cancelled_by = $3, refund_due = $4, updated_at = now() WHERE id = $1', [bookingId, d.status, d.cancelledBy, d.refundDue], tx);
      await this.audit.record({ actorId: d.actor, action: 'business.booking.status', targetType: 'booking', targetId: bookingId, metadata: { from: k.status, to: d.status } }, tx);
      return { businessId: k.business_id, asStaff: d.asStaff, wasPending: k.status === 'pending_payment' };
    });
    // Close an unpaid checkout or give the deposit back. If the provider can't be reached
    // now, the payments sweep finishes the job.
    await this.payments.settleBooking(bookingId).catch(() => undefined);
    const r = (await this.load(bookingId))!;
    if (r.customer_id) await this.bus.publish([r.customer_id], { type: 'booking.updated', data: this.bookingView(r, false) });
    if (!out.wasPending) await this.bus.publish(await this.businesses.staffIds(out.businessId), { type: 'business.booking.updated', data: this.bookingView(r, true) });
    return this.bookingView(r, out.asStaff);
  }

  // ---------------------------------------------------------------- deposit hooks (PayableHooks)

  /** The deposit arrived: the booking is confirmed, or, if it was closed meanwhile, the deposit goes back. */
  async paid(bookingId: string, tx: Queryable) {
    const r = await this.db.query(`UPDATE bookings SET status = 'confirmed', updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [bookingId], tx);
    if (r.rowCount) return true;
    await this.db.query('UPDATE bookings SET refund_due = true, updated_at = now() WHERE id = $1', [bookingId], tx);
    return false;
  }

  /** The checkout ran out or failed: the place is given back. */
  async unpaid(bookingId: string, _reason: string, tx: Queryable) {
    const r = await this.db.query(`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [bookingId], tx);
    return (r.rowCount ?? 0) > 0;
  }

  async announce(bookingId: string, created: boolean) {
    const r = await this.load(bookingId);
    if (!r) return;
    if (r.customer_id) await this.bus.publish([r.customer_id], { type: 'booking.updated', data: this.bookingView(r, false) });
    if (r.status === 'pending_payment' || (r.deposit_minor !== '0' && r.pay_status !== 'succeeded')) return;
    await this.bus.publish(await this.businesses.staffIds(r.business_id), { type: created ? 'business.booking.created' : 'business.booking.updated', data: this.bookingView(r, true) });
  }
}
