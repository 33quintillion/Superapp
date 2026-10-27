import { authed } from '@/lib/session';
import type { Booking, Order } from '@/lib/business-client';
import { MyOrders } from './my-orders';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  // The payment provider sends people back here with ?paid=<order id> after checkout.
  const { paid } = await searchParams;
  const [orders, bookings] = await Promise.all([
    authed<{ orders: Order[] }>('GET', '/v1/orders?limit=50'),
    authed<{ bookings: Booking[] }>('GET', '/v1/bookings?upcoming=false'),
  ]);
  return <MyOrders orders={orders.orders} bookings={bookings.bookings} justPaid={paid && /^[0-9a-f-]{36}$/.test(paid) ? paid : null} />;
}
