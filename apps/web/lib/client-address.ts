/**
 * The browser's address. Each proxy appends the address it was connected from, so only the
 * entries proxies added can be believed: the first ones are whatever the client sent. With
 * WEB_PROXY_HOPS proxies in front of this server, the client is that many entries from the end.
 * With none, Next.js fills the header from the socket when the client sent nothing.
 */
export function clientAddress(xff: string | null, hops = Number(process.env.WEB_PROXY_HOPS ?? 0)): string | null {
  const entries = (xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return entries[entries.length - Math.max(1, hops)] ?? null;
}
