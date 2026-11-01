'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { chatApi, newClientId } from '@/lib/chat-client';
import { Booking, Business, Item, localTime, money, Order, ORDER_STATUS_LABEL, Service, Slot, todayIn } from '@/lib/business-client';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** What a customer sees: the catalogue with a basket, and booking a time. */
export function Storefront({ business: b, items, services, hours }: { business: Business; items: Item[]; services: Service[]; hours: { weekday: number; opens: string; closes: string }[] }) {
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [placed, setPlaced] = useState<Order | null>(null);
  // One id per basket, so a double click or a retry after a network error can't order twice.
  const [orderKey, setOrderKey] = useState(newClientId);
  const [err, setErr] = useState<string | null>(null);
  const [payment, setPayment] = useState<'online' | 'pay_in_person'>(b.payments.inPerson ? 'pay_in_person' : 'online');
  const [busy, setBusy] = useState(false);
  const lines = items.filter((i) => basket[i.id]);
  const total = lines.reduce((t, i) => t + i.priceMinor * basket[i.id], 0);
  const add = (id: string, d: number) => setBasket((x) => ({ ...x, [id]: Math.max(0, Math.min(99, (x[id] ?? 0) + d)) }));

  return (
    <main className="wide social">
      <div className="card">
        <h1 data-testid="business-name">
          {b.name} {b.verified && <span className="pill">Verified</span>}
        </h1>
        <p className="muted small">
          @{b.handle} · {b.category}
          {b.address && ` · ${b.address}`}
        </p>
        {b.description && <p>{b.description}</p>}
        {hours.length > 0 && (
          <p className="small muted" data-testid="hours">
            {hours.map((h) => `${DAYS[h.weekday]} ${h.opens}–${h.closes}`).join(' · ')} ({b.timeZone})
          </p>
        )}
        {b.myRole && (
          <p>
            <Link href={`/business/${b.handle}`}>Manage this business</Link>
          </p>
        )}
        <ReportBusiness id={b.id} />
      </div>

      {items.length > 0 && (
        <section className="card stack" data-testid="catalogue">
          <h2>Order for pickup</h2>
          {!b.ordersEnabled && <p className="muted">Not taking orders right now.</p>}
          {items.map((i) => (
            <div className="row" key={i.id} data-testid="item" data-name={i.name}>
              <span>
                <strong>{i.name}</strong> {i.description && <span className="muted small">{i.description}</span>}
                <br />
                <span className="small">{money(i.priceMinor, i.currency)}</span> {!i.available && <span className="pill">Sold out</span>}
              </span>
              {b.ordersEnabled && i.available && (
                <span className="actions">
                  {basket[i.id] ? (
                    <>
                      <button className="btn quiet small" aria-label={`One less ${i.name}`} onClick={() => add(i.id, -1)}>
                        −
                      </button>
                      <span data-testid="qty">{basket[i.id]}</span>
                    </>
                  ) : null}
                  <button className="btn quiet small" aria-label={`Add ${i.name}`} onClick={() => add(i.id, 1)}>
                    +
                  </button>
                </span>
              )}
            </div>
          ))}
          {lines.length > 0 && (
            <form
              className="stack"
              data-testid="basket"
              onSubmit={async (e) => {
                e.preventDefault();
                setErr(null);
                setBusy(true);
                try {
                  const o = await chatApi<Order>('POST', `businesses/${b.id}/orders`, {
                    clientId: orderKey,
                    items: lines.map((i) => ({ itemId: i.id, quantity: basket[i.id] })),
                    note,
                    payment,
                  });
                  if (o.payment === 'online' && o.status === 'pending_payment') {
                    // The order holds its items while the customer pays on the provider's page.
                    const { url } = await chatApi<{ url: string }>('POST', `orders/${o.id}/checkout`);
                    window.location.assign(url);
                    return;
                  }
                  setPlaced(o);
                  setBasket({});
                  setNote('');
                  setOrderKey(newClientId());
                } catch (x) {
                  setErr(x instanceof Error ? x.message : 'Could not place the order');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>
                Total <strong data-testid="basket-total">{money(total, b.currency)}</strong>.
                {!b.payments.online && ' You pay when you collect.'}
              </p>
              {b.payments.online && (
                <fieldset className="stack" data-testid="payment-choice">
                  <legend>How do you want to pay?</legend>
                  <label>
                    <input type="radio" name="payment" value="online" checked={payment === 'online'} onChange={() => setPayment('online')} /> Pay now, by card
                  </label>
                  {b.payments.inPerson && (
                    <label>
                      <input type="radio" name="payment" value="pay_in_person" checked={payment === 'pay_in_person'} onChange={() => setPayment('pay_in_person')} /> Pay when I collect
                    </label>
                  )}
                </fieldset>
              )}
              <input name="note" placeholder="Note for the business (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn" type="submit" disabled={busy}>
                {payment === 'online' ? 'Continue to payment' : 'Place order'}
              </button>
              {payment === 'online' && <p className="small muted">You’ll pay on our payment provider’s secure page. We never see your card details.</p>}
            </form>
          )}
          {placed && (
            <p data-testid="order-placed">
              Order placed: {ORDER_STATUS_LABEL[placed.status]}. <Link href="/orders">See your orders</Link>
            </p>
          )}
          {err && <p className="error">{err}</p>}
        </section>
      )}

      {services.length > 0 && <BookingPanel b={b} services={services} />}
    </main>
  );
}

function BookingPanel({ b, services }: { b: Business; services: Service[] }) {
  const [serviceId, setServiceId] = useState(services[0].id);
  const [date, setDate] = useState(() => todayIn(b.timeZone, 1));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [booked, setBooked] = useState<Booking | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const svc = services.find((s) => s.id === serviceId)!;

  useEffect(() => {
    let live = true;
    setSlots(null);
    chatApi<{ slots: Slot[] }>('GET', `businesses/${b.id}/services/${serviceId}/slots?date=${date}`)
      .then((r) => live && setSlots(r.slots))
      .catch(() => live && setSlots([]));
    return () => {
      live = false;
    };
  }, [b.id, serviceId, date, booked]);

  return (
    <section className="card stack" data-testid="booking">
      <h2>Book a time</h2>
      {!b.bookingsEnabled && <p className="muted">Not taking bookings right now.</p>}
      <label className="field">
        <span>Service</span>
        <select name="service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.durationMinutes} min{s.priceMinor ? ` · ${money(s.priceMinor, s.currency)}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Day</span>
        <input type="date" name="date" value={date} min={todayIn(b.timeZone)} onChange={(e) => setDate(e.target.value)} />
        <small>Times are in {b.timeZone}</small>
      </label>
      <div className="slot-grid" data-testid="slots">
        {slots === null ? (
          <span className="muted">Loading…</span>
        ) : slots.length === 0 ? (
          <span className="muted">No free times that day.</span>
        ) : (
          slots.map((s) => (
            <button
              key={s.startsAt}
              className="btn quiet small"
              data-testid="slot"
              onClick={async () => {
                setErr(null);
                try {
                  const k = await chatApi<Booking>('POST', `businesses/${b.id}/bookings`, { serviceId, startsAt: s.startsAt, clientId: newClientId() });
                  if (k.status === 'pending_payment') {
                    // The time is held while the customer pays the deposit on the provider's page.
                    const { url } = await chatApi<{ url: string }>('POST', `bookings/${k.id}/checkout`);
                    window.location.assign(url);
                    return;
                  }
                  setBooked(k);
                } catch (x) {
                  setErr(x instanceof Error ? x.message : 'Could not book that time');
                }
              }}
            >
              {localTime(s.startsAt, b.timeZone)}
            </button>
          ))
        )}
      </div>
      {booked && (
        <p data-testid="booked">
          Booked: {booked.service.name}, {localTime(booked.startsAt, b.timeZone, true)}. <Link href="/orders">See your bookings</Link>
        </p>
      )}
      {svc.description && <p className="small muted">{svc.description}</p>}
      {svc.depositMinor > 0 && (
        <p className="small" data-testid="deposit-note">
          {svc.depositMinor >= svc.priceMinor ? `You pay ${money(svc.depositMinor, svc.currency)} by card when you book.` : `You pay a ${money(svc.depositMinor, svc.currency)} deposit by card when you book, and the rest there.`}{' '}
          Cancel at least {svc.freeCancelHours} hours before to get it back; after that, or if you don’t come, the business keeps it.
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function ReportBusiness({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'open' | 'sent'>('idle');
  if (state === 'sent') return <p className="small muted">Thanks, our team will look at it.</p>;
  if (state === 'idle')
    return (
      <button className="link-btn small" onClick={() => setState('open')}>
        Report this business
      </button>
    );
  return (
    <form
      className="composer-row"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await chatApi('POST', 'reports', { subjectType: 'business', subjectId: id, reason: f.get('reason'), details: f.get('details') });
        setState('sent');
      }}
    >
      <select name="reason" defaultValue="fraud" aria-label="Reason">
        <option value="fraud">Scam or fraud</option>
        <option value="impersonation">Pretending to be someone else</option>
        <option value="spam">Spam</option>
        <option value="other">Something else</option>
      </select>
      <input name="details" placeholder="What happened?" maxLength={2000} />
      <button className="btn small" type="submit">
        Send report
      </button>
    </form>
  );
}
