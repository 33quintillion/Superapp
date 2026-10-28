'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { chatApi, newClientId } from '@/lib/chat-client';
import { Tabs } from '../../tabs';
import {
  Booking,
  BOOKING_STATUS_LABEL,
  Business,
  BusinessSubscription,
  Dispute,
  DISPUTE_STATUS_LABEL,
  ENTITLEMENT_LABEL,
  Item,
  localTime,
  money,
  NEXT_STEPS,
  Order,
  ORDER_STATUS_LABEL,
  Payment,
  PAYMENT_LABEL,
  Payout,
  PayoutAccount,
  Plan,
  PlanChangePreview,
  Service,
  StaffMember,
  StaffRole,
  toMinor,
} from '@/lib/business-client';

type Tab = 'orders' | 'bookings' | 'catalogue' | 'services' | 'staff' | 'payments' | 'settings';
const TABS: { id: Tab; label: string; needs: string }[] = [
  { id: 'orders', label: 'Orders', needs: 'orders.view' },
  { id: 'bookings', label: 'Bookings', needs: 'bookings.view' },
  { id: 'catalogue', label: 'Catalogue', needs: 'catalogue.manage' },
  { id: 'services', label: 'Services and hours', needs: 'services.manage' },
  { id: 'staff', label: 'Staff', needs: 'staff.view' },
  { id: 'payments', label: 'Payments and plan', needs: 'payments.view' },
  { id: 'settings', label: 'Settings', needs: 'business.edit' },
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The back office. Tabs and buttons follow the person's permissions; the API enforces them again. */
export function ManageBusiness({ initial, me, initialTab }: { initial: Business; me: string; initialTab?: string }) {
  const [b, setB] = useState(initial);
  const tabs = TABS.filter((t) => b.permissions.includes(t.needs));
  const [tab, setTab] = useState<Tab>(tabs.find((t) => t.id === initialTab)?.id ?? tabs[0]?.id ?? 'orders');
  return (
    <main className="wide social">
      <div className="card">
        <h1 data-testid="business-name">{b.name}</h1>
        <p className="muted small">
          @{b.handle} · You: <span data-testid="my-role">{b.myRole}</span> · <Link href={`/b/${b.handle}`}>Customer view</Link>
        </p>
        {b.state === 'suspended' && (
          <p className="error" data-testid="suspended">
            Suspended by Nexa: {b.suspensionReason || 'no reason given'}. Customers can’t see this business.
          </p>
        )}
      </div>
      <Tabs tabs={tabs.map((t) => [t.id, t.label] as const)} selected={tab} onSelect={setTab}>
        {tab === 'orders' && <OrdersTab b={b} />}
        {tab === 'bookings' && <BookingsTab b={b} />}
        {tab === 'catalogue' && <CatalogueTab b={b} />}
        {tab === 'services' && <ServicesTab b={b} />}
        {tab === 'staff' && <StaffTab b={b} me={me} />}
        {tab === 'payments' && <PaymentsTab b={b} onChange={setB} />}
        {tab === 'settings' && <SettingsTab b={b} onChange={setB} />}
      </Tabs>
    </main>
  );
}

function useAct() {
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  return { err, act };
}

function OrdersTab({ b }: { b: Business }) {
  const [open, setOpen] = useState(true);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const { err, act } = useAct();
  const load = useCallback(async () => {
    const status = open ? 'placed,accepted,ready' : 'completed,cancelled,rejected';
    setOrders((await chatApi<{ orders: Order[] }>('GET', `businesses/${b.id}/orders?status=${status}`)).orders);
  }, [b.id, open]);
  useEffect(() => {
    void load();
    // New orders also arrive over the WebSocket; polling keeps this screen simple and correct.
    const t = setInterval(() => void load().catch(() => undefined), 10_000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <section className="card stack" data-testid="orders-tab">
      <div className="composer-row">
        <button className={open ? 'btn small' : 'btn quiet small'} onClick={() => setOpen(true)}>
          Open
        </button>
        <button className={!open ? 'btn small' : 'btn quiet small'} onClick={() => setOpen(false)}>
          Finished
        </button>
        <button className="btn quiet small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {orders?.length === 0 && <p className="muted">No orders here.</p>}
      {orders?.map((o) => (
        <div className="row" key={o.id} data-testid="order" data-status={o.status}>
          <div>
            <strong>{o.customer?.displayName ?? 'Deleted account'}</strong> <span className="pill">{ORDER_STATUS_LABEL[o.status]}</span>{' '}
            <span className="pill" data-testid="order-payment">
              {o.paymentStatus ? PAYMENT_LABEL[o.paymentStatus] : 'Pay at pickup'}
            </span>
            <div className="small">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</div>
            <div className="small muted">
              {money(o.totalMinor, o.currency)} · {localTime(o.createdAt, b.timeZone, true)}
              {o.refundedMinor > 0 && ` · ${money(o.refundedMinor, o.currency)} refunded`}
              {o.note && ` · “${o.note}”`}
            </div>
            {b.permissions.includes('orders.refund') && (o.paymentStatus === 'paid' || o.paymentStatus === 'partially_refunded') && (
              <RefundForm path={`orders/${o.id}/refunds`} leftMinor={o.totalMinor - o.refundedMinor} currency={o.currency} onDone={() => void load()} />
            )}
          </div>
          {b.permissions.includes('orders.manage') && (
            <span className="actions">
              {NEXT_STEPS[o.status].map((s) => (
                <button key={s.to} className={s.to === 'rejected' || s.to === 'cancelled' ? 'btn quiet small danger' : 'btn small'} onClick={() => act(async () => {
                  await chatApi('POST', `orders/${o.id}/status`, { status: s.to });
                  await load();
                })}>
                  {s.label}
                </button>
              ))}
            </span>
          )}
        </div>
      ))}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function BookingsTab({ b }: { b: Business }) {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const { err, act } = useAct();
  const load = useCallback(async () => {
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 30 * 86400_000).toISOString();
    setBookings((await chatApi<{ bookings: Booking[] }>('GET', `businesses/${b.id}/bookings?from=${from}&to=${to}`)).bookings);
  }, [b.id]);
  useEffect(() => void load(), [load]);
  return (
    <section className="card stack" data-testid="bookings-tab">
      <p className="muted small">Yesterday to 30 days ahead, times in {b.timeZone}.</p>
      {bookings?.length === 0 && <p className="muted">No bookings yet.</p>}
      {bookings?.map((k) => {
        const started = Date.parse(k.startsAt) <= Date.now();
        return (
          <div className="row" key={k.id} data-testid="business-booking" data-status={k.status}>
            <div>
              <strong>{localTime(k.startsAt, b.timeZone, true)}</strong> {k.service.name} · {k.customer?.displayName ?? 'Deleted account'}
              <span className="pill">{BOOKING_STATUS_LABEL[k.status]}</span>
              {k.deposit?.status && (
                <span className="pill" data-testid="booking-deposit">
                  Deposit {money(k.deposit.amountMinor, k.currency)}: {PAYMENT_LABEL[k.deposit.status].toLowerCase()}
                </span>
              )}
              {k.note && <div className="small muted">“{k.note}”</div>}
              {b.permissions.includes('bookings.refund') && k.deposit && (k.deposit.status === 'paid' || k.deposit.status === 'partially_refunded') && (
                <RefundForm path={`bookings/${k.id}/refunds`} leftMinor={k.deposit.amountMinor - k.deposit.refundedMinor} currency={k.currency} onDone={() => void load()} />
              )}
            </div>
            {k.status === 'confirmed' && (
              <span className="actions">
                {started ? (
                  <>
                    <button className="btn small" onClick={() => act(async () => { await chatApi('POST', `bookings/${k.id}/outcome`, { status: 'completed' }); await load(); })}>
                      Came
                    </button>
                    <button className="btn quiet small" onClick={() => act(async () => { await chatApi('POST', `bookings/${k.id}/outcome`, { status: 'no_show' }); await load(); })}>
                      No-show
                    </button>
                  </>
                ) : (
                  <button
                    className="btn quiet small danger"
                    onClick={() => {
                      if (k.deposit?.status === 'paid' && !confirm(`Cancel this booking? The ${money(k.deposit.amountMinor, k.currency)} deposit will be refunded.`)) return;
                      void act(async () => { await chatApi('POST', `bookings/${k.id}/cancel`); await load(); });
                    }}
                  >
                    Cancel
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function CatalogueTab({ b }: { b: Business }) {
  const [items, setItems] = useState<Item[]>([]);
  const { err, act } = useAct();
  const load = useCallback(async () => setItems((await chatApi<{ items: Item[] }>('GET', `businesses/${b.id}/items?all=true`)).items), [b.id]);
  useEffect(() => void load(), [load]);
  return (
    <section className="card stack" data-testid="catalogue-tab">
      {items.map((i) => (
        <div className="row" key={i.id} data-testid="catalogue-item">
          <span>
            <strong>{i.name}</strong> · {money(i.priceMinor, i.currency)}
            {i.stock !== null && <span className="muted small"> · {i.stock} left</span>}
            {!i.available && <span className="pill">Hidden</span>}
          </span>
          <span className="actions">
            <button className="btn quiet small" onClick={() => act(async () => { await chatApi('PATCH', `businesses/${b.id}/items/${i.id}`, { available: !i.available }); await load(); })}>
              {i.available ? 'Hide' : 'Show'}
            </button>
            <button className="btn quiet small danger" onClick={() => act(async () => { await chatApi('DELETE', `businesses/${b.id}/items/${i.id}`); await load(); })}>
              Remove
            </button>
          </span>
        </div>
      ))}
      <form
        className="stack"
        data-testid="add-item"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          void act(async () => {
            const stock = String(f.get('stock') ?? '').trim();
            await chatApi('POST', `businesses/${b.id}/items`, {
              name: f.get('name'),
              description: f.get('description'),
              priceMinor: toMinor(String(f.get('price')), b.currency),
              stock: stock === '' ? null : Number(stock),
              position: items.length,
            });
            form.reset();
            await load();
          });
        }}
      >
        <h2>Add an item</h2>
        <input name="name" placeholder="Name" required maxLength={120} aria-label="Item name" />
        <input name="description" placeholder="Description (optional)" maxLength={1000} aria-label="Item description" />
        <div className="composer-row">
          <input name="price" placeholder={`Price in ${b.currency}`} required inputMode="decimal" aria-label="Price" />
          <input name="stock" placeholder="Stock (blank = not tracked)" inputMode="numeric" aria-label="Stock" />
        </div>
        <button className="btn" type="submit">
          Add item
        </button>
      </form>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function ServicesTab({ b }: { b: Business }) {
  const [services, setServices] = useState<Service[]>([]);
  const [hours, setHours] = useState<{ weekday: number; opens: string; closes: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const { err, act } = useAct();
  const load = useCallback(async () => {
    setServices((await chatApi<{ services: Service[] }>('GET', `businesses/${b.id}/services?all=true`)).services);
    setHours((await chatApi<{ hours: typeof hours }>('GET', `businesses/${b.id}/hours`)).hours);
  }, [b.id]);
  useEffect(() => void load(), [load]);
  return (
    <section className="stack">
      <div className="card stack" data-testid="services-tab">
        <h2>Services people can book</h2>
        {services.map((s) => (
          <div className="row" key={s.id} data-testid="service">
            <span>
              <strong>{s.name}</strong> · {s.durationMinutes} min · {money(s.priceMinor, s.currency)}
              {s.capacity > 1 && ` · ${s.capacity} at a time`}
              {s.depositMinor > 0 && (
                <span className="small muted" data-testid="service-deposit">
                  {' '}
                  · {money(s.depositMinor, s.currency)} deposit, free cancellation up to {s.freeCancelHours} h before
                </span>
              )}
            </span>
            <button className="btn quiet small danger" onClick={() => act(async () => { await chatApi('DELETE', `businesses/${b.id}/services/${s.id}`); await load(); })}>
              Remove
            </button>
          </div>
        ))}
        <form
          className="stack"
          data-testid="add-service"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            void act(async () => {
              await chatApi('POST', `businesses/${b.id}/services`, {
                name: f.get('name'),
                durationMinutes: Number(f.get('duration')),
                priceMinor: toMinor(String(f.get('price') || '0'), b.currency),
                capacity: Number(f.get('capacity') || 1),
                depositMinor: toMinor(String(f.get('deposit') || '0'), b.currency),
                freeCancelHours: Number(f.get('freeCancelHours') || 24),
              });
              form.reset();
              await load();
            });
          }}
        >
          <input name="name" placeholder="Service name, e.g. Haircut" required maxLength={120} aria-label="Service name" />
          <div className="composer-row">
            <input name="duration" type="number" min={5} max={480} step={5} defaultValue={30} aria-label="Minutes" />
            <input name="price" placeholder={`Price in ${b.currency}`} inputMode="decimal" aria-label="Service price" />
            <input name="capacity" type="number" min={1} max={100} defaultValue={1} aria-label="People at a time" />
          </div>
          {b.payments.online ? (
            <div className="composer-row">
              <input name="deposit" placeholder={`Deposit paid when booking (${b.currency}, optional)`} inputMode="decimal" aria-label="Deposit" />
              <input name="freeCancelHours" type="number" min={0} max={168} defaultValue={24} aria-label="Free cancellation, hours before" />
            </div>
          ) : (
            <p className="small muted">Set up payouts under Payments and plan to ask for a deposit when people book.</p>
          )}
          <button className="btn" type="submit">
            Add service
          </button>
        </form>
      </div>

      <div className="card stack" data-testid="hours-editor">
        <h2>Opening hours ({b.timeZone})</h2>
        {hours.map((h, i) => (
          <div className="composer-row" key={i} data-testid="hours-row">
            <select value={h.weekday} aria-label="Day" onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>
              {DAYS.map((d, n) => (
                <option key={d} value={n}>
                  {d}
                </option>
              ))}
            </select>
            <input type="time" aria-label="Opens" value={h.opens} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, opens: e.target.value } : x)))} />
            <input type="time" aria-label="Closes" value={h.closes} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, closes: e.target.value } : x)))} />
            <button className="btn quiet small" onClick={() => setHours(hours.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div className="composer-row">
          <button className="btn quiet small" onClick={() => setHours([...hours, { weekday: 1, opens: '09:00', closes: '17:00' }])}>
            Add opening time
          </button>
          <button
            className="btn quiet small"
            onClick={() => setHours([1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: '09:00', closes: '17:00' })))}
          >
            Weekdays 9 to 5
          </button>
          <button
            className="btn small"
            data-testid="save-hours"
            onClick={() => act(async () => {
              setSaved(false);
              setHours((await chatApi<{ hours: typeof hours }>('PUT', `businesses/${b.id}/hours`, { hours })).hours);
              setSaved(true);
            })}
          >
            Save hours
          </button>
        </div>
        {saved && <p className="small muted" data-testid="hours-saved">Saved.</p>}
      </div>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function StaffTab({ b, me }: { b: Business; me: string }) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const { err, act } = useAct();
  const load = useCallback(async () => setStaff((await chatApi<{ staff: StaffMember[] }>('GET', `businesses/${b.id}/staff`)).staff), [b.id]);
  useEffect(() => void load(), [load]);
  const canManage = b.permissions.includes('staff.manage');
  const assignable: StaffRole[] = b.myRole === 'owner' ? ['manager', 'staff'] : ['staff'];
  return (
    <section className="card stack" data-testid="staff-tab">
      {staff.map((s) => (
        <div className="row" key={s.user.id} data-testid="staff-member" data-role={s.role}>
          <span>
            <strong>{s.user.displayName}</strong> <span className="muted small">@{s.user.username}</span> <span className="pill">{s.role}</span>
            {s.state === 'invited' && <span className="pill">Invited</span>}
          </span>
          {canManage && s.user.id !== me && s.role !== 'owner' && (b.myRole === 'owner' || s.role === 'staff') && (
            <span className="actions">
              {b.myRole === 'owner' && s.state === 'active' && (
                <button className="btn quiet small" onClick={() => act(async () => { setStaff((await chatApi<{ staff: StaffMember[] }>('PATCH', `businesses/${b.id}/staff/${s.user.id}`, { role: s.role === 'manager' ? 'staff' : 'manager' })).staff); })}>
                  Make {s.role === 'manager' ? 'staff' : 'manager'}
                </button>
              )}
              {b.myRole === 'owner' && s.role === 'manager' && s.state === 'active' && (
                <button className="btn quiet small" onClick={() => act(async () => { setStaff((await chatApi<{ staff: StaffMember[] }>('POST', `businesses/${b.id}/transfer`, { userId: s.user.id })).staff); location.reload(); })}>
                  Make owner
                </button>
              )}
              <button className="btn quiet small danger" onClick={() => act(async () => { await chatApi('DELETE', `businesses/${b.id}/staff/${s.user.id}`); await load(); })}>
                Remove
              </button>
            </span>
          )}
        </div>
      ))}
      {canManage && (
        <form
          className="composer-row"
          data-testid="invite-staff"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            void act(async () => {
              setStaff((await chatApi<{ staff: StaffMember[] }>('POST', `businesses/${b.id}/staff`, { username: f.get('username'), role: f.get('role') })).staff);
              form.reset();
            });
          }}
        >
          <input name="username" placeholder="Username" required aria-label="Username to invite" />
          <select name="role" aria-label="Role" defaultValue="staff">
            {assignable.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button className="btn small" type="submit">
            Invite
          </button>
        </form>
      )}
      <p className="small muted">Owner: everything. Managers: profile, catalogue, services, hours and staff. Staff: orders and bookings.</p>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function SettingsTab({ b, onChange }: { b: Business; onChange: (b: Business) => void }) {
  const router = useRouter();
  const { err, act } = useAct();
  const patch = (body: Partial<Business>) => act(async () => onChange(await chatApi<Business>('PATCH', `businesses/${b.id}`, body)));
  return (
    <section className="card stack" data-testid="settings-tab">
      <label className="row">
        <span>Taking orders</span>
        <input type="checkbox" name="ordersEnabled" checked={b.ordersEnabled} onChange={(e) => patch({ ordersEnabled: e.target.checked })} />
      </label>
      <label className="row">
        <span>Taking bookings</span>
        <input type="checkbox" name="bookingsEnabled" checked={b.bookingsEnabled} onChange={(e) => patch({ bookingsEnabled: e.target.checked })} />
      </label>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void patch({ name: String(f.get('name')), description: String(f.get('description')), address: String(f.get('address')) });
        }}
      >
        <label className="field">
          <span>Name</span>
          <input name="name" defaultValue={b.name} maxLength={80} required />
        </label>
        <label className="field">
          <span>Description</span>
          <input name="description" defaultValue={b.description} maxLength={2000} />
        </label>
        <label className="field">
          <span>Address</span>
          <input name="address" defaultValue={b.address} maxLength={300} />
        </label>
        <button className="btn" type="submit">
          Save
        </button>
      </form>
      {b.payments.online ? (
        <label className="row">
          <span>Also take payment at pickup</span>
          <input type="checkbox" name="inPersonPayments" checked={b.payments.inPerson} onChange={(e) => patch({ inPersonPayments: e.target.checked } as Partial<Business>)} />
        </label>
      ) : (
        <p className="small muted">Customers pay when they collect. Set up payouts under Payments and plan to take card payments online.</p>
      )}
      {b.myRole === 'owner' && (
        <button
          className="btn quiet danger"
          onClick={() => {
            if (!confirm(`Close ${b.name}? Open orders and future bookings will be cancelled.`)) return;
            void act(async () => {
              await chatApi('DELETE', `businesses/${b.id}`);
              router.push('/business');
            });
          }}
        >
          Close this business
        </button>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

/** Staff refund part or all of a paid order or deposit. The id makes a double click or a retry harmless. */
function RefundForm({ path, leftMinor: left, currency, onDone }: { path: string; leftMinor: number; currency: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newClientId);
  const { err, act } = useAct();
  if (!open)
    return (
      <button className="link-btn small" onClick={() => setOpen(true)}>
        Refund
      </button>
    );
  return (
    <form
      className="composer-row"
      data-testid="refund-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const amount = String(f.get('amount') ?? '').trim();
        void act(async () => {
          await chatApi('POST', path, {
            clientId: key,
            reason: String(f.get('reason') ?? ''),
            ...(amount ? { amountMinor: toMinor(amount, currency) } : {}),
          });
          setKey(newClientId());
          setOpen(false);
          onDone();
        });
      }}
    >
      <input name="amount" inputMode="decimal" placeholder={`Amount (blank = all ${money(left, currency)})`} aria-label="Refund amount" />
      <input name="reason" placeholder="Reason (optional)" maxLength={300} aria-label="Refund reason" />
      <button className="btn small danger" type="submit">
        Refund
      </button>
      {err && <span className="error small">{err}</span>}
    </form>
  );
}

type PaymentList = { payments: Payment[]; totals: { currency: string; paidMinor: number; refundedMinor: number; disputedMinor: number; feesMinor: number }[] };

const COUNTRIES = ['GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'IN', 'SG'];

/** Payouts (where customers' money goes), the business's plan, and what was paid online. */
function PaymentsTab({ b, onChange }: { b: Business; onChange: (b: Business) => void }) {
  const [account, setAccount] = useState<PayoutAccount | null>(null);
  const [sub, setSub] = useState<BusinessSubscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [payments, setPayments] = useState<PaymentList | null>(null);
  const [payoutList, setPayoutList] = useState<Payout[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const { err, act } = useAct();
  const owner = b.permissions.includes('payments.manage');
  const load = useCallback(async () => {
    const [a, s, p, list, d] = await Promise.all([
      chatApi<PayoutAccount>('GET', `businesses/${b.id}/payments/account`),
      chatApi<BusinessSubscription>('GET', `businesses/${b.id}/subscription`),
      chatApi<{ plans: Plan[] }>('GET', 'plans'),
      chatApi<PaymentList>('GET', `businesses/${b.id}/payments?limit=20`),
      chatApi<{ disputes: Dispute[] }>('GET', `businesses/${b.id}/disputes`),
    ]);
    setAccount(a);
    setSub(s);
    setPlans(p.plans);
    setPayments(list);
    setDisputes(d.disputes);
    // Payouts come from the provider; the rest of the page works without them.
    if (a.connected) setPayoutList((await chatApi<{ payouts: Payout[] }>('GET', `businesses/${b.id}/payouts`).catch(() => ({ payouts: [] }))).payouts);
    // Payout status decides whether customers see "pay now"; keep the header in step.
    if (a.onlinePayments !== b.payments.online) onChange(await chatApi<Business>('GET', `businesses/${b.id}`));
  }, [b.id, b.payments.online, onChange]);
  useEffect(() => void load().catch(() => undefined), [load]);
  const go = (path: string, body?: unknown) =>
    act(async () => {
      const { url } = await chatApi<{ url: string }>('POST', path, body);
      window.location.assign(url);
    });

  if (!account || !sub) return <section className="card">Loading…</section>;
  return (
    <>
      <section className="card stack" data-testid="payouts">
        <h2>Online payments</h2>
        {!account.enabled ? (
          <p className="muted">Online payments aren’t switched on for Nexa yet. Customers pay when they collect.</p>
        ) : account.onlinePayments ? (
          <p data-testid="payouts-ready">
            Customers can pay by card when they order. Money goes to your own account at our payment provider{account.payoutsEnabled ? ', which pays it out to your bank.' : '; finish your bank details there to get paid out.'}
          </p>
        ) : (
          <>
            <p data-testid="payouts-not-ready">
              {account.connected
                ? 'Your payout account isn’t finished yet. The payment provider needs a few more details before you can take card payments.'
                : 'Take card payments online. Our payment provider checks who you are and pays out to your bank; Nexa never holds your money.'}
            </p>
            {owner ? (
              <form
                className="composer-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void go(`businesses/${b.id}/payments/account`, { country: String(new FormData(e.currentTarget).get('country')) });
                }}
              >
                {!account.connected && (
                  <select name="country" defaultValue="GB" aria-label="Country of the business">
                    {COUNTRIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                )}
                {account.connected && <input type="hidden" name="country" value={account.country ?? 'GB'} />}
                <button className="btn" type="submit" data-testid="setup-payouts">
                  {account.connected ? 'Continue setup' : 'Set up payouts'}
                </button>
              </form>
            ) : (
              <p className="small muted">Only the owner can set up payouts.</p>
            )}
          </>
        )}
        {payoutList.length > 0 && (
          <div className="stack" data-testid="payout-list">
            <h3>Recent payouts to your bank</h3>
            {payoutList.map((p) => (
              <div className="row small" key={p.id} data-testid="payout">
                <span>
                  {money(p.amountMinor, p.currency)}
                  {p.arrivalDate && ` · arrives ${new Date(p.arrivalDate).toLocaleDateString()}`}
                </span>
                <span className="pill">{p.status.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {disputes.length > 0 && (
        <section className="card stack" data-testid="disputes">
          <h2>Disputes</h2>
          <p className="small muted">
            A customer asked their bank to take back a card payment. The bank holds the money while it decides; tell it your side before the date shown. If you win, the money comes back to you.
          </p>
          {disputes.map((d) => (
            <div className="stack" key={d.id} data-testid="dispute" data-status={d.status}>
              <div className="row">
                <span>
                  {money(d.amountMinor, d.currency)} · {d.orderId ? 'order' : 'booking deposit'} · {d.reason.replace(/_/g, ' ') || 'no reason given'}
                  {d.evidenceDueBy && d.canRespond && <span className="small muted"> · respond by {new Date(d.evidenceDueBy).toLocaleDateString()}</span>}
                </span>
                <span className="pill">{DISPUTE_STATUS_LABEL[d.status]}</span>
              </div>
              {d.canRespond && b.permissions.includes('disputes.respond') && (
                <DisputeResponse dispute={d} onSent={(x) => setDisputes(disputes.map((y) => (y.id === x.id ? x : y)))} />
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card stack" data-testid="plan">
        <h2>Plan</h2>
        {sub.subscription ? (
          <>
            <p data-testid="current-plan" data-status={sub.subscription.status}>
              <strong>{sub.subscription.plan.name}</strong>, {money(sub.subscription.plan.priceMinor, sub.subscription.plan.currency)} a {sub.subscription.plan.interval}.{' '}
              {sub.subscription.status === 'past_due' && <span className="pill error">Payment failed: update your card</span>}
              {sub.subscription.currentPeriodEnd &&
                (sub.subscription.cancelAtPeriodEnd ? ` Ends on ${new Date(sub.subscription.currentPeriodEnd).toLocaleDateString()}.` : ` Renews on ${new Date(sub.subscription.currentPeriodEnd).toLocaleDateString()}.`)}
            </p>
            {b.permissions.includes('billing.manage') && (
              <div className="composer-row">
                {sub.subscription.cancelAtPeriodEnd ? (
                  <button className="btn small" onClick={() => act(async () => setSub(await chatApi<BusinessSubscription>('POST', `businesses/${b.id}/subscription/resume`)))}>
                    Keep my plan
                  </button>
                ) : (
                  <button className="btn quiet small danger" onClick={() => act(async () => setSub(await chatApi<BusinessSubscription>('DELETE', `businesses/${b.id}/subscription`)))}>
                    Cancel at the end of the period
                  </button>
                )}
                <button className="btn quiet small" onClick={() => go(`businesses/${b.id}/billing-portal`)}>
                  Card and invoices
                </button>
              </div>
            )}
            {b.permissions.includes('billing.manage') && !sub.subscription.cancelAtPeriodEnd && sub.subscription.status === 'active' && (
              <div className="stack" data-testid="change-plan">
                {plans
                  .filter((p) => p.id !== sub.subscription!.plan.id && p.currency === sub.subscription!.plan.currency)
                  .map((p) => (
                    <div className="row small" key={p.id} data-testid="switch-option" data-code={p.code}>
                      <span>
                        Switch to <strong>{p.name}</strong> · {money(p.priceMinor, p.currency)} a {p.interval}
                      </span>
                      <button className="btn quiet small" onClick={() => act(async () => setPreview(await chatApi<PlanChangePreview>('POST', `businesses/${b.id}/subscription/preview`, { planCode: p.code })))}>
                        See the cost
                      </button>
                    </div>
                  ))}
                {preview && (
                  <div className="stack" data-testid="plan-preview">
                    <p>
                      Switching to <strong>{preview.plan.name}</strong>{' '}
                      {preview.amountDueNowMinor > 0
                        ? `costs ${money(preview.amountDueNowMinor, preview.currency)} today, for the rest of this period.`
                        : preview.amountDueNowMinor < 0
                          ? `gives you ${money(-preview.amountDueNowMinor, preview.currency)} of credit towards your next bills.`
                          : 'costs nothing extra today.'}
                      {preview.intervalChanges && ' A new billing period starts today.'}
                      {' '}Then {money(preview.plan.priceMinor, preview.currency)} a {preview.plan.interval}.
                    </p>
                    <div className="composer-row">
                      <button
                        className="btn small"
                        data-testid="confirm-switch"
                        onClick={() => act(async () => {
                          setSub(await chatApi<BusinessSubscription>('POST', `businesses/${b.id}/subscription/change`, { planCode: preview.plan.code, clientId: newClientId() }));
                          setPreview(null);
                        })}
                      >
                        Switch now
                      </button>
                      <button className="btn quiet small" onClick={() => setPreview(null)}>
                        Not now
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="muted">Free plan.</p>
        )}
        <p className="small muted" data-testid="limits">
          Up to {sub.limits.staff} staff and {sub.limits.catalogue.toLocaleString()} catalogue items.
        </p>
        {!sub.subscription && plans.length > 0 && (
          <div className="stack">
            {plans.map((p) => (
              <div className="row" key={p.id} data-testid="plan-option" data-code={p.code}>
                <span>
                  <strong>{p.name}</strong> · {money(p.priceMinor, p.currency)} a {p.interval}
                  {p.description && <span className="small muted"> · {p.description}</span>}
                  <br />
                  <span className="small">{p.entitlements.map((e) => ENTITLEMENT_LABEL[e] ?? e).join(' · ')}</span>
                </span>
                {b.permissions.includes('billing.manage') && (
                  <button className="btn small" onClick={() => go(`businesses/${b.id}/subscription`, { planCode: p.code, clientId: newClientId() })}>
                    Choose
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {payments && payments.payments.length > 0 && (
        <section className="card stack" data-testid="payments-list">
          <h2>Card payments</h2>
          {payments.totals.map((t) => (
            <p key={t.currency} className="small">
              Paid {money(t.paidMinor, t.currency)} · refunded {money(t.refundedMinor, t.currency)}
              {t.disputedMinor > 0 && ` · held in disputes ${money(t.disputedMinor, t.currency)}`} · Nexa fee {money(t.feesMinor, t.currency)}
            </p>
          ))}
          {payments.payments.map((p) => (
            <div className="row small" key={p.id}>
              <span>
                {money(p.amountMinor, p.currency)} · {p.bookingId ? 'deposit' : 'order'} · {localTime(p.createdAt, b.timeZone, true)}
              </span>
              <span className="actions">
                {p.disputeStatus && <span className="pill">{DISPUTE_STATUS_LABEL[p.disputeStatus]}</span>}
                <span className="pill">{PAYMENT_LABEL[p.status]}</span>
              </span>
            </div>
          ))}
        </section>
      )}
      {err && <p className="error">{err}</p>}
    </>
  );
}

/** The business's side of a dispute, sent to the customer's bank once. */
function DisputeResponse({ dispute: d, onSent }: { dispute: Dispute; onSent: (d: Dispute) => void }) {
  const { err, act } = useAct();
  return (
    <form
      className="stack"
      data-testid="dispute-response"
      onSubmit={(e) => {
        e.preventDefault();
        const text = String(new FormData(e.currentTarget).get('text') ?? '');
        if (!confirm('Send this to the bank? You can only send it once.')) return;
        void act(async () => onSent(await chatApi<Dispute>('POST', `disputes/${d.id}/response`, { text })));
      }}
    >
      <label className="field">
        <span>What happened? Include dates, what the customer got, and any messages with them.</span>
        <textarea name="text" required minLength={20} maxLength={20000} rows={4} />
      </label>
      <button className="btn small" type="submit">
        Send to the bank
      </button>
      {err && <p className="error small">{err}</p>}
    </form>
  );
}
