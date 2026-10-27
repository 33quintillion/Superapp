import { authed } from '@/lib/session';
import type { Integration } from '@/lib/business-client';
import { AppsCatalogue } from './apps-catalogue';

export const dynamic = 'force-dynamic';

export default async function AppsPage() {
  const [catalogue, connected] = await Promise.all([
    authed<{ integrations: Integration[] }>('GET', '/v1/integrations'),
    authed<{ integrations: Integration[] }>('GET', '/v1/me/integrations'),
  ]);
  return <AppsCatalogue catalogue={catalogue.integrations} connected={connected.integrations} />;
}
