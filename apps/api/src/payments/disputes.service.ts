import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { BusinessesService } from '../business/businesses.service';
import { RealtimeBus } from '../realtime/realtime-bus.service';
import { businessSales, LedgerService } from './ledger';
import { After, EventHandler, OPEN_DISPUTE_STATUSES, PaymentRow, PaymentsService, rethrowProvider } from './payments.service';
import { ProviderError, StripeEvent } from './stripe';

type DisputeStatus = 'warning_needs_response' | 'warning_under_review' | 'warning_closed' | 'needs_response' | 'under_review' | 'won' | 'lost';
const STATUSES: DisputeStatus[] = ['warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost'];
const EVENTS = ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'];
/** Statuses in which the business can still send its side of the story. */
const AWAITING_EVIDENCE: DisputeStatus[] = ['warning_needs_response', 'needs_response'];

interface DisputeRow {
  id: string;
  payment_id: string;
  provider_dispute_id: string;
  provider_charge_id: string;
  amount_minor: string;
  fee_share_minor: string;
  currency: string;
  reason: string;
  status: DisputeStatus;
  evidence_due_by: Date | null;
  evidence_submitted_at: Date | null;
  funds_withdrawn_at: Date | null;
  funds_reinstated_at: Date | null;
  recovery_reversal_id: string | null;
  return_transfer_id: string | null;
  provider_updated_at: Date;
  created_at: Date;
}

/** Marks a provider call that was not needed (nothing to move), so the sweep stops retrying it. */
const NOT_NEEDED = 'none';

/**
 * Disputes (chargebacks): a customer asks their bank to take a card payment back. The
 * provider takes the disputed amount from the platform straight away and gives it back if
 * the bank decides for the business.
 *
 * Orders and deposits are destination charges, so the provider takes the money from the
 * platform, not from the business. As with refunds, we take the business's share back from
 * it (a transfer reversal) and the platform bears its fee's share; if the business wins,
 * the share is sent to it again. Those calls happen after commit with idempotency keys,
 * and the payments sweep retries any that failed. The provider's own dispute fee is not
 * passed on and is not in our ledger (like its card fees).
 *
 * Disputes on plan invoices are not tracked here; they show in the provider's dashboard.
 */
@Injectable()
export class DisputesService implements OnModuleInit, EventHandler {
  private readonly logger = new Logger('Disputes');

  constructor(
    private readonly db: DatabaseService,
    private readonly businesses: BusinessesService,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    private readonly bus: RealtimeBus,
  ) {}

  onModuleInit() {
    this.payments.useHandler(this);
  }

  // ---------------------------------------------------------------- provider events

  handles(type: string) {
    return EVENTS.includes(type);
  }

  async apply(event: StripeEvent, tx: Queryable, after: After) {
    const dp = event.data.object;
    const pi = typeof dp.payment_intent === 'string' ? dp.payment_intent : dp.payment_intent?.id;
    const p = pi ? await this.db.one<PaymentRow>('SELECT * FROM payments WHERE provider_payment_id = $1 FOR UPDATE', [pi], tx) : null;
    if (!p) {
      this.logger.warn(`dispute ${dp.id} is not on an order or booking payment; see the provider's dashboard`);
      return;
    }
    const at = new Date(event.created * 1000);
    const status: DisputeStatus = STATUSES.includes(dp.status) ? dp.status : 'needs_response';
    const dueBy = dp.evidence_details?.due_by ? new Date(Number(dp.evidence_details.due_by) * 1000) : null;
    let d = await this.db.one<DisputeRow>('SELECT * FROM disputes WHERE provider_dispute_id = $1 FOR UPDATE', [dp.id], tx);
    if (!d) {
      const amount = Math.min(Number(dp.amount), Number(p.amount_minor));
      const feeShare = Math.floor((Number(p.fee_minor) * amount) / Number(p.amount_minor));
      d = await this.db.one<DisputeRow>(
        `INSERT INTO disputes (payment_id, provider_dispute_id, provider_charge_id, amount_minor, fee_share_minor, currency, reason, status, evidence_due_by, provider_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [p.id, dp.id, typeof dp.charge === 'string' ? dp.charge : dp.charge?.id, amount, feeShare, p.currency, String(dp.reason ?? ''), status, dueBy, at],
        tx,
      );
      await this.audit.record({ actorId: null, action: 'payments.dispute.opened', targetType: 'payment', targetId: p.id, metadata: { amountMinor: amount, reason: dp.reason } }, tx);
    } else if (at >= d.provider_updated_at && !isFinal(d.status)) {
      // Events arrive in any order; an older one never undoes a newer status, and a decision is final.
      d = await this.db.one<DisputeRow>(
        `UPDATE disputes SET status = $2, evidence_due_by = coalesce($3, evidence_due_by), provider_updated_at = $4, updated_at = now() WHERE id = $1 RETURNING *`,
        [d.id, status, dueBy, at],
        tx,
      );
    }
    if (event.type === 'charge.dispute.funds_withdrawn') await this.fundsWithdrawn(d!, p, tx, after);
    else if (event.type === 'charge.dispute.funds_reinstated') await this.fundsReinstated(d!, p, tx, after);
    const disputeId = d!.id;
    after.push(() => this.tellStaff(disputeId));
  }

  /** The bank took the money: the customer has it back, and the business's share comes back from it. */
  private async fundsWithdrawn(d: DisputeRow, p: PaymentRow, tx: Queryable, after: After) {
    if (d.funds_withdrawn_at) return;
    const amount = Number(d.amount_minor);
    const fee = Number(d.fee_share_minor);
    await this.db.query('UPDATE disputes SET funds_withdrawn_at = now(), updated_at = now() WHERE id = $1', [d.id], tx);
    await this.db.query('UPDATE payments SET disputed_minor = disputed_minor + $2, updated_at = now() WHERE id = $1', [p.id, amount], tx);
    await this.ledger.post(
      {
        kind: 'dispute',
        providerRef: d.provider_dispute_id,
        currency: d.currency,
        paymentId: p.id,
        disputeId: d.id,
        entries: [
          ['external:customers', amount],
          [businessSales(p.business_id), -(amount - fee)],
          ['platform:fees', -fee],
        ],
      },
      tx,
    );
    after.push(() => this.recover(d.id));
  }

  /** The bank decided for the business: the money is back, and the business's share goes to it again. */
  private async fundsReinstated(d: DisputeRow, p: PaymentRow, tx: Queryable, after: After) {
    if (d.funds_reinstated_at) return;
    if (!d.funds_withdrawn_at) {
      // Reinstated before we heard of the withdrawal: record both, in order.
      await this.fundsWithdrawn(d, p, tx, after);
      d = (await this.db.one<DisputeRow>('SELECT * FROM disputes WHERE id = $1', [d.id], tx))!;
    }
    const amount = Number(d.amount_minor);
    const fee = Number(d.fee_share_minor);
    await this.db.query('UPDATE disputes SET funds_reinstated_at = now(), updated_at = now() WHERE id = $1', [d.id], tx);
    await this.db.query('UPDATE payments SET disputed_minor = disputed_minor - $2, updated_at = now() WHERE id = $1', [p.id, amount], tx);
    await this.ledger.post(
      {
        kind: 'dispute_reinstated',
        providerRef: d.provider_dispute_id,
        currency: d.currency,
        paymentId: p.id,
        disputeId: d.id,
        entries: [
          ['external:customers', -amount],
          [businessSales(p.business_id), amount - fee],
          ['platform:fees', fee],
        ],
      },
      tx,
    );
    after.push(() => this.giveBack(d.id));
  }

  // ---------------------------------------------------------------- moving the business's share

  /** Takes the business's share of the disputed amount back from its account. Safe to repeat. */
  async recover(disputeId: string) {
    const stripe = this.payments.provider();
    const d = await this.db.one<DisputeRow>('SELECT * FROM disputes WHERE id = $1', [disputeId]);
    if (!d || !d.funds_withdrawn_at || d.recovery_reversal_id) return;
    const share = Number(d.amount_minor) - Number(d.fee_share_minor);
    if (share <= 0) {
      await this.db.query('UPDATE disputes SET recovery_reversal_id = $2 WHERE id = $1 AND recovery_reversal_id IS NULL', [d.id, NOT_NEEDED]);
      return;
    }
    const charge = await stripe.get(`/v1/charges/${encodeURIComponent(d.provider_charge_id)}`);
    const transfer = typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id;
    if (!transfer) {
      this.logger.error(`dispute ${d.id}: charge ${d.provider_charge_id} has no transfer to reverse; needs a look`);
      return;
    }
    const rev = await stripe.post(`/v1/transfers/${encodeURIComponent(transfer)}/reversals`, { amount: share, metadata: { dispute_id: d.id } }, `dispute-recover:${d.id}`);
    await this.db.query('UPDATE disputes SET recovery_reversal_id = $2, updated_at = now() WHERE id = $1 AND recovery_reversal_id IS NULL', [d.id, rev.id]);
  }

  /** Sends the business's share back to it after a won dispute, once it was taken. Safe to repeat. */
  async giveBack(disputeId: string) {
    const stripe = this.payments.provider();
    const d = await this.db.one<DisputeRow & { destination_account: string }>(
      'SELECT d.*, p.destination_account FROM disputes d JOIN payments p ON p.id = d.payment_id WHERE d.id = $1',
      [disputeId],
    );
    if (!d || !d.funds_reinstated_at || d.return_transfer_id) return;
    if (!d.recovery_reversal_id) await this.recover(d.id);
    const recovered = (await this.db.one<{ r: string | null }>('SELECT recovery_reversal_id AS r FROM disputes WHERE id = $1', [d.id]))!.r;
    if (!recovered) return; // the sweep tries again
    if (recovered === NOT_NEEDED) {
      await this.db.query('UPDATE disputes SET return_transfer_id = $2 WHERE id = $1 AND return_transfer_id IS NULL', [d.id, NOT_NEEDED]);
      return;
    }
    const tr = await stripe.post(
      '/v1/transfers',
      {
        amount: Number(d.amount_minor) - Number(d.fee_share_minor),
        currency: d.currency.toLowerCase(),
        destination: d.destination_account,
        source_transaction: d.provider_charge_id,
        metadata: { dispute_id: d.id },
      },
      `dispute-return:${d.id}`,
    );
    await this.db.query('UPDATE disputes SET return_transfer_id = $2, updated_at = now() WHERE id = $1 AND return_transfer_id IS NULL', [d.id, tr.id]);
  }

  /** Retries provider calls that failed or never ran. */
  async sweep() {
    if (!this.payments.enabled) return;
    const { rows } = await this.db.query<{ id: string; give_back: boolean }>(
      `SELECT id, funds_reinstated_at IS NOT NULL AS give_back FROM disputes
        WHERE (funds_withdrawn_at IS NOT NULL AND recovery_reversal_id IS NULL)
           OR (funds_reinstated_at IS NOT NULL AND return_transfer_id IS NULL)
        ORDER BY created_at LIMIT 100`,
    );
    for (const r of rows) {
      await (r.give_back ? this.giveBack(r.id) : this.recover(r.id)).catch((e) => this.logger.warn(`dispute ${r.id}: ${(e as Error).message}`));
    }
  }

  // ---------------------------------------------------------------- staff

  private view(d: DisputeRow & { order_id: string | null; booking_id: string | null }) {
    return {
      id: d.id,
      paymentId: d.payment_id,
      orderId: d.order_id,
      bookingId: d.booking_id,
      amountMinor: Number(d.amount_minor),
      currency: d.currency,
      reason: d.reason,
      status: d.status,
      open: OPEN_DISPUTE_STATUSES.includes(d.status),
      canRespond: AWAITING_EVIDENCE.includes(d.status) && !d.evidence_submitted_at,
      evidenceDueBy: d.evidence_due_by,
      evidenceSubmittedAt: d.evidence_submitted_at,
      createdAt: d.created_at,
    };
  }

  private async load(where: string, params: unknown[]) {
    const { rows } = await this.db.query<DisputeRow & { order_id: string | null; booking_id: string | null; business_id: string }>(
      `SELECT d.*, p.order_id, p.booking_id, p.business_id FROM disputes d JOIN payments p ON p.id = d.payment_id WHERE ${where} ORDER BY d.created_at DESC LIMIT 100`,
      params,
    );
    return rows;
  }

  async forBusiness(userId: string, businessId: string) {
    await this.businesses.requireStaff(userId, businessId, 'payments.view');
    return { disputes: (await this.load('p.business_id = $1', [businessId])).map((d) => this.view(d)) };
  }

  async all() {
    return { disputes: (await this.load('true', [])).map((d) => ({ ...this.view(d), businessId: d.business_id })) };
  }

  /**
   * The business's side of the story, sent to the provider for the bank. Sending it is
   * final: the provider submits it and the bank decides.
   */
  async respond(userId: string, disputeId: string, text: string) {
    const stripe = this.payments.provider();
    const [d] = await this.load('d.id = $1', [disputeId]);
    if (!d) throw Errors.notFound('Dispute');
    await this.businesses.requireStaff(userId, d.business_id, 'disputes.respond');
    if (!AWAITING_EVIDENCE.includes(d.status) || d.evidence_submitted_at) throw Errors.conflict('dispute_closed', 'This dispute isn’t waiting for a response');
    await this.limits.consume({ name: 'payments:dispute-evidence', limit: 20, windowSeconds: 3600 }, userId);
    const key = `dispute-evidence:${d.id}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
    const res = await stripe
      .post(`/v1/disputes/${encodeURIComponent(d.provider_dispute_id)}`, { evidence: { uncategorized_text: text }, submit: true, metadata: { dispute_id: d.id } }, key)
      .catch((err) => {
        if (err instanceof ProviderError) rethrowProvider(err);
        throw err;
      });
    const status: DisputeStatus = STATUSES.includes(res.status) ? res.status : d.status;
    await this.db.query(
      `UPDATE disputes SET evidence_submitted_at = now(), evidence_submitted_by = $2, status = CASE WHEN status = ANY($4) THEN $3 ELSE status END, updated_at = now() WHERE id = $1`,
      [d.id, userId, status, AWAITING_EVIDENCE],
    );
    await this.audit.record({ actorId: userId, action: 'payments.dispute.responded', targetType: 'payment', targetId: d.payment_id });
    await this.tellStaff(d.id);
    const [fresh] = await this.load('d.id = $1', [d.id]);
    return this.view(fresh!);
  }

  private async tellStaff(disputeId: string) {
    const [d] = await this.load('d.id = $1', [disputeId]);
    if (!d) return;
    const managers = await this.businesses.staffWith(d.business_id, 'payments.view');
    await this.bus.publish(managers, { type: 'business.dispute.updated', data: { ...this.view(d), businessId: d.business_id } });
    await this.payments.announcePayment(d.payment_id);
  }
}

function isFinal(s: DisputeStatus) {
  return s === 'won' || s === 'lost' || s === 'warning_closed';
}
