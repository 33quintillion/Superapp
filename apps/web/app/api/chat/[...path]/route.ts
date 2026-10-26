import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/cookies';
import { forwardToApi } from '@/lib/api';

/**
 * The chat and notification screens' only way to reach the API. It attaches the access
 * token from the httpOnly cookie, so browser code still never holds a token. Only the
 * messaging and notification endpoints below can be reached through it, and writes must
 * come from this site.
 */
const ALLOWED: [string, RegExp][] = [
  ['GET', /^conversations(\/[0-9a-f-]{36}(\/(messages|changes|pins))?)?$/],
  ['POST', /^conversations\/direct$/],
  ['POST', /^conversations\/[0-9a-f-]{36}\/(messages|receipts)$/],
  ['PATCH', /^conversations\/[0-9a-f-]{36}$/],
  ['PATCH', /^messages\/[0-9a-f-]{36}$/],
  ['DELETE', /^messages\/[0-9a-f-]{36}$/],
  ['POST', /^messages\/[0-9a-f-]{36}\/(hide|forward)$/],
  ['PUT', /^messages\/[0-9a-f-]{36}\/(reaction|pin)$/],
  ['GET', /^messages\/search$/],
  ['POST', /^media\/uploads$/],
  ['POST', /^media\/[0-9a-f-]{36}\/complete$/],
  ['GET', /^media\/[0-9a-f-]{36}$/],
  ['GET', /^presence$/],
  ['POST', /^realtime\/tickets$/],
  ['GET', /^users\/[a-z0-9_]{3,30}$/],
  // Notifications: settings and this browser's push subscription.
  ['GET', /^push\/(config|devices)$/],
  ['PUT', /^push\/devices\/current$/],
  ['DELETE', /^push\/devices\/current$/],
  ['POST', /^push\/devices\/current\/test$/],
  ['GET', /^me\/notifications$/],
  ['PATCH', /^me\/notifications$/],
];

async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (!ALLOWED.some(([m, re]) => m === req.method && re.test(path))) {
    return NextResponse.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
  }
  if (req.method !== 'GET' && req.headers.get('sec-fetch-site') !== 'same-origin' && req.headers.get('origin') !== req.nextUrl.origin) {
    return NextResponse.json({ error: { code: 'forbidden', message: 'Cross-site request refused' } }, { status: 403 });
  }
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: { code: 'unauthorized', message: 'Sign in again' } }, { status: 401 });
  const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.text();
  const res = await forwardToApi(req.method, `/v1/${path}${req.nextUrl.search}`, token, body);
  return new NextResponse(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
