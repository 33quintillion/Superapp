import { authed } from '@/lib/session';
import { FeedApp } from './feed-app';

export const dynamic = 'force-dynamic';

export default async function FeedPage() {
  const me = await authed<{ id: string; displayName: string }>('GET', '/v1/me');
  return <FeedApp me={me.id} />;
}
