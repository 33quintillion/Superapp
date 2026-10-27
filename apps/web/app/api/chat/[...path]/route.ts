import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/cookies';
import { forwardToApi } from '@/lib/api';

/**
 * The browser screens' only way to reach the API. It attaches the access token from the
 * httpOnly cookie, so browser code still never holds a token. Only the messaging, social
 * notification, call, business, integration and admin endpoints below can be reached through
 * it (account export, deletion and security settings stay server-side), and writes must come
 * from this site. The admin endpoints still check platform staff and two-step in the API.
 */
const ID = '[0-9a-f-]{36}';
const HANDLE = '[a-z0-9][a-z0-9_-]{2,39}';
const REF = `(${ID}|${HANDLE})`;
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
  // Groups.
  ['POST', /^conversations\/groups$/],
  ['PATCH', new RegExp(`^conversations/${ID}/group$`)],
  ['POST', new RegExp(`^conversations/${ID}/members$`)],
  ['PATCH', new RegExp(`^conversations/${ID}/members/${ID}$`)],
  ['DELETE', new RegExp(`^conversations/${ID}/members/${ID}$`)],
  // Feed, posts and comments.
  ['GET', /^feed$/],
  ['POST', /^posts$/],
  ['GET', new RegExp(`^posts/${ID}(/(comments|likes))?$`)],
  ['PATCH', new RegExp(`^posts/${ID}$`)],
  ['DELETE', new RegExp(`^posts/${ID}$`)],
  ['PUT', new RegExp(`^posts/${ID}/like$`)],
  ['POST', new RegExp(`^posts/${ID}/(comments|moderation)$`)],
  ['DELETE', new RegExp(`^comments/${ID}$`)],
  // Stories.
  ['GET', new RegExp(`^stories(/${ID}(/views)?)?$`)],
  ['POST', /^stories$/],
  ['POST', new RegExp(`^stories/${ID}/views$`)],
  ['DELETE', new RegExp(`^stories/${ID}$`)],
  // People: following and the social privacy settings.
  ['GET', new RegExp(`^users/${ID}/(posts|stories|followers|following)$`)],
  ['POST', new RegExp(`^users/${ID}/follow$`)],
  ['DELETE', new RegExp(`^users/${ID}/follow$`)],
  ['GET', /^me\/follow-requests$/],
  ['POST', new RegExp(`^me/follow-requests/${ID}$`)],
  ['DELETE', new RegExp(`^me/followers/${ID}$`)],
  ['GET', /^me\/privacy$/],
  ['PATCH', /^me\/privacy$/],
  ['POST', /^reports$/],
  // Calls: history, TURN settings, and ending a call. Starting and answering happen on the WebSocket.
  ['GET', /^calls$/],
  ['GET', /^calls\/(ice-servers|active)$/],
  ['GET', new RegExp(`^calls/${ID}$`)],
  ['POST', new RegExp(`^calls/${ID}/(decline|hangup)$`)],
  // Communities and channels.
  ['GET', /^communities(\/[a-z0-9][a-z0-9_-]{2,39})?$/],
  ['POST', /^communities$/],
  ['PATCH', new RegExp(`^communities/${ID}$`)],
  ['DELETE', new RegExp(`^communities/${ID}$`)],
  ['POST', new RegExp(`^communities/${ID}/join$`)],
  ['DELETE', new RegExp(`^communities/${ID}/membership$`)],
  ['GET', new RegExp(`^communities/${ID}/(members|posts)$`)],
  ['PATCH', new RegExp(`^communities/${ID}/members/${ID}$`)],
  ['DELETE', new RegExp(`^communities/${ID}/members/${ID}$`)],
  // Businesses: profile, staff, catalogue, services and hours.
  ['GET', /^(businesses|me\/businesses)$/],
  ['POST', /^businesses$/],
  ['GET', new RegExp(`^businesses/${REF}(/(hours|items|services|staff|orders|bookings))?$`)],
  ['GET', new RegExp(`^businesses/${REF}/services/${ID}/slots$`)],
  ['PATCH', new RegExp(`^businesses/${ID}$`)],
  ['DELETE', new RegExp(`^businesses/${ID}$`)],
  ['PUT', new RegExp(`^businesses/${ID}/hours$`)],
  ['POST', new RegExp(`^businesses/${ID}/(staff|staff/accept|transfer|items|services)$`)],
  ['PATCH', new RegExp(`^businesses/${ID}/(staff|items|services)/${ID}$`)],
  ['DELETE', new RegExp(`^businesses/${ID}/(staff|items|services)/${ID}$`)],
  // Orders and bookings.
  ['POST', new RegExp(`^businesses/${REF}/(orders|bookings)$`)],
  ['GET', new RegExp(`^(orders|bookings)(/${ID})?$`)],
  ['POST', new RegExp(`^orders/${ID}/(cancel|status)$`)],
  ['POST', new RegExp(`^bookings/${ID}/(cancel|outcome)$`)],
  // Integration catalogue.
  ['GET', new RegExp(`^integrations(/${HANDLE})?$`)],
  ['PUT', new RegExp(`^integrations/${HANDLE}/connection$`)],
  ['DELETE', new RegExp(`^integrations/${HANDLE}/connection$`)],
  ['GET', /^me\/integrations$/],
  // Admin dashboard.
  ['GET', new RegExp(`^admin/(overview|reports|users|businesses|integrations|staff|audit)$`)],
  ['GET', new RegExp(`^admin/reports/${ID}$`)],
  ['POST', new RegExp(`^admin/reports/${ID}/(claim|resolve)$`)],
  ['POST', new RegExp(`^admin/users/${ID}/(suspend|unsuspend)$`)],
  ['POST', new RegExp(`^admin/businesses/${ID}/actions$`)],
  ['POST', /^admin\/(integrations|staff)$/],
  ['PATCH', new RegExp(`^admin/integrations/${ID}$`)],
  ['POST', new RegExp(`^admin/integrations/${ID}/state$`)],
  ['DELETE', new RegExp(`^admin/staff/${ID}$`)],
  // Payments, payouts and plans. Provider webhooks go straight to the API, never through here.
  ['GET', new RegExp(`^businesses/${ID}/(payments|payments/account|subscription)$`)],
  ['POST', new RegExp(`^businesses/${ID}/(payments/account|subscription|subscription/resume|billing-portal)$`)],
  ['DELETE', new RegExp(`^businesses/${ID}/subscription$`)],
  ['POST', new RegExp(`^orders/${ID}/(checkout|refunds)$`)],
  ['GET', new RegExp(`^orders/${ID}/payment$`)],
  ['GET', /^(me\/payments|plans)$/],
  ['GET', /^admin\/(payments|ledger|plans)$/],
  ['POST', /^admin\/plans$/],
  ['POST', new RegExp(`^admin/plans/${ID}/state$`)],
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
  // A 204 must not carry a body, not even an empty string.
  if (res.status === 204) return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  return new NextResponse(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
