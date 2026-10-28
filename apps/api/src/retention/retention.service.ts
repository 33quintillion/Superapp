import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';

/** Signed-out and expired sessions stay this long as security history ("where was I signed in?"). */
export const ENDED_SESSION_DAYS = 90;
/** Used or expired email, reset and two-step links. */
export const SPENT_TOKEN_DAYS = 7;
/** Uploads that were started but never finished. */
export const ABANDONED_UPLOAD_HOURS = 24;
const BATCH = 500;

/**
 * Deletes what is no longer needed, on a timer. Safe on several instances at once: every
 * step is an idempotent DELETE, and files are claimed by flipping their row first.
 *
 * Kept on purpose: the tombstone of a deleted account (id and state, no personal data),
 * so chats can show "Deleted account", and the tombstone of a message deleted for everyone
 * (id, sender, times, no text), so every device's copy of the chat stays in step.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Retention');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.RETENTION_SWEEP_INTERVAL_SECONDS;
    if (!every) return;
    this.timer = setInterval(() => this.sweep().catch((e) => this.logger.warn(`retention sweep failed: ${e.message}`)), every * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Returns how many of each were removed. */
  async sweep() {
    // Their retired refresh tokens and any push registration go with them (ON DELETE CASCADE).
    const sessions = await this.db.query(
      `DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1))
          OR (revoked_at IS NULL AND expires_at < now() - make_interval(days => $1))`,
      [ENDED_SESSION_DAYS],
    );
    const tokens = await this.db.query(
      `DELETE FROM one_time_tokens WHERE COALESCE(used_at, expires_at) < now() - make_interval(days => $1)`,
      [SPENT_TOKEN_DAYS],
    );
    let uploads = 0;
    for (;;) {
      const { rows } = await this.db.query<{ object_key: string }>(
        `UPDATE media SET state = 'deleted' WHERE id IN (
           SELECT id FROM media WHERE state = 'pending' AND created_at < now() - make_interval(hours => $1) LIMIT $2 FOR UPDATE SKIP LOCKED)
         RETURNING object_key`,
        [ABANDONED_UPLOAD_HOURS, BATCH],
      );
      // The file may never have arrived; deleting a missing object is not an error.
      for (const r of rows) await this.storage.delete(r.object_key).catch(() => undefined);
      uploads += rows.length;
      if (rows.length < BATCH) break;
    }
    const removed = { sessions: sessions.rowCount ?? 0, oneTimeTokens: tokens.rowCount ?? 0, abandonedUploads: uploads };
    if (removed.sessions || removed.oneTimeTokens || removed.abandonedUploads) this.logger.log(`removed ${JSON.stringify(removed)}`);
    return removed;
  }
}
