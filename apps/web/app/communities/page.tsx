import { authed } from '@/lib/session';
import type { Community } from '@/lib/social-client';
import { CommunitiesHome } from './communities-home';

export const dynamic = 'force-dynamic';

export default async function CommunitiesPage() {
  const mine = await authed<{ communities: Community[] }>('GET', '/v1/communities');
  return <CommunitiesHome mine={mine.communities} />;
}
