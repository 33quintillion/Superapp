import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { authed } from '@/lib/session';
import type { Business } from '@/lib/business-client';
import { ManageBusiness } from './manage';

export const dynamic = 'force-dynamic';

export default async function ManagePage({ params }: { params: Promise<{ handle: string }> }) {
  const ref = encodeURIComponent((await params).handle.toLowerCase());
  let b: Business;
  try {
    b = await authed<Business>('GET', `/v1/businesses/${ref}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  // The back office is only for the business's own staff.
  if (!b.myRole) notFound();
  const me = await authed<{ id: string }>('GET', '/v1/me');
  return <ManageBusiness initial={b} me={me.id} />;
}
