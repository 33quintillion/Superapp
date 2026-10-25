import 'server-only';
import { headers } from 'next/headers';

/**
 * Server-side calls to the Nexa API. The browser never talks to the API directly and
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
  const data = text ? JSON.parse(text) : undefined;
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
    const h = await headers();
    return h.get('x-forwarded-for')?.split(',')[0].trim() || h.get('x-real-ip') || null;
  } catch {
    return null; // outside a request scope
  }
}
