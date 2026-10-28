import { authed } from '@/lib/session';
import type { Booking, Order } from '@/lib/business-client';
import { MyOrders } from './my-orders';

export const dynamic = 'force-dynamic';

const isId = (v?: string) => (v && /^[0-9a-f-]{36}$/.test(v) ? v : null);

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ paid?: string; booked?: string }> }) {
  // The payment provider sends people back here with ?paid=<order id> or ?booked=<booking id> after checkout.
  const { paid, booked } = await searchParams;
  const [orders, bookings] = await Promise.all([
    authed<{ orders: Order[] }>('GET', '/v1/orders?limit=50'),
    authed<{ bookings: Booking[] }>('GET', '/v1/bookings?upcoming=false'),
  ]);
  return <MyOrders orders={orders.orders} bookings={bookings.bookings} justPaid={isId(paid)} justBooked={isId(booked)} />;
}
