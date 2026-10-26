import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError, TokenPair } from './api';
import { ACCESS_COOKIE, cookieOpts, MFA_COOKIE, REFRESH_COOKIE, REFRESH_MAX_AGE } from './cookies';

export async function storeTokens(pair: TokenPair) {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, pair.accessToken, cookieOpts(pair.expiresIn - 30));
  jar.set(REFRESH_COOKIE, pair.refreshToken, cookieOpts(REFRESH_MAX_AGE));
  jar.delete(MFA_COOKIE);
}

export async function clearTokens() {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
  jar.delete(MFA_COOKIE);
}

/** Access token for server components; middleware has already refreshed it if it expired. */
export async function requireAccessToken(): Promise<string> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect('/sign-in');
  return token;
}

/** Calls the API as the signed-in user, sending them to sign-in if the session ended. */
export async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  const accessToken = await requireAccessToken();
  try {
    return await api<T>(method, path, { accessToken, body });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/sign-in?expired=1');
    throw e;
  }
}
