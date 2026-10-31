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
 * Content Security Policy with a fresh nonce per request. Next.js reads the nonce from the
 * request's header and puts it on its own scripts, so only scripts this app rendered run:
 * an injected <script> or inline handler is refused even if some text slips past React.
 */
export function contentSecurityPolicy(nonce: string, env: Record<string, string | undefined> = process.env) {
  const dev = env.NODE_ENV !== 'production';
  // Browsers upload to and download from object storage directly, with presigned URLs.
  const media = (env.CSP_MEDIA_ORIGINS ?? (dev ? 'http://localhost:9000 http://127.0.0.1:9000' : '')).split(/[\s,]+/).filter(Boolean).join(' ');
  const ws = env.API_PUBLIC_WS_URL ?? 'ws://localhost:3000';
  // Phone sign-in: the browser asks Firebase (Identity Toolkit) to text a code, behind an
  // invisible reCAPTCHA whose script the nonced sign-in script loads ('strict-dynamic').
  const firebase = env.FIREBASE_WEB_API_KEY ? new URL(env.FIREBASE_AUTH_BASE ?? 'https://identitytoolkit.googleapis.com').origin : '';
  const recaptchaFrames = env.FIREBASE_WEB_API_KEY ? 'https://www.google.com https://recaptcha.google.com' : '';
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next's nonced loader pull in its chunks; dev mode also needs eval for fast refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React sets style attributes (progress bars, video tiles), which CSP counts as inline styles.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${media}`.trim(),
    `media-src 'self' blob: ${media}`.trim(),
    `connect-src 'self' ${ws} ${media} ${firebase}`.trim().replace(/ +/g, ' '),
    `frame-src 'self' ${recaptchaFrames}`.trim(),
    "font-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * When the short-lived access cookie has expired but a refresh cookie exists, rotate
 * the refresh token once here so pages and server actions always see a fresh token.
 * Every response also gets the Content Security Policy.
 */
export async function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set('content-security-policy', csp);
  const next = () => {
    const res = NextResponse.next({ request: { headers } });
    res.headers.set('content-security-policy', csp);
    return res;
  };

  if (req.cookies.get(ACCESS_COOKIE) || !req.cookies.get(REFRESH_COOKIE)) return next();

  const outcome = await refreshOnce(req.cookies.get(REFRESH_COOKIE)!.value);
  if (outcome === 'transient') return next(); // keep the cookie, try next request
  const pair = outcome === 'invalid' ? null : outcome;

  if (!pair) {
    const res = next();
    res.cookies.delete(REFRESH_COOKIE);
    return res;
  }
  // Forward the new token to this request's handlers and persist both cookies.
  req.cookies.set(ACCESS_COOKIE, pair.accessToken);
  req.cookies.set(REFRESH_COOKIE, pair.refreshToken);
  headers.set('cookie', req.cookies.toString());
  const res = next();
  res.cookies.set(ACCESS_COOKIE, pair.accessToken, cookieOpts(pair.expiresIn - 30));
  res.cookies.set(REFRESH_COOKIE, pair.refreshToken, cookieOpts(REFRESH_MAX_AGE));
  return res;
}

export const config = { matcher: ['/((?!_next/|favicon.ico).*)'] };
