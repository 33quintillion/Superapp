import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { PushProviders } from './push.providers';
import { inQuietHours, PushService } from './push.service';
import { PushDevice, PushMessage, PushProviderName, PushResult } from './push.types';

/** How long a claimed job stays invisible to other workers. Longer than any single send. */
const CLAIM_SECONDS = 60;
const BATCH = 50;
const RETRY_BASE_MS = 10_000;
const RETRY_CAP_MS = 30 * 60_000;
const PRUNE_EVERY_MS = 60_000;
/** Finished jobs are kept this long for troubleshooting, then deleted. */
const KEEP_FINISHED_DAYS = 7;

const KIND_LABEL: Record<string, string> = { image: 'Photo', video: 'Video', audio: 'Audio', voice: 'Voice message', file: 'File' };

interface JobRow {
  id: string;
  kind: 'message' | 'test' | 'clear';
  attempts: number;
  age_seconds: number;
  user_id: string;
  device_id: string;
  provider: PushProviderName;
  token: string;
  webpush_p256dh: string | null;
  webpush_auth: string | null;
  apns_environment: 'sandbox' | 'production' | null;
  device_disabled: boolean;
  session_live: boolean;
  user_active: boolean;
  push_enabled: boolean | null;
  preview: 'full' | 'sender' | 'none' | null;
  quiet_start: number | null;
  quiet_end: number | null;
  time_zone: string | null;
  message_id: string | null;
  conversation_id: string | null;
  clear_seq: string | null;
  conversation_kind: string | null;
  conversation_title: string | null;
  seq: string | null;
  message_kind: string | null;
  body: string | null;
  system_event: { type?: string; media?: string } | null;
  deleted: boolean | null;
  sender_name: string | null;
  is_member: boolean;
  last_read_seq: string | null;
  muted: boolean;
  blocked: boolean;
  hidden: boolean;
}

export type Outcome = 'sent' | 'retry' | 'failed' | 'dropped';

/**
 * Delivers queued notifications. Every API instance can run one: jobs are claimed with
 * FOR UPDATE SKIP LOCKED plus a lease, so two workers never send the same job, and a job
 * claimed by a worker that crashed is picked up again once its lease runs out.
 */
@Injectable()
export class PushWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PushWorker');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private again = false;
  private stopped = false;
  private lastPrune = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: PushProviders,
    private readonly push: PushService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.PUSH_WORKER_ENABLED) return;
    this.unsubscribe = this.push.onKick(() => this.wake());
    this.schedule(0);
  }

  async onModuleDestroy() {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
    this.timer.unref();
  }

  private wake() {
    if (this.running) this.again = true;
    else this.schedule(0);
  }

  private async tick() {
    this.timer = null;
    let busy = false;
    this.running = (async () => {
      try {
        busy = (await this.runOnce()).claimed === BATCH;
      } catch (err) {
        this.logger.warn(`push tick failed: ${(err as Error).message}`);
      }
    })();
    await this.running;
    this.running = null;
    const soon = busy || this.again;
    this.again = false;
    this.schedule(soon ? 0 : this.config.PUSH_WORKER_INTERVAL_MS);
  }

  /** Claims and processes one batch of due jobs. Exposed for tests and operational scripts. */
  async runOnce(): Promise<{ claimed: number; outcomes: Record<Outcome, number> }> {
    const outcomes: Record<Outcome, number> = { sent: 0, retry: 0, failed: 0, dropped: 0 };
    if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) await this.prune();
    const { rows: claimed } = await this.db.query<{ id: string }>(
      `UPDATE push_jobs SET locked_until = now() + make_interval(secs => $2), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM push_jobs
           WHERE state = 'pending' AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())
           ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [BATCH, CLAIM_SECONDS],
    );
    if (!claimed.length) return { claimed: 0, outcomes };
    const jobs = await this.load(claimed.map((r) => r.id));
    const badges = await this.badges([...new Set(jobs.map((j) => j.user_id))]);
    await Promise.all(
      jobs.map(async (job) => {
        let outcome: Outcome;
        try {
          outcome = await this.process(job, badges.get(job.user_id) ?? 0);
        } catch (err) {
          outcome = await this.finish(job, { ok: false, retryable: true, reason: `internal: ${(err as Error).message}` });
        }
        outcomes[outcome] += 1;
      }),
    );
    return { claimed: claimed.length, outcomes };
  }

  /** Removes registrations of signed-out sessions and old finished jobs. */
  async prune() {
    this.lastPrune = Date.now();
    await this.db.query(
      `DELETE FROM push_devices d USING sessions s WHERE s.id = d.session_id AND (s.revoked_at IS NOT NULL OR s.expires_at <= now())`,
    );
    await this.db.query(`DELETE FROM push_jobs WHERE state <> 'pending' AND finished_at < now() - make_interval(days => $1)`, [KEEP_FINISHED_DAYS]);
  }

  private async process(job: JobRow, badge: number): Promise<Outcome> {
    const drop = this.dropReason(job);
    if (drop) return this.close(job, 'dropped', drop);
    if (job.attempts > this.config.PUSH_MAX_ATTEMPTS) return this.close(job, 'failed', 'gave up after retries');
    const provider = this.providers.get(job.provider);
    if (!provider) return this.close(job, 'dropped', 'provider not configured');
    const device: PushDevice = {
      id: job.device_id,
      provider: job.provider,
      token: job.token,
      webpushP256dh: job.webpush_p256dh,
      webpushAuth: job.webpush_auth,
      apnsEnvironment: job.apns_environment,
    };
    const result = await provider.send(device, this.render(job, badge));
    return this.finish(job, result);
  }

  /** Why this notification should not be sent any more, if it shouldn't. */
  private dropReason(job: JobRow): string | null {
    if (job.age_seconds > this.config.PUSH_TTL_SECONDS) return 'expired';
    if (!job.session_live) return 'signed out';
    if (job.device_disabled) return 'device disabled';
    if (!job.user_active) return 'account not active';
    if (job.kind === 'test' || job.kind === 'clear') return null;
    if (job.push_enabled === false) return 'push turned off';
    if (!job.message_id || job.deleted) return 'message deleted';
    if (!job.is_member) return 'left conversation';
    if (job.hidden) return 'message hidden';
    if (Number(job.last_read_seq) >= Number(job.seq)) return 'already read';
    if (job.muted) return 'conversation muted';
    if (job.blocked) return 'blocked';
    return null;
  }

  private render(job: JobRow, badge: number): PushMessage {
    const silent = inQuietHours(job.quiet_start, job.quiet_end, job.time_zone ?? 'UTC');
    const ttlSeconds = Math.max(60, this.config.PUSH_TTL_SECONDS - job.age_seconds);
    if (job.kind === 'test') {
      return { title: 'Nexa', body: 'Notifications are working on this device.', threadId: 'test', silent, badge, data: { type: 'test' }, ttlSeconds };
    }
    if (job.kind === 'clear') {
      const data = { type: 'clear', conversationId: job.conversation_id!, seq: String(job.clear_seq) };
      return { title: '', body: '', threadId: job.conversation_id!, silent: true, badge, data, ttlSeconds, clear: true };
    }
    const sender = job.sender_name || 'Deleted account';
    if (job.message_kind === 'system' && job.system_event?.type === 'call') {
      // Missed calls: always say what it was, so the person knows to call back.
      const data = { type: 'missed_call', conversationId: job.conversation_id!, messageId: job.message_id!, seq: String(job.seq) };
      const what = job.system_event.media === 'video' ? 'Missed video call' : 'Missed voice call';
      return { title: job.preview === 'none' ? 'Nexa' : sender, body: job.preview === 'none' ? 'Missed call' : what, threadId: job.conversation_id!, silent, badge, data, ttlSeconds };
    }
    const data = { type: 'message', conversationId: job.conversation_id!, messageId: job.message_id!, seq: String(job.seq) };
    const group = job.conversation_kind === 'group';
    let title = 'Nexa';
    let body = 'New message';
    if (job.preview === 'full' || job.preview === null) {
      const label = KIND_LABEL[job.message_kind ?? ''];
      const text = truncate(job.body ?? '', 180);
      body = label ? (text ? `${label}: ${text}` : label) : text || 'New message';
      title = group ? job.conversation_title || 'Group' : sender;
      if (group) body = `${sender}: ${body}`;
    } else if (job.preview === 'sender') {
      title = group ? job.conversation_title || 'Group' : sender;
      if (group) body = `${sender}: New message`;
    }
    return { title, body, threadId: job.conversation_id!, silent, badge, data, ttlSeconds };
  }

  private async finish(job: JobRow, result: PushResult): Promise<Outcome> {
    if (result.ok) {
      await this.db.query(`UPDATE push_jobs SET state = 'sent', finished_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1`, [job.id]);
      await this.db.query('UPDATE push_devices SET last_success_at = now() WHERE id = $1', [job.device_id]);
      return 'sent';
    }
    if (result.invalidToken) {
      await this.db.query(
        `UPDATE push_devices SET disabled_at = now(), disabled_reason = $2 WHERE id = $1 AND disabled_at IS NULL`,
        [job.device_id, result.reason.slice(0, 200)],
      );
      return this.close(job, 'failed', `token rejected: ${result.reason}`);
    }
    if (!result.retryable) return this.close(job, 'failed', result.reason);
    if (job.attempts >= this.config.PUSH_MAX_ATTEMPTS) return this.close(job, 'failed', `gave up after ${job.attempts} attempts: ${result.reason}`);
    const delay = result.retryAfterMs ?? backoff(job.attempts);
    await this.db.query(
      `UPDATE push_jobs SET run_at = now() + make_interval(secs => $2), locked_until = NULL, last_error = $3 WHERE id = $1`,
      [job.id, delay / 1000, result.reason.slice(0, 300)],
    );
    return 'retry';
  }

  private async close(job: JobRow, state: 'failed' | 'dropped', reason: string): Promise<Outcome> {
    await this.db.query(`UPDATE push_jobs SET state = $2, finished_at = now(), locked_until = NULL, last_error = $3 WHERE id = $1`, [
      job.id,
      state,
      reason.slice(0, 300),
    ]);
    return state;
  }

  private async load(ids: string[]): Promise<JobRow[]> {
    const { rows } = await this.db.query<JobRow>(
      `SELECT j.id, j.kind, j.attempts, extract(epoch FROM now() - j.created_at)::int AS age_seconds, j.user_id,
              d.id AS device_id, d.provider, d.token, d.webpush_p256dh, d.webpush_auth, d.apns_environment,
              d.disabled_at IS NOT NULL AS device_disabled,
              (s.revoked_at IS NULL AND s.expires_at > now()) AS session_live,
              u.state = 'active' AS user_active,
              ns.push_enabled, ns.preview, ns.quiet_start, ns.quiet_end, ns.time_zone,
              m.id AS message_id, c.id AS conversation_id, j.clear_seq, c.kind AS conversation_kind, c.title AS conversation_title,
              m.seq, m.kind AS message_kind, m.body, m.system_event, m.deleted_at IS NOT NULL AS deleted,
              sender.display_name AS sender_name,
              cm.user_id IS NOT NULL AS is_member, cm.last_read_seq,
              COALESCE(cm.muted_until > now(), false) AS muted,
              EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = j.user_id AND b.blocked_id = m.sender_id)
                                                OR (b.blocker_id = m.sender_id AND b.blocked_id = j.user_id)) AS blocked,
              EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = j.user_id) AS hidden
         FROM push_jobs j
         JOIN push_devices d ON d.id = j.device_id
         JOIN sessions s ON s.id = d.session_id
         JOIN users u ON u.id = j.user_id
         LEFT JOIN notification_settings ns ON ns.user_id = j.user_id
         LEFT JOIN messages m ON m.id = j.message_id
         LEFT JOIN conversations c ON c.id = COALESCE(m.conversation_id, j.conversation_id)
         LEFT JOIN users sender ON sender.id = m.sender_id
         LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = j.user_id
        WHERE j.id = ANY($1::bigint[])`,
      [ids],
    );
    return rows;
  }

  /** Unread messages across unmuted chats, as the app icon badge. Capped to keep it cheap. */
  private async badges(userIds: string[]): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ user_id: string; n: number }>(
      `SELECT u.id AS user_id, (
         SELECT count(*)::int FROM (
           SELECT 1 FROM conversation_members cm
             JOIN messages m ON m.conversation_id = cm.conversation_id AND m.seq > cm.last_read_seq
            WHERE cm.user_id = u.id AND m.sender_id <> u.id AND m.deleted_at IS NULL
              AND (cm.muted_until IS NULL OR cm.muted_until <= now())
              AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = u.id)
            LIMIT 999) x) AS n
         FROM unnest($1::uuid[]) AS u(id)`,
      [userIds],
    );
    return new Map(rows.map((r) => [r.user_id, r.n]));
  }
}

/** Exponential backoff with ±20% jitter so retries from an outage don't arrive in lockstep. */
export function backoff(attempt: number): number {
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function truncate(s: string, n: number) {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
}
