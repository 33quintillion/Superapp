import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { PushProviders } from './push.providers';
import { PushProviderName } from './push.types';

export type RegisterInput =
  | { provider: 'apns'; token: string; environment: 'sandbox' | 'production' }
  | { provider: 'fcm'; token: string }
  | { provider: 'webpush'; endpoint: string; keys: { p256dh: string; auth: string } };

export interface SettingsPatch {
  pushEnabled?: boolean;
  preview?: 'full' | 'sender' | 'none';
  quietHours?: { start: string; end: string; timeZone: string } | null;
}

interface DeviceRow {
  id: string;
  session_id: string;
  provider: PushProviderName;
  device_name: string;
  created_at: Date;
  updated_at: Date;
  last_success_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

interface SettingsRow {
  push_enabled: boolean;
  preview: 'full' | 'sender' | 'none';
  quiet_start: number | null;
  quiet_end: number | null;
  time_zone: string;
}

const DEFAULT_SETTINGS: SettingsRow = { push_enabled: true, preview: 'full', quiet_start: null, quiet_end: null, time_zone: 'UTC' };

/** Device registrations, notification settings, and putting notifications on the delivery queue. */
@Injectable()
export class PushService {
  private readonly wakers = new Set<() => void>();

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: PushProviders,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Which providers this server can deliver through, and the key browsers subscribe with. */
  status() {
    const on = new Set(this.providers.configured());
    return {
      providers: { apns: on.has('apns'), fcm: on.has('fcm'), webpush: on.has('webpush') },
      vapidPublicKey: this.providers.vapidPublicKey,
    };
  }

  // ---------------------------------------------------------------- devices

  /**
   * Registers (or replaces) the push target for the calling session. A token that was
   * registered by another session moves here: it now belongs to whoever is signed in on
   * that device, and the previous account must stop getting its notifications.
   */
  async registerCurrent(userId: string, sessionId: string, input: RegisterInput) {
    await this.limits.consume({ name: 'push:register', limit: 30, windowSeconds: 3600 }, userId);
    const token = input.provider === 'webpush' ? this.checkEndpoint(input.endpoint) : input.token;
    const p256dh = input.provider === 'webpush' ? input.keys.p256dh : null;
    const auth = input.provider === 'webpush' ? input.keys.auth : null;
    const env = input.provider === 'apns' ? input.environment : null;
    await this.db.tx(async (tx) => {
      await this.db.query('DELETE FROM push_devices WHERE provider = $1 AND token = $2 AND session_id <> $3', [input.provider, token, sessionId], tx);
      await this.db.query(
        `INSERT INTO push_devices (user_id, session_id, provider, token, webpush_p256dh, webpush_auth, apns_environment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (session_id) DO UPDATE SET provider = EXCLUDED.provider, token = EXCLUDED.token,
           webpush_p256dh = EXCLUDED.webpush_p256dh, webpush_auth = EXCLUDED.webpush_auth, apns_environment = EXCLUDED.apns_environment,
           disabled_at = NULL, disabled_reason = NULL, updated_at = now()`,
        [userId, sessionId, input.provider, token, p256dh, auth, env],
        tx,
      );
    });
    const devices = await this.list(userId, sessionId);
    return devices.find((d) => d.current)!;
  }

  async removeCurrent(userId: string, sessionId: string) {
    await this.db.query('DELETE FROM push_devices WHERE user_id = $1 AND session_id = $2', [userId, sessionId]);
  }

  async remove(userId: string, deviceId: string) {
    const res = await this.db.query('DELETE FROM push_devices WHERE id = $1 AND user_id = $2', [deviceId, userId]);
    if (res.rowCount === 0) throw Errors.notFound('Device');
  }

  /** The user's registered devices. Tokens are never returned. */
  async list(userId: string, currentSessionId: string) {
    const { rows } = await this.db.query<DeviceRow>(
      `SELECT d.id, d.session_id, d.provider, s.device_name, d.created_at, d.updated_at, d.last_success_at, d.disabled_at, d.disabled_reason
         FROM push_devices d JOIN sessions s ON s.id = d.session_id
        WHERE d.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        ORDER BY d.updated_at DESC`,
      [userId],
    );
    const live = new Set(this.providers.configured());
    return rows.map((d) => ({
      id: d.id,
      provider: d.provider,
      deviceName: d.device_name,
      current: d.session_id === currentSessionId,
      // False when this server has no credentials for the provider, or the token died.
      deliverable: live.has(d.provider) && !d.disabled_at,
      disabledReason: d.disabled_reason,
      lastDeliveredAt: d.last_success_at,
      registeredAt: d.created_at,
      updatedAt: d.updated_at,
    }));
  }

  /** Queues a test notification to the calling session's device. */
  async sendTest(userId: string, sessionId: string) {
    await this.limits.consume({ name: 'push:test', limit: 5, windowSeconds: 600 }, userId);
    const d = await this.db.one<{ id: string; provider: PushProviderName }>(
      'SELECT id, provider FROM push_devices WHERE user_id = $1 AND session_id = $2',
      [userId, sessionId],
    );
    if (!d) throw Errors.notFound('Push registration for this device');
    if (!this.providers.get(d.provider)) {
      throw Errors.conflict('push_not_configured', `This server has no ${d.provider.toUpperCase()} credentials yet, so it cannot send notifications to this device`);
    }
    const job = await this.db.one<{ id: string }>(`INSERT INTO push_jobs (device_id, user_id, kind) VALUES ($1, $2, 'test') RETURNING id`, [d.id, userId]);
    this.kick();
    return { jobId: job!.id };
  }

  // ---------------------------------------------------------------- settings

  async settings(userId: string) {
    const row = (await this.db.one<SettingsRow>('SELECT push_enabled, preview, quiet_start, quiet_end, time_zone FROM notification_settings WHERE user_id = $1', [userId])) ?? DEFAULT_SETTINGS;
    return settingsDto(row);
  }

  async updateSettings(userId: string, patch: SettingsPatch) {
    const cur = (await this.db.one<SettingsRow>('SELECT push_enabled, preview, quiet_start, quiet_end, time_zone FROM notification_settings WHERE user_id = $1', [userId])) ?? DEFAULT_SETTINGS;
    const next: SettingsRow = { ...cur };
    if (patch.pushEnabled !== undefined) next.push_enabled = patch.pushEnabled;
    if (patch.preview !== undefined) next.preview = patch.preview;
    if (patch.quietHours === null) {
      next.quiet_start = null;
      next.quiet_end = null;
    } else if (patch.quietHours) {
      next.quiet_start = toMinutes(patch.quietHours.start);
      next.quiet_end = toMinutes(patch.quietHours.end);
      next.time_zone = patch.quietHours.timeZone;
    }
    await this.db.query(
      `INSERT INTO notification_settings (user_id, push_enabled, preview, quiet_start, quiet_end, time_zone) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET push_enabled = $2, preview = $3, quiet_start = $4, quiet_end = $5, time_zone = $6, updated_at = now()`,
      [userId, next.push_enabled, next.preview, next.quiet_start, next.quiet_end, next.time_zone],
    );
    return settingsDto(next);
  }

  // ---------------------------------------------------------------- queue

  /**
   * Queues a notification of a new message for every other member's live devices, inside
   * the transaction that saves the message. Muted chats and people who switched push off
   * get nothing. Whether it is still worth sending (not read elsewhere, not deleted, not
   * blocked since) is decided again at delivery time.
   */
  async enqueueMessage(tx: Queryable, conversationId: string, messageId: string, senderId: string) {
    const providers = this.providers.configured();
    if (!providers.length) return 0;
    const res = await this.db.query(
      `INSERT INTO push_jobs (device_id, user_id, kind, message_id)
       SELECT d.id, d.user_id, 'message', $2 FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id AND u.state = 'active'
         JOIN push_devices d ON d.user_id = cm.user_id AND d.disabled_at IS NULL AND d.provider = ANY($4::text[])
         JOIN sessions s ON s.id = d.session_id AND s.revoked_at IS NULL AND s.expires_at > now()
         LEFT JOIN notification_settings ns ON ns.user_id = cm.user_id
        WHERE cm.conversation_id = $1 AND cm.user_id <> $3
          AND (cm.muted_until IS NULL OR cm.muted_until <= now())
          AND COALESCE(ns.push_enabled, true)
       ON CONFLICT DO NOTHING`,
      [conversationId, messageId, senderId, providers],
      tx,
    );
    return res.rowCount ?? 0;
  }

  /** Tells this instance's worker there is new work (call after the transaction commits). */
  kick() {
    for (const w of this.wakers) w();
  }

  onKick(fn: () => void) {
    this.wakers.add(fn);
    return () => this.wakers.delete(fn);
  }

  /**
   * Web Push endpoints are URLs the server will POST to, so only real browser push
   * services are accepted. Anything else could aim the API at internal hosts.
   */
  private checkEndpoint(endpoint: string): string {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw Errors.validation([{ path: 'endpoint', message: 'Must be a URL' }]);
    }
    const host = url.hostname.toLowerCase();
    const allowedHost = this.config.WEBPUSH_ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    const allowedScheme = url.protocol === 'https:' || (this.config.NODE_ENV === 'test' && url.protocol === 'http:');
    if (!allowedHost || !allowedScheme || url.username || url.password) {
      throw Errors.validation([{ path: 'endpoint', message: 'Not a recognised browser push service' }]);
    }
    return url.toString();
  }
}

function settingsDto(r: SettingsRow) {
  return {
    pushEnabled: r.push_enabled,
    preview: r.preview,
    quietHours: r.quiet_start === null || r.quiet_end === null ? null : { start: fromMinutes(r.quiet_start), end: fromMinutes(r.quiet_end), timeZone: r.time_zone },
  };
}

export function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

function fromMinutes(n: number) {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** Minutes after midnight in the given IANA time zone. */
export function localMinutes(timeZone: string, at = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/** Quiet hours may wrap past midnight (22:00 to 07:00). */
export function inQuietHours(start: number | null, end: number | null, timeZone: string, at = new Date()): boolean {
  if (start === null || end === null) return false;
  const now = localMinutes(timeZone, at);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
