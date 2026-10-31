// Service worker for browser notifications. The payload arrives encrypted end to end
// from the SuperApp API (Web Push, RFC 8291); the browser decrypts it before this runs.

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
  if (data.type === 'clear') return clearRead(data, n.badge);
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
  await self.registration.showNotification(n.title || 'SuperApp', {
    body: n.body || '',
    tag: n.tag,
    renotify: !!n.tag,
    silent: !!n.silent,
    data,
  });
  if ('setAppBadge' in self.navigator && typeof n.badge === 'number') self.navigator.setAppBadge(n.badge).catch(() => undefined);
}

// Read on another device: take this chat's notification away here too, if it only covers
// messages up to what was read. Browsers expect a push to show something; Chrome tolerates
// the occasional one that doesn't, and clears are only sent where a notification was shown.
async function clearRead(data, badge) {
  const shown = await self.registration.getNotifications({ tag: data.conversationId });
  for (const n of shown) if (Number(n.data?.seq ?? 0) <= Number(data.seq)) n.close();
  if ('setAppBadge' in self.navigator && typeof badge === 'number') {
    await (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(() => undefined);
  }
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
