import type { DatabaseService, Queryable } from '../database/database.service';

/** What a business plan can unlock. The list is fixed in the database too (plans.entitlements). */
export const ENTITLEMENTS = ['staff.extra', 'catalogue.extra'] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

/** Limits without a plan, and with the entitlement that raises them. */
export const LIMITS = {
  staff: { free: 10, entitled: 100, entitlement: 'staff.extra' },
  catalogue: { free: 500, entitled: 5000, entitlement: 'catalogue.extra' },
} as const satisfies Record<string, { free: number; entitled: number; entitlement: Entitlement }>;

/** Statuses that keep a plan's features on. past_due is the provider's retry window. */
export const ENTITLED_STATUSES = ['trialing', 'active', 'past_due'];

export async function entitlementsOf(db: DatabaseService, businessId: string, q?: Queryable): Promise<Set<Entitlement>> {
  const r = await db.one<{ e: Entitlement[] | null }>(
    `SELECT array_agg(DISTINCT x) AS e FROM subscriptions s JOIN plans p ON p.id = s.plan_id, unnest(p.entitlements) AS x
      WHERE s.business_id = $1 AND s.status = ANY($2)`,
    [businessId, ENTITLED_STATUSES],
    q,
  );
  return new Set(r?.e ?? []);
}

export async function limitFor(db: DatabaseService, businessId: string, what: keyof typeof LIMITS, q?: Queryable): Promise<number> {
  const l = LIMITS[what];
  return (await entitlementsOf(db, businessId, q)).has(l.entitlement) ? l.entitled : l.free;
}
