// Service worker for browser notifications. The payload arrives encrypted end to end
// from the Nexa API (Web Push, RFC 8291); the browser decrypts it before this runs.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let n;
  try {
    n = event.data ? event.data.json() : null;
  } catch {
    n = null;
  }
  if (!n) return;
  event.waitUntil(handlePush(n));
});

async function handlePush(n) {
  const data = n.data || {};
  if (data.type === 'message') {
    // Delivered to this device: the sender sees two ticks even if nobody opens it yet.
    // Same-origin request, so the session cookie goes with it; no token lives here.
    fetch(`/api/chat/conversations/${encodeURIComponent(data.conversationId)}/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'delivered', seq: Number(data.seq) }),
    }).catch(() => undefined);
  }
  // The chat screen already shows new messages live; don't pop a notification over it.
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (data.type === 'message' && windows.some((w) => w.focused && new URL(w.url).pathname.startsWith('/chats'))) return;
  await self.registration.showNotification(n.title || 'Nexa', {
    body: n.body || '',
    tag: n.tag,
    renotify: !!n.tag,
    silent: !!n.silent,
    data,
  });
  if ('setAppBadge' in self.navigator && typeof n.badge === 'number') self.navigator.setAppBadge(n.badge).catch(() => undefined);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.conversationId ? `/chats?c=${encodeURIComponent(data.conversationId)}` : '/chats';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        return existing.navigate(target).catch(() => self.clients.openWindow(target));
      }
      return self.clients.openWindow(target);
    })(),
  );
});
