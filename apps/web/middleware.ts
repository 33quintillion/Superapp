import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, cookieOpts, REFRESH_COOKIE, REFRESH_MAX_AGE } from './lib/cookies';

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

/**
 * When the short-lived access cookie has expired but a refresh cookie exists, rotate
 * the refresh token once here so pages and server actions always see a fresh token.
 */
export async function middleware(req: NextRequest) {
  if (req.cookies.get(ACCESS_COOKIE) || !req.cookies.get(REFRESH_COOKIE)) return NextResponse.next();

  let pair: { accessToken: string; refreshToken: string; expiresIn: number } | null = null;
  try {
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: req.cookies.get(REFRESH_COOKIE)!.value }),
      cache: 'no-store',
    });
    if (res.ok) pair = await res.json();
    else if (res.status !== 401) return NextResponse.next(); // transient: keep the cookie, try next request
  } catch {
    return NextResponse.next();
  }

  if (!pair) {
    const res = NextResponse.next();
    res.cookies.delete(REFRESH_COOKIE);
    return res;
  }
  // Forward the new token to this request's handlers and persist both cookies.
  req.cookies.set(ACCESS_COOKIE, pair.accessToken);
  req.cookies.set(REFRESH_COOKIE, pair.refreshToken);
  const headers = new Headers(req.headers);
  headers.set('cookie', req.cookies.toString());
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(ACCESS_COOKIE, pair.accessToken, cookieOpts(pair.expiresIn - 30));
  res.cookies.set(REFRESH_COOKIE, pair.refreshToken, cookieOpts(REFRESH_MAX_AGE));
  return res;
}

export const config = { matcher: ['/((?!_next/|favicon.ico).*)'] };
