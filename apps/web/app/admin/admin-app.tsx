'use client';

import { useCallback, useEffect, useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import { Dispute, DISPUTE_STATUS_LABEL, ENTITLEMENT_LABEL, Integration, money, Payment, PAYMENT_LABEL, Plan, toMinor } from '@/lib/business-client';
import type { UserSummary } from '@/lib/social-client';

export interface Overview {
  role: 'moderator' | 'admin';
  reports: { open: number; inReview: number; childSafety: number };
  users: { active: number; suspended: number };
  businesses: number;
  liveIntegrations: number;
}

interface Report {
  id: string;
  reporter: UserSummary | null;
  subjectType: string;
  subjectId: string;
  reason: string;
  details: string;
  status: string;
  assignedTo: string | null;
  resolutionNote: string;
  actions: string[];
  otherOpenReports: number;
  createdAt: string;
  subject?: Record<string, unknown> | null;
  related?: Report[];
}

type Tab = 'reports' | 'users' | 'businesses' | 'payments' | 'integrations' | 'staff' | 'audit';

/** The admin dashboard. Every call is checked again by the API (staff role, two-step, session age). */
export function AdminApp({ overview }: { overview: Overview }) {
  const admin = overview.role === 'admin';
  const tabs: [Tab, string][] = [
    ['reports', 'Reports'],
    ['users', 'Accounts'],
    ...(admin
      ? ([
          ['businesses', 'Businesses'],
          ['payments', 'Payments and plans'],
          ['integrations', 'Integrations'],
          ['staff', 'Staff'],
          ['audit', 'Audit log'],
        ] as [Tab, string][])
      : []),
  ];
  const [tab, setTab] = useState<Tab>('reports');
  return (
    <main className="wide social">
      <h1>Admin</h1>
      <p className="muted small" data-testid="admin-overview">
        You: {overview.role} · {overview.reports.open} open reports ({overview.reports.childSafety} child safety) · {overview.reports.inReview} in review ·{' '}
        {overview.users.suspended} suspended accounts · {overview.businesses} businesses · {overview.liveIntegrations} live integrations
      </p>
      <nav className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'btn small' : 'btn quiet small'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'reports' && <Reports />}
      {tab === 'users' && <Users />}
      {tab === 'businesses' && <Businesses />}
      {tab === 'payments' && <Payments />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'staff' && <Staff />}
      {tab === 'audit' && <Audit />}
    </main>
  );
}

function useAct() {
  const [err, setErr] = useState<string | null>(null);
  return {
    err,
    act: async (fn: () => Promise<void>) => {
      setErr(null);
      try {
        await fn();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Something went wrong');
      }
    },
  };
}

function Reports() {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [list, setList] = useState<Report[]>([]);
  const [open, setOpen] = useState<Report | null>(null);
  const { err, act } = useAct();
  const load = useCallback(async () => setList((await chatApi<{ reports: Report[] }>('GET', `admin/reports?status=${status}`)).reports), [status]);
  useEffect(() => void load(), [load]);
  const resolve = (body: Record<string, unknown>) =>
    act(async () => {
      const note = (document.querySelector('[name=resolutionNote]') as HTMLInputElement | null)?.value ?? '';
      setOpen(await chatApi<Report>('POST', `admin/reports/${open!.id}/resolve`, { ...body, note }));
      await load();
    });
  return (
    <section className="stack">
      <div className="composer-row">
        <button className={status === 'open' ? 'btn small' : 'btn quiet small'} onClick={() => setStatus('open')}>
          Queue
        </button>
        <button className={status === 'closed' ? 'btn small' : 'btn quiet small'} onClick={() => setStatus('closed')}>
          Closed
        </button>
      </div>
      <div className="card" data-testid="report-queue">
        {list.length === 0 && <p className="muted">Nothing here.</p>}
        {list.map((r) => (
          <button key={r.id} className="row link-btn" style={{ width: '100%', textAlign: 'left' }} data-testid="report-row" data-subject={r.subjectType} onClick={() => act(async () => setOpen(await chatApi<Report>('GET', `admin/reports/${r.id}`)))}>
            <span>
              <span className={r.reason === 'child_safety' ? 'pill error' : 'pill'}>{r.reason.replace('_', ' ')}</span> {r.subjectType} · {r.details.slice(0, 80)}
            </span>
            <span className="muted small">
              {r.status.replace('_', ' ')}
              {r.otherOpenReports > 0 && ` · +${r.otherOpenReports} more`}
            </span>
          </button>
        ))}
      </div>
      {open && (
        <div className="card stack" data-testid="report-detail" data-status={open.status}>
          <h3>
            Report on a {open.subjectType} <span className="pill">{open.status.replace('_', ' ')}</span>
          </h3>
          <p className="small">
            {open.reason.replace('_', ' ')} · from {open.reporter ? `@${open.reporter.username}` : 'a deleted account'} · {new Date(open.createdAt).toLocaleString('en')}
          </p>
          {open.details && <p>“{open.details}”</p>}
          <SubjectPreview type={open.subjectType} s={open.subject ?? null} />
          {(open.related?.length ?? 0) > 0 && <p className="small muted">{open.related!.length} other reports about this.</p>}
          {['open', 'in_review'].includes(open.status) ? (
            <>
              {open.status === 'open' && (
                <button className="btn quiet small" onClick={() => act(async () => setOpen(await chatApi<Report>('POST', `admin/reports/${open.id}/claim`)))}>
                  Take this one
                </button>
              )}
              <input name="resolutionNote" placeholder="Note (shown to the author when content is removed)" maxLength={1000} aria-label="Resolution note" />
              <div className="composer-row">
                {open.subjectType !== 'user' && (
                  <button className="btn small danger" data-testid="remove-content" onClick={() => resolve({ decision: 'action', removeContent: true })}>
                    {open.subjectType === 'business' || open.subjectType === 'mini_app' ? 'Suspend it' : 'Remove it'}
                  </button>
                )}
                {['user', 'message', 'post', 'comment', 'story'].includes(open.subjectType) && (
                  <button className="btn small danger" data-testid="suspend-author" onClick={() => resolve({ decision: 'action', suspendAuthor: true, removeContent: open.subjectType !== 'user' })}>
                    {open.subjectType === 'user' ? 'Suspend account' : 'Remove and suspend author'}
                  </button>
                )}
                <button className="btn quiet small" data-testid="dismiss" onClick={() => resolve({ decision: 'dismiss' })}>
                  No action
                </button>
              </div>
            </>
          ) : (
            <p className="small" data-testid="resolution">
              {open.status === 'dismissed' ? 'Dismissed' : `Actioned: ${open.actions.join(', ').replace(/_/g, ' ')}`}
              {open.resolutionNote && ` · ${open.resolutionNote}`}
            </p>
          )}
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function SubjectPreview({ type, s }: { type: string; s: Record<string, unknown> | null }) {
  if (!s) return <p className="muted">The reported {type} no longer exists.</p>;
  const author = s.author as UserSummary | undefined;
  const user = s.user as UserSummary | undefined;
  return (
    <div className="card" data-testid="subject">
      {author && <p className="small muted">By @{author.username}</p>}
      {user && (
        <p>
          @{user.username} · {user.displayName} <span className="pill">{String(s.state)}</span>
        </p>
      )}
      {'body' in s && <p data-testid="subject-body">{String(s.body ?? '') || <span className="muted">(no text)</span>}</p>}
      {'name' in s && (
        <p>
          {String(s.name)} {'state' in s && <span className="pill">{String(s.state)}</span>}
        </p>
      )}
      {(s.removed as boolean) && <span className="pill">Removed</span>}
    </div>
  );
}

interface AccountRow {
  user: UserSummary;
  email?: string | null;
  state: string;
  suspensionReason: string | null;
  reportsAgainst: number;
  platformRole: string | null;
}

function Users() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AccountRow[]>([]);
  const { err, act } = useAct();
  const search = () => act(async () => setRows((await chatApi<{ users: AccountRow[] }>('GET', `admin/users?q=${encodeURIComponent(q)}`)).users));
  return (
    <section className="stack">
      <form
        className="composer-row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input name="accountSearch" placeholder="Username, email or id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an account" />
        <button className="btn small" type="submit">
          Find
        </button>
      </form>
      <div className="card">
        {rows.map((r) => (
          <div className="row" key={r.user.id} data-testid="account-row" data-state={r.state}>
            <span>
              @{r.user.username} · {r.user.displayName} {r.email && <span className="muted small">{r.email}</span>} <span className="pill">{r.state}</span>
              {r.platformRole && <span className="pill">{r.platformRole}</span>}
              <br />
              <span className="small muted">
                {r.reportsAgainst} reports{r.suspensionReason && ` · suspended: ${r.suspensionReason}`}
              </span>
            </span>
            {!r.platformRole &&
              (r.state === 'suspended' ? (
                <button className="btn quiet small" onClick={() => act(async () => { await chatApi('POST', `admin/users/${r.user.id}/unsuspend`, {}); await search(); })}>
                  Lift suspension
                </button>
              ) : (
                <button
                  className="btn quiet small danger"
                  onClick={() => {
                    const reason = prompt('Why suspend this account?');
                    if (reason) void act(async () => { await chatApi('POST', `admin/users/${r.user.id}/suspend`, { reason }); await search(); });
                  }}
                >
                  Suspend
                </button>
              ))}
          </div>
        ))}
      </div>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

interface AdminBusiness {
  id: string;
  handle: string;
  name: string;
  state: string;
  verified: boolean;
  owner: UserSummary | null;
  reports: number;
  suspensionReason: string | null;
}

function Businesses() {
  const [rows, setRows] = useState<AdminBusiness[]>([]);
  const { err, act } = useAct();
  const load = useCallback(async () => setRows((await chatApi<{ businesses: AdminBusiness[] }>('GET', 'admin/businesses')).businesses), []);
  useEffect(() => void load(), [load]);
  const action = (b: AdminBusiness, a: string, reason = '') => act(async () => { await chatApi('POST', `admin/businesses/${b.id}/actions`, { action: a, reason }); await load(); });
  return (
    <section className="card">
      {rows.map((b) => (
        <div className="row" key={b.id} data-testid="admin-business" data-handle={b.handle} data-state={b.state}>
          <span>
            <strong>{b.name}</strong> @{b.handle} {b.verified && <span className="pill">Verified</span>} <span className="pill">{b.state}</span>
            <br />
            <span className="small muted">
              Owner {b.owner ? `@${b.owner.username}` : 'none'} · {b.reports} reports{b.suspensionReason && ` · ${b.suspensionReason}`}
            </span>
          </span>
          <span className="actions">
            <button className="btn quiet small" onClick={() => action(b, b.verified ? 'unverify' : 'verify')}>
              {b.verified ? 'Unverify' : 'Verify'}
            </button>
            {b.state === 'suspended' ? (
              <button className="btn quiet small" onClick={() => action(b, 'unsuspend')}>
                Restore
              </button>
            ) : (
              <button
                className="btn quiet small danger"
                onClick={() => {
                  const reason = prompt('Why suspend this business?');
                  if (reason) void action(b, 'suspend', reason);
                }}
              >
                Suspend
              </button>
            )}
          </span>
        </div>
      ))}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function Integrations() {
  const [rows, setRows] = useState<Integration[]>([]);
  const { err, act } = useAct();
  const load = useCallback(async () => setRows((await chatApi<{ integrations: Integration[] }>('GET', 'admin/integrations')).integrations), []);
  useEffect(() => void load(), [load]);
  const state = (i: Integration, s: string, reason = '') => act(async () => { await chatApi('POST', `admin/integrations/${i.id}/state`, { state: s, reason }); await load(); });
  return (
    <section className="stack">
      <div className="card">
        {rows.length === 0 && <p className="muted">No integrations yet.</p>}
        {rows.map((i) => (
          <div className="row" key={i.id} data-testid="admin-integration" data-slug={i.slug} data-state={i.state}>
            <span>
              <strong>{i.name}</strong> v{i.version} <span className="pill">{i.state}</span>
              <br />
              <span className="small muted">
                {i.developer.name} ({i.developer.contact}) · {i.scopes.map((s) => s.scope).join(', ') || 'no scopes'} · {i.connections ?? 0} connected
                {i.disabledReason && ` · off: ${i.disabledReason}`}
              </span>
            </span>
            <span className="actions">
              {i.state !== 'live' && (
                <button className="btn small" onClick={() => state(i, 'live')}>
                  {i.state === 'draft' ? 'Approve and publish' : 'Switch back on'}
                </button>
              )}
              {i.state === 'live' && (
                <button
                  className="btn small danger"
                  data-testid="kill-switch"
                  onClick={() => {
                    const reason = prompt('Why switch it off for everyone?');
                    if (reason) void state(i, 'disabled', reason);
                  }}
                >
                  Switch off
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      <form
        className="card stack"
        data-testid="new-integration"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          void act(async () => {
            await chatApi('POST', 'admin/integrations', {
              slug: f.get('slug'),
              name: f.get('name'),
              description: f.get('description'),
              category: f.get('category'),
              developerName: f.get('developerName'),
              developerContact: f.get('developerContact'),
              homepageUrl: f.get('homepageUrl'),
              scopes: f.getAll('scopes'),
            });
            form.reset();
            await load();
          });
        }}
      >
        <h3>Add a partner integration</h3>
        <input name="name" placeholder="Name" required aria-label="Integration name" />
        <input name="slug" placeholder="Address, e.g. city-tickets" required pattern="[a-z0-9][a-z0-9_\-]{2,39}" aria-label="Integration address" />
        <input name="description" placeholder="What it does" aria-label="Integration description" />
        <select name="category" defaultValue="food" aria-label="Category">
          {['food', 'bookings', 'tickets', 'travel', 'shopping', 'utilities', 'other'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input name="developerName" placeholder="Developer" required aria-label="Developer" />
        <input name="developerContact" placeholder="Developer contact (private)" required aria-label="Developer contact" />
        <input name="homepageUrl" placeholder="https://…" required type="url" aria-label="Homepage" />
        <fieldset className="stack small">
          <legend>It may ask people for</legend>
          {['profile.basic', 'email', 'orders.read', 'bookings.read', 'notifications.send'].map((s) => (
            <label key={s}>
              <input type="checkbox" name="scopes" value={s} /> {s}
            </label>
          ))}
        </fieldset>
        <button className="btn" type="submit">
          Save as draft
        </button>
      </form>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function Staff() {
  const [rows, setRows] = useState<{ user: UserSummary; role: string; twoStepOn: boolean }[]>([]);
  const { err, act } = useAct();
  const load = useCallback(async () => setRows((await chatApi<{ staff: typeof rows }>('GET', 'admin/staff')).staff), []);
  useEffect(() => void load(), [load]);
  return (
    <section className="card stack">
      {rows.map((r) => (
        <div className="row" key={r.user.id} data-testid="platform-staff">
          <span>
            @{r.user.username} <span className="pill">{r.role}</span> {!r.twoStepOn && <span className="pill error">Two-step off</span>}
          </span>
          {r.role === 'moderator' && (
            <button className="btn quiet small danger" onClick={() => act(async () => { await chatApi('DELETE', `admin/staff/${r.user.id}`); await load(); })}>
              Remove
            </button>
          )}
        </div>
      ))}
      <form
        className="composer-row"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const username = new FormData(form).get('username');
          void act(async () => {
            setRows((await chatApi<{ staff: typeof rows }>('POST', 'admin/staff', { username })).staff);
            form.reset();
          });
        }}
      >
        <input name="username" placeholder="Username" required aria-label="Add a moderator" />
        <button className="btn small" type="submit">
          Add moderator
        </button>
      </form>
      <p className="small muted">Admins are added from the command line (see docs/admin.md).</p>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function Audit() {
  const [rows, setRows] = useState<{ id: number; actor: UserSummary | null; action: string; targetType: string | null; targetId: string | null; createdAt: string }[]>([]);
  const [prefix, setPrefix] = useState('admin.');
  const load = useCallback(async () => setRows((await chatApi<{ entries: typeof rows }>('GET', `admin/audit?action=${encodeURIComponent(prefix)}`)).entries), [prefix]);
  useEffect(() => void load(), [load]);
  return (
    <section className="card stack">
      <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Action starts with…" aria-label="Filter actions" />
      {rows.map((r) => (
        <div className="row small" key={r.id} data-testid="audit-entry" data-action={r.action}>
          <span>
            <code>{r.action}</code> {r.targetType && `${r.targetType} ${r.targetId?.slice(0, 8)}`}
          </span>
          <span className="muted">
            {r.actor ? `@${r.actor.username}` : 'system'} · {new Date(r.createdAt).toLocaleString('en')}
          </span>
        </div>
      ))}
    </section>
  );
}

interface Ledger {
  balances: { account: string; currency: string; balanceMinor: number }[];
  check: { ok: boolean; transactions: number; problems: { type: string; id: string; problem: string }[] };
}

interface Reconciliation {
  ok: boolean;
  matched: number;
  problems: { problem: string; kind: string; ref: string; currency: string; ourAmountMinor: number | null; providerAmountMinor: number | null }[];
  subscriptions: { currency: string; ledgerMinor: number; providerMinor: number; differenceMinor: number }[];
}

const ACCOUNT_LABEL: Record<string, string> = {
  'external:customers': 'Customers (paid in, net of refunds)',
  'platform:fees': 'Nexa fees on orders',
  'platform:subscriptions': 'Nexa plan income',
};

/** The ledger's reconciliation, recent card payments, and the plans businesses can buy. */
function Payments() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [list, setList] = useState<Payment[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const { err, act } = useAct();
  const load = useCallback(async () => {
    const [l, p, pl, d] = await Promise.all([
      chatApi<Ledger>('GET', 'admin/ledger'),
      chatApi<{ payments: Payment[] }>('GET', 'admin/payments?limit=30'),
      chatApi<{ plans: Plan[] }>('GET', 'admin/plans'),
      chatApi<{ disputes: Dispute[] }>('GET', 'admin/disputes'),
    ]);
    setLedger(l);
    setList(p.payments);
    setPlans(pl.plans);
    setDisputes(d.disputes);
  }, []);
  useEffect(() => void load().catch(() => undefined), [load]);
  // Business sales accounts are summed per currency: one line per business would be too long here.
  const sales = new Map<string, number>();
  for (const b of ledger?.balances ?? []) if (b.account.startsWith('business:')) sales.set(b.currency, (sales.get(b.currency) ?? 0) + b.balanceMinor);
  return (
    <>
      <section className="card stack" data-testid="ledger">
        <h2>Ledger</h2>
        {ledger && (
          <>
            <p data-testid="ledger-check" data-ok={String(ledger.check.ok)}>
              {ledger.check.ok
                ? `Balanced: ${ledger.check.transactions} transactions agree with every payment, refund and dispute.`
                : `${ledger.check.problems.length} problems found. Look into these before paying anything out.`}
            </p>
            {ledger.check.problems.map((p) => (
              <p key={`${p.type}:${p.id}`} className="error small">
                {p.type} {p.id}: {p.problem.replace(/_/g, ' ')}
              </p>
            ))}
            {ledger.balances
              .filter((b) => !b.account.startsWith('business:'))
              .map((b) => (
                <p key={`${b.account}:${b.currency}`} className="small">
                  {ACCOUNT_LABEL[b.account] ?? b.account}: {money(Math.abs(b.balanceMinor), b.currency)}
                </p>
              ))}
            {[...sales].map(([currency, total]) => (
              <p key={currency} className="small">
                Businesses’ sales, net of fees and refunds: {money(total, currency)}
              </p>
            ))}
          </>
        )}
      </section>

      <ProviderCheck />

      <section className="card stack" data-testid="admin-disputes">
        <h2>Disputes</h2>
        {disputes.length === 0 && <p className="muted">None.</p>}
        {disputes.map((d) => (
          <div className="row small" key={d.id}>
            <span>
              {money(d.amountMinor, d.currency)} · {d.orderId ? 'order' : 'deposit'} · {d.reason.replace(/_/g, ' ')} · {new Date(d.createdAt).toLocaleDateString()}
            </span>
            <span className="pill">{DISPUTE_STATUS_LABEL[d.status]}</span>
          </div>
        ))}
      </section>

      <section className="card stack" data-testid="admin-plans">
        <h2>Plans</h2>
        {plans.map((p) => (
          <div className="row" key={p.id} data-testid="admin-plan" data-code={p.code} data-state={p.state}>
            <span>
              <strong>{p.name}</strong> ({p.code}) · {money(p.priceMinor, p.currency)} a {p.interval} · <span className="pill">{p.state}</span>
              <br />
              <span className="small muted">{p.entitlements.map((e) => ENTITLEMENT_LABEL[e] ?? e).join(' · ')}</span>
            </span>
            <span className="actions">
              {p.state !== 'active' && (
                <button className="btn small" onClick={() => act(async () => { await chatApi('POST', `admin/plans/${p.id}/state`, { state: 'active' }); await load(); })}>
                  Put on sale
                </button>
              )}
              {p.state === 'active' && (
                <button className="btn quiet small" onClick={() => act(async () => { await chatApi('POST', `admin/plans/${p.id}/state`, { state: 'retired' }); await load(); })}>
                  Stop selling
                </button>
              )}
            </span>
          </div>
        ))}
        <form
          className="stack"
          data-testid="new-plan"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            const currency = String(f.get('currency')).toUpperCase();
            void act(async () => {
              await chatApi('POST', 'admin/plans', {
                code: String(f.get('code')),
                name: String(f.get('name')),
                description: String(f.get('description') ?? ''),
                priceMinor: toMinor(String(f.get('price')), currency),
                currency,
                interval: String(f.get('interval')),
                entitlements: f.getAll('entitlements').map(String),
              });
              form.reset();
              await load();
            });
          }}
        >
          <h3>New plan</h3>
          <p className="small muted">The price is created at the payment provider and can’t be changed later; make a new plan instead.</p>
          <div className="composer-row">
            <input name="code" placeholder="code, e.g. growth" required pattern="[a-z0-9][a-z0-9-]{1,39}" aria-label="Plan code" />
            <input name="name" placeholder="Name" required maxLength={80} aria-label="Plan name" />
          </div>
          <input name="description" placeholder="Description" maxLength={500} aria-label="Plan description" />
          <div className="composer-row">
            <input name="price" placeholder="Price, e.g. 15.00" required inputMode="decimal" aria-label="Price" />
            <input name="currency" defaultValue="GBP" required pattern="[A-Za-z]{3}" aria-label="Currency" />
            <select name="interval" defaultValue="month" aria-label="Billing interval">
              <option value="month">monthly</option>
              <option value="year">yearly</option>
            </select>
          </div>
          <fieldset>
            <legend>Unlocks</legend>
            {Object.entries(ENTITLEMENT_LABEL).map(([k, label]) => (
              <label key={k} className="row small">
                <span>{label}</span>
                <input type="checkbox" name="entitlements" value={k} defaultChecked />
              </label>
            ))}
          </fieldset>
          <button className="btn" type="submit">
            Create plan
          </button>
        </form>
      </section>

      <section className="card stack" data-testid="admin-payments">
        <h2>Recent card payments</h2>
        {list.length === 0 && <p className="muted">None yet.</p>}
        {list.map((p) => (
          <div className="row small" key={p.id}>
            <span>
              {p.business?.name} · {money(p.amountMinor, p.currency)} · {new Date(p.createdAt).toLocaleString()}
            </span>
            <span className="pill">{PAYMENT_LABEL[p.status]}</span>
          </div>
        ))}
      </section>
      {err && <p className="error">{err}</p>}
    </>
  );
}

/** Our ledger against the payment provider's own balance records, for a chosen period. */
function ProviderCheck() {
  const [days, setDays] = useState(7);
  const [result, setResult] = useState<Reconciliation | null>(null);
  const { err, act } = useAct();
  return (
    <section className="card stack" data-testid="reconciliation">
      <h2>Check against the payment provider</h2>
      <p className="small muted">Compares what we recorded with the provider’s balance records, to catch anything a lost notification missed.</p>
      <div className="composer-row">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={1}>Last day</option>
          <option value={7}>Last 7 days</option>
          <option value={31}>Last 31 days</option>
        </select>
        <button
          className="btn small"
          data-testid="run-reconciliation"
          onClick={() => act(async () => {
            const to = new Date();
            const from = new Date(to.getTime() - days * 86400_000);
            setResult(await chatApi<Reconciliation>('GET', `admin/reconciliation?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`));
          })}
        >
          Run check
        </button>
      </div>
      {result && (
        <>
          <p data-testid="reconciliation-result" data-ok={String(result.ok)}>
            {result.ok ? `All ${result.matched} payments, refunds and disputes match.` : `${result.problems.length} differences found; ${result.matched} match.`}
          </p>
          {result.problems.map((p) => (
            <p key={`${p.kind}:${p.ref}`} className="error small">
              {p.kind} {p.ref}: {p.problem.replace(/_/g, ' ')} (ours {p.ourAmountMinor === null ? 'none' : money(p.ourAmountMinor, p.currency)}, provider{' '}
              {p.providerAmountMinor === null ? 'none' : money(p.providerAmountMinor, p.currency)})
            </p>
          ))}
          {result.subscriptions.map((t) => (
            <p key={t.currency} className={t.differenceMinor ? 'error small' : 'small'}>
              Plan charges in {t.currency}: ours {money(t.ledgerMinor, t.currency)}, provider {money(t.providerMinor, t.currency)}
            </p>
          ))}
        </>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
