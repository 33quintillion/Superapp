import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/cookies';

/** No public front page yet: signed-in people go to their chats, everyone else to sign-in. */
export default async function Home() {
  const jar = await cookies();
  redirect(jar.get(ACCESS_COOKIE) || jar.get(REFRESH_COOKIE) ? '/chats' : '/sign-in');
}
