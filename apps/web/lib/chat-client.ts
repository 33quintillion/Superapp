// Browser-side chat plumbing. REST calls go through this app's /api/chat proxy (which
// holds the token); the WebSocket connects to the API with a one-time ticket.

export interface Media {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  contentType: string;
  byteSize: number;
  fileName: string;
  durationMs: number | null;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  changeSeq: number;
  senderId: string;
  clientId: string;
  kind: Media['kind'] | 'text';
  body: string | null;
  media: Media | null;
  replyTo: { id: string; senderId: string; preview: string; deleted: boolean } | null;
  forwarded: boolean;
  mentions: string[];
  reactions: { userId: string; emoji: string }[];
  editedAt: string | null;
  deletedAt: string | null;
  pinnedAt: string | null;
  createdAt: string;
  /** Local only: not yet acknowledged by the server. */
  pending?: 'sending' | 'failed';
}

export interface Member {
  userId: string;
  username: string | null;
  displayName: string;
  lastDeliveredSeq: number;
  lastReadSeq: number | null;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  lastSeq: number;
  lastMessage: Message | null;
  lastMessageAt: string | null;
  unreadCount: number;
  mutedUntil: string | null;
  archived: boolean;
  peerId: string | null;
  members: Member[];
}

export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function chatApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/chat/${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ChatApiError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? 'Request failed');
  return data as T;
}

export function newClientId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Uploads a file straight to storage with the presigned URL, then asks the API to verify it. */
export async function uploadMedia(file: Blob, meta: { kind: Media['kind']; fileName: string; durationMs?: number }): Promise<Media> {
  const created = await chatApi<{ media: Media; upload: { url: string; method: string; headers: Record<string, string> } }>('POST', 'media/uploads', {
    kind: meta.kind,
    contentType: file.type,
    byteSize: file.size,
    fileName: meta.fileName,
    durationMs: meta.durationMs,
  });
  const put = await fetch(created.upload.url, { method: created.upload.method, headers: created.upload.headers, body: file });
  if (!put.ok) throw new ChatApiError(put.status, 'upload_failed', 'The upload did not go through');
  return chatApi<Media>('POST', `media/${created.media.id}/complete`);
}

export function kindForFile(type: string): Media['kind'] {
  if (/^image\/(jpeg|png|gif|webp|heic)$/.test(type)) return 'image';
  if (/^video\//.test(type)) return 'video';
  if (/^audio\//.test(type)) return 'audio';
  return 'file';
}

type Frame = { type: string; ref?: string; data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Outgoing {
  conversationId: string;
  message: Record<string, unknown>;
  resolve: (m: { message: Message; duplicate: boolean }) => void;
  reject: (e: Error) => void;
}

export type ConnectionState = 'connecting' | 'online' | 'offline';

/**
 * Keeps one WebSocket open, reconnecting with backoff. Sends wait in an outbox keyed by
 * clientId until acknowledged, and are re-sent after every reconnect; the server
 * deduplicates on clientId, so a resend after a lost ack never creates a second message.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private readonly outbox = new Map<string, Outgoing>();

  constructor(
    private readonly wsBase: string,
    private readonly onEvent: (f: Frame) => void,
    private readonly onState: (s: ConnectionState) => void,
    /** Called after every (re)connect so the screen can fetch anything it missed. */
    private readonly onReady: () => void,
  ) {}

  start() {
    this.stopped = false;
    void this.connect();
    window.addEventListener('online', this.kick);
    window.addEventListener('offline', this.drop);
    // A dead network often leaves a socket that looks open; an unanswered ping exposes it.
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > 45_000) return this.drop();
      this.ws.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.kick);
    window.removeEventListener('offline', this.drop);
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  /** Gives up on the current socket at once (its close handshake may never finish offline). */
  private readonly drop = () => {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.close();
    this.onState('offline');
    if (this.timer) clearTimeout(this.timer);
    this.retry();
  };

  private readonly kick = () => {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.timer) clearTimeout(this.timer);
    this.attempt = 0;
    void this.connect();
  };

  private async connect() {
    if (this.stopped) return;
    this.onState('connecting');
    let ticket: { ticket: string; path: string };
    try {
      ticket = await chatApi('POST', 'realtime/tickets');
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 401) {
        window.location.href = '/sign-in?expired=1';
        return;
      }
      return this.retry();
    }
    if (this.stopped) return;
    const ws = new WebSocket(`${this.wsBase}${ticket.path}?ticket=${encodeURIComponent(ticket.ticket)}`);
    this.ws = ws;
    this.lastPong = Date.now();
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as Frame;
      this.lastPong = Date.now();
      if (f.type === 'pong') return;
      if (f.type === 'ready') {
        this.attempt = 0;
        this.onState('online');
        for (const [clientId, o] of this.outbox) this.transmit(clientId, o);
        this.onReady();
      } else if (f.type === 'ack' && f.ref && this.outbox.has(f.ref)) {
        this.outbox.get(f.ref)!.resolve(f.data);
        this.outbox.delete(f.ref);
      } else if (f.type === 'error' && f.ref && this.outbox.has(f.ref)) {
        // Rate limits and outages are worth retrying; anything else is final.
        if (f.error?.code === 'rate_limited' || f.error?.code === 'internal_error') return;
        this.outbox.get(f.ref)!.reject(new ChatApiError(400, f.error?.code ?? 'error', f.error?.message ?? 'Not sent'));
        this.outbox.delete(f.ref);
      } else {
        this.onEvent(f);
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.onState('offline');
      this.retry();
    };
  }

  private retry() {
    if (this.stopped) return;
    const delay = Math.min(15_000, 500 * 2 ** this.attempt) * (0.75 + Math.random() / 2);
    this.attempt += 1;
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private transmit(clientId: string, o: Outgoing) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'send', ref: clientId, conversationId: o.conversationId, message: o.message }));
  }

  send(conversationId: string, message: Record<string, unknown> & { clientId: string }) {
    return new Promise<{ message: Message; duplicate: boolean }>((resolve, reject) => {
      const o = { conversationId, message, resolve, reject };
      this.outbox.set(message.clientId, o);
      this.transmit(message.clientId, o);
    });
  }

  frame(f: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }

  get pendingCount() {
    return this.outbox.size;
  }
}
