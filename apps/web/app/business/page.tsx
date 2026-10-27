import { authed } from '@/lib/session';
import type { Business } from '@/lib/business-client';
import { BusinessHome } from './business-home';

export const dynamic = 'force-dynamic';

export default async function BusinessPage() {
  const mine = await authed<{ businesses: Business[] }>('GET', '/v1/me/businesses');
  return <BusinessHome mine={mine.businesses} />;
}
