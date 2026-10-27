import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { authed } from '@/lib/session';
import type { Business, Item, Service } from '@/lib/business-client';
import { Storefront } from './storefront';

export const dynamic = 'force-dynamic';

export default async function StorefrontPage({ params }: { params: Promise<{ handle: string }> }) {
  const ref = encodeURIComponent((await params).handle.toLowerCase());
  try {
    const [business, items, services, hours] = await Promise.all([
      authed<Business>('GET', `/v1/businesses/${ref}`),
      authed<{ items: Item[] }>('GET', `/v1/businesses/${ref}/items`),
      authed<{ services: Service[] }>('GET', `/v1/businesses/${ref}/services`),
      authed<{ hours: { weekday: number; opens: string; closes: string }[] }>('GET', `/v1/businesses/${ref}/hours`),
    ]);
    return <Storefront business={business} items={items.items} services={services.services} hours={hours.hours} />;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}
