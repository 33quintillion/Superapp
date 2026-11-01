import 'server-only';
import { headers } from 'next/headers';
import { clientAddress } from './client-address';

/**
 * Server-side calls to the SuperApp API. The browser never talks to the API directly and
 * never sees access or refresh tokens: they live in httpOnly cookies set by this app.
 */
const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  method: string,
  path: string,
  opts: { body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const reqHeaders: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) reqHeaders['content-type'] = 'application/json';
  if (opts.accessToken) reqHeaders.authorization = `Bearer ${opts.accessToken}`;
  // Pass the browser's address through so the API's per-IP rate limits see real clients,
  // not this server. The API only honours it when TRUST_PROXY is configured.
  const clientIp = await forwardedFor();
  if (clientIp) reqHeaders['x-forwarded-for'] = clientIp;
  // The browser's own name, so the device list (and a phone approving a link) says
  // "Chrome on Windows" rather than this server.
  const agent = await browserAgent();
  if (agent) reqHeaders['user-agent'] = agent;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: reqHeaders,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(503, 'api_unreachable', 'The service is unavailable right now. Please try again shortly.');
  }
  const text = await res.text();
  let data: { error?: { code?: string; message?: string } } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Not the API answering: on the free hosting plan this is the "starting up" page shown
    // while the API wakes from sleep, or a proxy error. Either way, worth trying again.
    throw new ApiError(res.ok ? 502 : Math.max(res.status, 500), 'api_unreachable', 'SuperApp is starting up. Try again in a moment.');
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? 'Request failed');
  }
  return data as T;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

async function forwardedFor(): Promise<string | null> {
  try {
    return clientAddress((await headers()).get('x-forwarded-for'));
  } catch {
    return null; // outside a request scope
  }
}

async function browserAgent(): Promise<string | null> {
  try {
    return (await headers()).get('user-agent')?.slice(0, 300) ?? null;
  } catch {
    return null; // outside a request scope
  }
}

/** Passes a request body through unchanged (used by the chat proxy). Returns the raw response. */
export async function forwardToApi(method: string, path: string, accessToken: string, body?: string) {
  const reqHeaders: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${accessToken}` };
  if (body) reqHeaders['content-type'] = 'application/json';
  const clientIp = await forwardedFor();
  if (clientIp) reqHeaders['x-forwarded-for'] = clientIp;
  try {
    const res = await fetch(`${API_URL}${path}`, { method, headers: reqHeaders, body: body || undefined, cache: 'no-store' });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 503, body: JSON.stringify({ error: { code: 'api_unreachable', message: 'The service is unavailable right now.' } }) };
  }
}
