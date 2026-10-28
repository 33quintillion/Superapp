export type PushProviderName = 'apns' | 'fcm' | 'webpush';

export interface PushDevice {
  id: string;
  provider: PushProviderName;
  token: string;
  webpushP256dh: string | null;
  webpushAuth: string | null;
  apnsEnvironment: 'sandbox' | 'production' | null;
}

/** What a notification says, already filtered by the recipient's preview setting. */
export interface PushMessage {
  title: string;
  body: string;
  /** Groups notifications per chat (APNs thread-id, Android tag, Web Push tag/Topic). */
  threadId: string;
  /** Quiet hours: show it, but without sound or vibration. */
  silent: boolean;
  /** App icon badge: unread messages across all chats. */
  badge: number;
  /** Small string map for the app to open the right screen. Never contains message text. */
  data: Record<string, string>;
  /** Seconds the push service should keep trying if the device is offline. */
  ttlSeconds: number;
  /**
   * Shows nothing: tells the device to remove its notifications for [threadId] up to
   * data.seq (read on another device) and to update the badge.
   */
  clear?: boolean;
}

export type PushResult =
  | { ok: true }
  | {
      ok: false;
      /** Provider's error, for logs and the job record. Never includes payload text. */
      reason: string;
      /** The token or subscription is gone for good: disable the device. */
      invalidToken?: boolean;
      /** Worth retrying later (rate limits, outages, network errors). */
      retryable?: boolean;
      retryAfterMs?: number;
    };

export interface PushProvider {
  readonly name: PushProviderName;
  send(device: PushDevice, message: PushMessage): Promise<PushResult>;
  close?(): Promise<void>;
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(header: string | string[] | null | undefined): number | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export function networkFailure(err: unknown): PushResult {
  return { ok: false, retryable: true, reason: `network: ${(err as Error).message ?? String(err)}`.slice(0, 300) };
}
