import { Injectable } from '@nestjs/common';
import { Errors } from '../common/errors';
import { DatabaseService } from '../database/database.service';
import { PaymentsService, rethrowProvider } from './payments.service';

/** Provider records are read this far either side of the period, so a few seconds' difference in timing still matches. */
const MARGIN_MS = 60 * 60_000;
const MAX_DAYS = 31;
const MAX_PROVIDER_RECORDS = 10_000;

type Kind = 'payment' | 'refund' | 'dispute' | 'dispute_reinstated';

interface Ours {
  kind: Kind | 'subscription_invoice';
  ref: string;
  currency: string;
  /** Money in (+) or out (−) of the platform's provider balance, as the provider shows it. */
  amount: number;
  at: Date;
}

interface Theirs {
  id: string;
  kind: Kind | 'other_charge' | 'refund_failure';
  ref: string;
  currency: string;
  amount: number;
  at: Date;
}

export interface Problem {
  problem: 'missing_at_provider' | 'unknown_at_provider' | 'amount_mismatch';
  kind: string;
  ref: string;
  currency: string;
  ourAmountMinor: number | null;
  providerAmountMinor: number | null;
}

/**
 * Checks our ledger against the provider's record of the platform balance (its balance
 * transactions) for a period. Every payment, refund and dispute movement we recorded should
 * be there with the same amount, and the provider should have nothing of those kinds that
 * we don't. The ledger check (LedgerService.check) covers our own records; this covers the
 * gap between them and the provider, such as a lost webhook nobody noticed.
 *
 * Charges for plans can't be matched one by one (the provider doesn't link a charge to its
 * invoice in this API version), so they are compared as a total per currency.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly payments: PaymentsService,
  ) {}

  async run(from: Date, to: Date) {
    if (!(from < to)) throw Errors.validation([{ path: 'to', message: 'Must be after from' }]);
    if (to.getTime() - from.getTime() > MAX_DAYS * 86400_000) throw Errors.validation([{ path: 'to', message: `At most ${MAX_DAYS} days at a time` }]);
    const ours = await this.ours(from, to);
    const theirs = await this.theirs(new Date(from.getTime() - MARGIN_MS), new Date(to.getTime() + MARGIN_MS));
    const byKey = new Map(theirs.filter((t) => t.kind !== 'other_charge').map((t) => [`${t.kind}:${t.ref}`, t]));
    const matched = new Set<string>();
    const problems: Problem[] = [];
    let matchedCount = 0;
    for (const o of ours) {
      if (o.kind === 'subscription_invoice') continue;
      const key = `${o.kind}:${o.ref}`;
      const t = byKey.get(key);
      if (!t) {
        problems.push({ problem: 'missing_at_provider', kind: o.kind, ref: o.ref, currency: o.currency, ourAmountMinor: o.amount, providerAmountMinor: null });
        continue;
      }
      matched.add(key);
      if (t.amount !== o.amount || t.currency !== o.currency) {
        problems.push({ problem: 'amount_mismatch', kind: o.kind, ref: o.ref, currency: o.currency, ourAmountMinor: o.amount, providerAmountMinor: t.amount });
      } else matchedCount += 1;
    }
    const inPeriod = (t: Theirs) => t.at >= from && t.at < to;
    for (const [key, t] of byKey) {
      if (!matched.has(key) && inPeriod(t)) problems.push({ problem: 'unknown_at_provider', kind: t.kind, ref: t.ref, currency: t.currency, ourAmountMinor: null, providerAmountMinor: t.amount });
    }
    // Plans: our invoice income against the provider's charges that aren't order or deposit payments.
    const totals = new Map<string, { ledgerMinor: number; providerMinor: number }>();
    const total = (c: string) => totals.get(c) ?? totals.set(c, { ledgerMinor: 0, providerMinor: 0 }).get(c)!;
    for (const o of ours) if (o.kind === 'subscription_invoice') total(o.currency).ledgerMinor += o.amount;
    for (const t of theirs) if (t.kind === 'other_charge' && inPeriod(t)) total(t.currency).providerMinor += t.amount;
    const subscriptions = [...totals].map(([currency, v]) => ({ currency, ...v, differenceMinor: v.providerMinor - v.ledgerMinor }));
    return {
      from,
      to,
      ok: problems.length === 0 && subscriptions.every((s) => s.differenceMinor === 0),
      matched: matchedCount,
      problems,
      subscriptions,
    };
  }

  /** What our ledger says moved through the platform's provider balance in the period. */
  private async ours(from: Date, to: Date): Promise<Ours[]> {
    const { rows } = await this.db.query<{ kind: Ours['kind']; provider_ref: string; currency: string; customers: string; created_at: Date }>(
      `SELECT t.kind, t.provider_ref, t.currency, t.created_at,
              (SELECT coalesce(sum(amount_minor), 0) FROM ledger_entries e WHERE e.transaction_id = t.id AND e.account = 'external:customers') AS customers
         FROM ledger_transactions t WHERE t.created_at >= $1 AND t.created_at < $2 ORDER BY t.created_at`,
      [from, to],
    );
    // The customers' account is the other side of the platform balance: money from customers is
    // a credit to it (negative) and a gain to the balance.
    return rows.map((r) => ({ kind: r.kind, ref: r.provider_ref, currency: r.currency, amount: -Number(r.customers), at: r.created_at }));
  }

  /** The provider's balance transactions in a window, sorted into what we track. */
  private async theirs(from: Date, to: Date): Promise<Theirs[]> {
    const stripe = this.payments.provider();
    const ourIntents = new Set(
      (await this.db.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM payments WHERE provider_payment_id IS NOT NULL AND succeeded_at >= $1', [from])).rows.map(
        (r) => r.provider_payment_id,
      ),
    );
    const out: Theirs[] = [];
    let after: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ 'created[gte]': String(Math.floor(from.getTime() / 1000)), 'created[lt]': String(Math.ceil(to.getTime() / 1000)), limit: '100' });
      q.append('expand[]', 'data.source');
      if (after) q.set('starting_after', after);
      const page = await stripe.get<{ data: Record<string, any>[]; has_more: boolean }>(`/v1/balance_transactions?${q}`).catch(rethrowProvider);
      for (const bt of page.data) {
        const t = classify(bt, ourIntents);
        if (t) out.push(t);
      }
      if (out.length > MAX_PROVIDER_RECORDS) throw Errors.conflict('range_too_large', 'Too many provider records in that period; choose a shorter one');
      if (!page.has_more || !page.data.length) break;
      after = page.data[page.data.length - 1]!.id;
    }
    // A refund the bank refused is booked and then booked back; we record neither.
    const failed = new Set(out.filter((t) => t.kind === 'refund_failure').map((t) => t.ref));
    return out.filter((t) => t.kind !== 'refund_failure' && !(t.kind === 'refund' && failed.has(t.ref)));
  }
}

/** One provider balance transaction as ours, or null for kinds we don't track (fees, transfers, payouts). */
function classify(bt: Record<string, any>, ourIntents: Set<string>): Theirs | null {
  const source = bt.source;
  const sourceId: string = typeof source === 'string' ? source : source?.id;
  const base = { id: bt.id as string, currency: String(bt.currency).toUpperCase(), amount: Number(bt.amount), at: new Date(Number(bt.created) * 1000) };
  const category = bt.reporting_category as string | undefined;
  if (bt.type === 'charge' || bt.type === 'payment') {
    const pi = typeof source === 'object' ? (typeof source.payment_intent === 'string' ? source.payment_intent : source.payment_intent?.id) : undefined;
    if (pi && ourIntents.has(pi)) return { ...base, kind: 'payment', ref: pi };
    return { ...base, kind: 'other_charge', ref: sourceId };
  }
  if (bt.type === 'refund' || bt.type === 'payment_refund') return { ...base, kind: 'refund', ref: sourceId };
  if (bt.type === 'refund_failure' || category === 'refund_failure') return { ...base, kind: 'refund_failure', ref: sourceId };
  if (category === 'dispute') return { ...base, kind: 'dispute', ref: sourceId };
  if (category === 'dispute_reversal') return { ...base, kind: 'dispute_reinstated', ref: sourceId };
  return null;
}
