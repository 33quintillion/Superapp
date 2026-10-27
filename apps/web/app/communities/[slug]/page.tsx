import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { authed } from '@/lib/session';
import type { Community } from '@/lib/social-client';
import { CommunityView } from './community-view';

export const dynamic = 'force-dynamic';

export default async function CommunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const me = await authed<{ id: string }>('GET', '/v1/me');
  let community: Community;
  try {
    community = await authed<Community>('GET', `/v1/communities/${encodeURIComponent(slug.toLowerCase())}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  return <CommunityView me={me.id} initial={community} />;
}
