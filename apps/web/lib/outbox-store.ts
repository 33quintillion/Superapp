import type { Media, Message } from './chat-client';

/** A message sent but not yet stored by the server. */
export interface OutboxEntry {
  conversationId: string;
  /** Kept across reloads, so the server stores a re-sent message once. */
  clientId: string;
  kind: Message['kind'];
  body: string;
  mediaId?: string;
  replyToId?: string;
  /** The uploaded photo or file, to show while it is sending. */
  media?: Media | null;
  createdAt: string;
}

const PREFIX = 'nexa.outbox.';

/**
 * Unsent messages kept in this browser so they survive a reload or the tab closing, per
 * account. Storage can be unavailable (private windows, blocked site data); then they are
 * kept in memory only, as before.
 */
export function loadOutbox(userId: string): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(PREFIX + userId);
    return raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveOutbox(userId: string, entries: OutboxEntry[]) {
  try {
    if (entries.length) localStorage.setItem(PREFIX + userId, JSON.stringify(entries));
    else localStorage.removeItem(PREFIX + userId);
  } catch {
    // See above: memory only.
  }
}

/** On sign-out: unsent messages are private and don't stay in the browser. */
export function clearOutboxes() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch {
    // Nothing stored.
  }
}
