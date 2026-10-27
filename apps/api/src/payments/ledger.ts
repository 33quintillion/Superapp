import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../database/database.service';

export type LedgerAccount = 'external:customers' | 'platform:fees' | 'platform:subscriptions' | `business:${string}:sales`;

export interface LedgerPosting {
  kind: 'payment' | 'refund' | 'subscription_invoice';
  /** The provider object recorded (payment intent, refund or invoice id). One transaction each. */
  providerRef: string;
  currency: string;
  paymentId?: string;
  refundId?: string;
  subscriptionId?: string;
  entries: [LedgerAccount, number][];
}

export const businessSales = (businessId: string): LedgerAccount => `business:${businessId}:sales`;

/**
 * Double-entry bookkeeping for money the provider moved on our behalf. The database
 * refuses a transaction whose entries don't sum to zero and any change to past rows;
 * this class only adds a duplicate check, so recording the same provider object twice
 * (a redelivered webhook, a sweep racing a webhook) is a no-op.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly db: DatabaseService) {}

  /** Returns false when this provider object was already recorded. */
  async post(p: LedgerPosting, tx: Queryable): Promise<boolean> {
    const entries = p.entries.filter(([, amount]) => amount !== 0);
    const t = await this.db.one<{ id: string }>(
      `INSERT INTO ledger_transactions (kind, provider_ref, payment_id, refund_id, subscription_id, currency) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, provider_ref) DO NOTHING RETURNING id`,
      [p.kind, p.providerRef, p.paymentId ?? null, p.refundId ?? null, p.subscriptionId ?? null, p.currency],
      tx,
    );
    if (!t) return false;
    for (const [account, amount] of entries) {
      await this.db.query('INSERT INTO ledger_entries (transaction_id, account, amount_minor) VALUES ($1, $2, $3)', [t.id, account, amount], tx);
    }
    return true;
  }

  /** Balance of every account, per currency. Debits are positive. */
  async balances() {
    const { rows } = await this.db.query<{ account: string; currency: string; balance: string }>(
      `SELECT e.account, t.currency, sum(e.amount_minor) AS balance FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
        GROUP BY e.account, t.currency ORDER BY e.account, t.currency`,
    );
    return rows.map((r) => ({ account: r.account, currency: r.currency, balanceMinor: Number(r.balance) }));
  }

  /**
   * Reconciles the ledger with the payment records: every transaction balances, every
   * successful payment and refund is recorded exactly once with the right amounts, and
   * nothing is recorded for money that never moved.
   */
  async check() {
    const unbalanced = await this.db.query<{ id: string }>(
      `SELECT t.id FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id GROUP BY t.id HAVING coalesce(sum(e.amount_minor), 0) <> 0`,
    );
    const payments = await this.db.query<{ id: string; problem: string }>(
      `SELECT p.id, CASE WHEN p.status = 'succeeded' AND t.id IS NULL THEN 'payment_not_recorded'
                         WHEN p.status <> 'succeeded' AND t.id IS NOT NULL THEN 'recorded_but_not_paid'
                         ELSE 'amount_mismatch' END AS problem
         FROM payments p
         LEFT JOIN ledger_transactions t ON t.kind = 'payment' AND t.payment_id = p.id
         LEFT JOIN LATERAL (SELECT -sum(amount_minor) AS taken FROM ledger_entries WHERE transaction_id = t.id AND account = 'external:customers') c ON true
        WHERE (p.status = 'succeeded') <> (t.id IS NOT NULL) OR (t.id IS NOT NULL AND c.taken <> p.amount_minor)`,
    );
    const refunds = await this.db.query<{ id: string; problem: string }>(
      `SELECT r.id, CASE WHEN r.status = 'succeeded' AND t.id IS NULL THEN 'refund_not_recorded'
                         WHEN r.status <> 'succeeded' AND t.id IS NOT NULL THEN 'recorded_but_not_refunded'
                         ELSE 'amount_mismatch' END AS problem
         FROM refunds r
         LEFT JOIN ledger_transactions t ON t.kind = 'refund' AND t.refund_id = r.id
         LEFT JOIN LATERAL (SELECT sum(amount_minor) AS returned FROM ledger_entries WHERE transaction_id = t.id AND account = 'external:customers') c ON true
        WHERE (r.status = 'succeeded') <> (t.id IS NOT NULL) OR (t.id IS NOT NULL AND c.returned <> r.amount_minor)`,
    );
    const overRefunded = await this.db.query<{ id: string }>(
      `SELECT p.id FROM payments p WHERE p.refunded_minor <> (SELECT coalesce(sum(amount_minor), 0) FROM refunds WHERE payment_id = p.id AND status <> 'failed')`,
    );
    const count = await this.db.one<{ n: string }>('SELECT count(*) AS n FROM ledger_transactions');
    const problems = [
      ...unbalanced.rows.map((r) => ({ type: 'transaction', id: r.id, problem: 'unbalanced' })),
      ...payments.rows.map((r) => ({ type: 'payment', id: r.id, problem: r.problem })),
      ...refunds.rows.map((r) => ({ type: 'refund', id: r.id, problem: r.problem })),
      ...overRefunded.rows.map((r) => ({ type: 'payment', id: r.id, problem: 'refund_total_mismatch' })),
    ];
    return { ok: problems.length === 0, transactions: Number(count!.n), problems };
  }
}
