'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import { Booking, Business, Item, localTime, money, NEXT_STEPS, Order, ORDER_STATUS_LABEL, Service, StaffMember, StaffRole, toMinor } from '@/lib/business-client';

type Tab = 'orders' | 'bookings' | 'catalogue' | 'services' | 'staff' | 'settings';
const TABS: { id: Tab; label: string; needs: string }[] = [
  { id: 'orders', label: 'Orders', needs: 'orders.view' },
  { id: 'bookings', label: 'Bookings', needs: 'bookings.view' },
  { id: 'catalogue', label: 'Catalogue', needs: 'catalogue.manage' },
  { id: 'services', label: 'Services and hours', needs: 'services.manage' },
  { id: 'staff', label: 'Staff', needs: 'staff.view' },
  { id: 'settings', label: 'Settings', needs: 'business.edit' },
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The back office. Tabs and buttons follow the person's permissions; the API enforces them again. */
export function ManageBusiness({ initial, me }: { initial: Business; me: string }) {
  const [b, setB] = useState(initial);
  const tabs = TABS.filter((t) => b.permissions.includes(t.needs));
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'orders');
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
      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'btn small' : 'btn quiet small'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'orders' && <OrdersTab b={b} />}
      {tab === 'bookings' && <BookingsTab b={b} />}
      {tab === 'catalogue' && <CatalogueTab b={b} />}
      {tab === 'services' && <ServicesTab b={b} />}
      {tab === 'staff' && <StaffTab b={b} me={me} />}
      {tab === 'settings' && <SettingsTab b={b} onChange={setB} />}
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
            <strong>{o.customer?.displayName ?? 'Deleted account'}</strong> <span className="pill">{ORDER_STATUS_LABEL[o.status]}</span>
            <div className="small">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</div>
            <div className="small muted">
              {money(o.totalMinor, o.currency)} · {localTime(o.createdAt, b.timeZone, true)}
              {o.note && ` · “${o.note}”`}
            </div>
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
              <span className="pill">{k.status.replace('_', ' ')}</span>
              {k.note && <div className="small muted">“{k.note}”</div>}
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
                  <button className="btn quiet small danger" onClick={() => act(async () => { await chatApi('POST', `bookings/${k.id}/cancel`); await load(); })}>
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
        <h3>Add an item</h3>
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
        <h3>Services people can book</h3>
        {services.map((s) => (
          <div className="row" key={s.id} data-testid="service">
            <span>
              <strong>{s.name}</strong> · {s.durationMinutes} min · {money(s.priceMinor, s.currency)}
              {s.capacity > 1 && ` · ${s.capacity} at a time`}
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
          <button className="btn" type="submit">
            Add service
          </button>
        </form>
      </div>

      <div className="card stack" data-testid="hours-editor">
        <h3>Opening hours ({b.timeZone})</h3>
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
      <p className="small muted">Payment happens in person for now. Online payment comes once a payment provider is set up.</p>
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
