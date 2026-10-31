'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import { Booking, BOOKING_STATUS_LABEL, cancellationNote, localTime, money, Order, ORDER_STATUS_LABEL, PAYMENT_LABEL } from '@/lib/business-client';

export function MyOrders({
  orders: initialOrders,
  bookings: initialBookings,
  justPaid,
  justBooked,
}: {
  orders: Order[];
  bookings: Booking[];
  justPaid: string | null;
  justBooked: string | null;
}) {
  const [orders, setOrders] = useState(initialOrders);
  const paidOrder = justPaid ? orders.find((o) => o.id === justPaid) : undefined;
  // Back from checkout before the provider's confirmation reached us: check again for a little while.
  useEffect(() => {
    if (!paidOrder || paidOrder.status !== 'pending_payment') return;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      const o = await chatApi<Order>('GET', `orders/${paidOrder.id}`).catch(() => null);
      if (o) setOrders((list) => list.map((x) => (x.id === o.id ? o : x)));
      if ((o && o.status !== 'pending_payment') || tries >= 15) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [paidOrder?.id, paidOrder?.status]);
  const [bookings, setBookings] = useState(initialBookings);
  const paidBooking = justBooked ? bookings.find((k) => k.id === justBooked) : undefined;
  useEffect(() => {
    if (!paidBooking || paidBooking.status !== 'pending_payment') return;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      const k = await chatApi<Booking>('GET', `bookings/${paidBooking.id}`).catch(() => null);
      if (k) setBookings((list) => list.map((x) => (x.id === k.id ? k : x)));
      if ((k && k.status !== 'pending_payment') || tries >= 15) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [paidBooking?.id, paidBooking?.status]);
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
      {paidOrder && (
        <p className="card" data-testid="payment-result" data-status={paidOrder.paymentStatus ?? ''}>
          {paidOrder.paymentStatus === 'paid'
            ? `Thanks, your payment went through. ${paidOrder.business.name} has your order.`
            : paidOrder.status === 'pending_payment'
              ? 'Waiting for the payment to be confirmed…'
              : `This order is ${ORDER_STATUS_LABEL[paidOrder.status].toLowerCase()}.`}
        </p>
      )}
      {paidBooking && (
        <p className="card" data-testid="booking-result" data-status={paidBooking.status}>
          {paidBooking.status === 'confirmed'
            ? `Thanks, your deposit went through. You’re booked at ${paidBooking.business.name}.`
            : paidBooking.status === 'pending_payment'
              ? 'Waiting for the deposit to be confirmed…'
              : `This booking is ${BOOKING_STATUS_LABEL[paidBooking.status].toLowerCase()}.`}
        </p>
      )}
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
              <span className="pill">{k.status === 'cancelled' ? `Cancelled${k.cancelledBy === 'business' ? ' by the business' : ''}` : BOOKING_STATUS_LABEL[k.status]}</span>
              {k.deposit?.status && k.deposit.status !== 'unpaid' && (
                <span className="pill" data-testid="my-booking-deposit">
                  Deposit {money(k.deposit.amountMinor, k.currency)}: {PAYMENT_LABEL[k.deposit.status].toLowerCase()}
                </span>
              )}
              {k.status === 'confirmed' && cancellationNote(k) && (
                <>
                  <br />
                  <span className="small muted">{cancellationNote(k)}</span>
                </>
              )}
            </span>
            <span className="actions">
              {k.status === 'pending_payment' && (
                <button
                  className="btn small"
                  onClick={() => act(async () => {
                    const { url } = await chatApi<{ url: string }>('POST', `bookings/${k.id}/checkout`);
                    window.location.assign(url);
                  })}
                >
                  Pay deposit
                </button>
              )}
              {(k.status === 'confirmed' || k.status === 'pending_payment') && Date.parse(k.startsAt) > Date.now() && (
                <button
                  className="btn quiet small danger"
                  data-testid="cancel-booking"
                  onClick={() => {
                    const note = cancellationNote(k);
                    if (note && !confirm(`Cancel this booking? ${note}`)) return;
                    void act(async () => {
                      const c = await chatApi<Booking>('POST', `bookings/${k.id}/cancel`);
                      setBookings(bookings.map((x) => (x.id === k.id ? c : x)));
                    });
                  }}
                >
                  Cancel
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      <h2>Orders</h2>
      <div className="card">
        {orders.length === 0 && <p className="muted">No orders yet.</p>}
        {orders.map((o) => (
          <div className="row" key={o.id} data-testid="my-order" data-status={o.status} data-payment={o.paymentStatus ?? 'in_person'}>
            <span>
              <Link href={`/b/${o.business.handle}`}>{o.business.name}</Link> <span className="pill">{ORDER_STATUS_LABEL[o.status]}</span>
              {o.paymentStatus && o.paymentStatus !== 'unpaid' && <span className="pill">{PAYMENT_LABEL[o.paymentStatus]}</span>}
              <br />
              <span className="small">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</span>
              <br />
              <span className="small muted">
                {money(o.totalMinor, o.currency)}
                {o.payment === 'pay_in_person' ? ', pay when you collect' : o.refundedMinor > 0 ? `, ${money(o.refundedMinor, o.currency)} refunded to your card` : ''}
                {o.statusReason && ` · ${o.statusReason}`}
              </span>
            </span>
            <span className="actions">
              {o.status === 'pending_payment' && (
                <button
                  className="btn small"
                  onClick={() => act(async () => {
                    const { url } = await chatApi<{ url: string }>('POST', `orders/${o.id}/checkout`);
                    window.location.assign(url);
                  })}
                >
                  Pay now
                </button>
              )}
              {(o.status === 'placed' || o.status === 'pending_payment') && (
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
            </span>
          </div>
        ))}
      </div>
      <p className="small muted">
        {orders.some((o) => o.payment === 'online') && 'Online payments are handled by our payment provider. Cancelled paid orders are refunded to the card you used.'}
      </p>
    </main>
  );
}
