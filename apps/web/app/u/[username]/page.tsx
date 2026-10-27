import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { authed } from '@/lib/session';
import type { Profile } from '@/lib/social-client';
import { ProfileView } from './profile-view';

export const dynamic = 'force-dynamic';

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const me = await authed<{ id: string }>('GET', '/v1/me');
  let profile: Profile;
  try {
    profile = await authed<Profile>('GET', `/v1/users/${encodeURIComponent(username.toLowerCase())}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  return <ProfileView me={me.id} initial={profile} />;
}
