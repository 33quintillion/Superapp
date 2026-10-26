import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, cookieOpts, REFRESH_COOKIE, REFRESH_MAX_AGE } from './lib/cookies';

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

type Pair = { accessToken: string; refreshToken: string; expiresIn: number };
type Outcome = Pair | 'invalid' | 'transient';

/**
 * A page often fires several requests at once (link prefetches, client fetches) right
 * after the access cookie expires. They all carry the same refresh token, and the API
 * treats a second use of a rotated token as theft and ends the session. So concurrent
 * refreshes with one token share a single API call, and its answer is reused briefly.
 */
const SHARE_MS = 30_000;
const recent = new Map<string, { at: number; outcome: Promise<Outcome> }>();

function refreshOnce(refreshToken: string): Promise<Outcome> {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > SHARE_MS) recent.delete(k);
  const hit = recent.get(refreshToken);
  if (hit) return hit.outcome;
  const outcome = (async (): Promise<Outcome> => {
    try {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        cache: 'no-store',
      });
      if (res.ok) return (await res.json()) as Pair;
      return res.status === 401 ? 'invalid' : 'transient';
    } catch {
      return 'transient';
    }
  })();
  recent.set(refreshToken, { at: now, outcome });
  // Transient failures are not shared, so the next request tries again.
  void outcome.then((o) => o === 'transient' && recent.delete(refreshToken));
  return outcome;
}

/**
 * When the short-lived access cookie has expired but a refresh cookie exists, rotate
 * the refresh token once here so pages and server actions always see a fresh token.
 */
export async function middleware(req: NextRequest) {
  if (req.cookies.get(ACCESS_COOKIE) || !req.cookies.get(REFRESH_COOKIE)) return NextResponse.next();

  const outcome = await refreshOnce(req.cookies.get(REFRESH_COOKIE)!.value);
  if (outcome === 'transient') return NextResponse.next(); // keep the cookie, try next request
  const pair = outcome === 'invalid' ? null : outcome;

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
