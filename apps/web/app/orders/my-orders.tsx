'use client';

import Link from 'next/link';
import { useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import { Booking, localTime, money, Order, ORDER_STATUS_LABEL } from '@/lib/business-client';

export function MyOrders({ orders: initialOrders, bookings: initialBookings }: { orders: Order[]; bookings: Booking[] }) {
  const [orders, setOrders] = useState(initialOrders);
  const [bookings, setBookings] = useState(initialBookings);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  return (
    <main className="wide social">
      <h1>Orders and bookings</h1>
      {err && <p className="error">{err}</p>}
      <h2>Bookings</h2>
      <div className="card">
        {bookings.length === 0 && <p className="muted">No bookings yet.</p>}
        {bookings.map((k) => (
          <div className="row" key={k.id} data-testid="my-booking" data-status={k.status}>
            <span>
              <strong>{k.service.name}</strong> at <Link href={`/b/${k.business.handle}`}>{k.business.name}</Link>
              <br />
              <span className="small">{localTime(k.startsAt, k.business.timeZone, true)}</span>{' '}
              <span className="pill">{k.status === 'cancelled' ? `Cancelled${k.cancelledBy === 'business' ? ' by the business' : ''}` : k.status.replace('_', ' ')}</span>
            </span>
            {k.status === 'confirmed' && Date.parse(k.startsAt) > Date.now() && (
              <button
                className="btn quiet small danger"
                onClick={() => act(async () => {
                  const c = await chatApi<Booking>('POST', `bookings/${k.id}/cancel`);
                  setBookings(bookings.map((x) => (x.id === k.id ? c : x)));
                })}
              >
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>
      <h2>Orders</h2>
      <div className="card">
        {orders.length === 0 && <p className="muted">No orders yet.</p>}
        {orders.map((o) => (
          <div className="row" key={o.id} data-testid="my-order" data-status={o.status}>
            <span>
              <Link href={`/b/${o.business.handle}`}>{o.business.name}</Link> <span className="pill">{ORDER_STATUS_LABEL[o.status]}</span>
              <br />
              <span className="small">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</span>
              <br />
              <span className="small muted">
                {money(o.totalMinor, o.currency)}, pay when you collect{o.statusReason && ` · ${o.statusReason}`}
              </span>
            </span>
            {o.status === 'placed' && (
              <button
                className="btn quiet small danger"
                onClick={() => act(async () => {
                  const c = await chatApi<Order>('POST', `orders/${o.id}/cancel`);
                  setOrders(orders.map((x) => (x.id === o.id ? c : x)));
                })}
              >
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
