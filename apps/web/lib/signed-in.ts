import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE } from './cookies';

/**
 * Sends people who are already signed in past the sign-in and sign-up screens. Not after
 * "session ended" (?expired=1): their cookie is still there but no longer works, and
 * redirecting would loop.
 */
export async function skipIfSignedIn(expired?: string) {
  if (!expired && (await cookies()).get(ACCESS_COOKIE)) redirect('/account');
}
