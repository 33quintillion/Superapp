import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { Errors } from '../common/errors';
import { DatabaseService } from '../database/database.service';
import { verifyPassword } from '../auth/password';
import { MediaService } from '../media/media.service';
import { GroupsService } from '../messaging/groups.service';
import { MessagingService } from '../messaging/messaging.service';
import { CommunitiesService } from '../social/communities.service';
import { FollowsService } from '../social/follows.service';
import { PostsService } from '../social/posts.service';
import { StoriesService } from '../social/stories.service';

interface UserRow {
  id: string;
  email: string | null;
  email_verified_at: Date | null;
  phone_e164: string | null;
  username: string | null;
  display_name: string;
  bio: string;
  status_text: string;
  avatar_object_key: string | null;
  locale: string;
  mfa_enabled_at: Date | null;
  created_at: Date;
}

export interface PrivacySettings {
  discoverableByEmail: boolean;
  discoverableByPhone: boolean;
  discoverableByUsername: boolean;
  whoCanMessage: 'everyone' | 'contacts' | 'nobody';
  showOnlineStatus: boolean;
  showReadReceipts: boolean;
  privateAccount: boolean;
  whoCanAddToGroups: 'everyone' | 'following' | 'nobody';
}

const PRIVACY_COLUMNS: Record<keyof PrivacySettings, string> = {
  discoverableByEmail: 'discoverable_by_email',
  discoverableByPhone: 'discoverable_by_phone',
  discoverableByUsername: 'discoverable_by_username',
  whoCanMessage: 'who_can_message',
  showOnlineStatus: 'show_online_status',
  showReadReceipts: 'show_read_receipts',
  privateAccount: 'private_account',
  whoCanAddToGroups: 'who_can_add_to_groups',
};

const PROFILE_COLUMNS = { displayName: 'display_name', bio: 'bio', statusText: 'status_text', locale: 'locale' } as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
    private readonly media: MediaService,
    private readonly groups: GroupsService,
    private readonly follows: FollowsService,
    private readonly posts: PostsService,
    private readonly stories: StoriesService,
    private readonly communities: CommunitiesService,
  ) {}

  async me(userId: string) {
    const u = await this.db.one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!u) throw Errors.notFound('User');
    return {
      id: u.id,
      email: u.email,
      emailVerified: !!u.email_verified_at,
      phone: u.phone_e164,
      username: u.username,
      displayName: u.display_name,
      bio: u.bio,
      statusText: u.status_text,
      locale: u.locale,
      mfaEnabled: !!u.mfa_enabled_at,
      createdAt: u.created_at,
    };
  }

  async updateProfile(userId: string, patch: Partial<Record<keyof typeof PROFILE_COLUMNS, string>>) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof typeof PROFILE_COLUMNS, string][];
    if (entries.length) {
      const sets = entries.map(([k], i) => `${PROFILE_COLUMNS[k]} = $${i + 2}`).join(', ');
      await this.db.query(`UPDATE users SET ${sets}, updated_at = now() WHERE id = $1`, [userId, ...entries.map(([, v]) => v)]);
    }
    return this.me(userId);
  }

  async privacy(userId: string): Promise<PrivacySettings> {
    const r = await this.db.one<Record<string, unknown>>('SELECT * FROM privacy_settings WHERE user_id = $1', [userId]);
    if (!r) throw Errors.notFound('Privacy settings');
    return Object.fromEntries(Object.entries(PRIVACY_COLUMNS).map(([k, col]) => [k, r[col]])) as unknown as PrivacySettings;
  }

  async updatePrivacy(userId: string, patch: Partial<PrivacySettings>) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof PrivacySettings, unknown][];
    if (entries.length) {
      const sets = entries.map(([k], i) => `${PRIVACY_COLUMNS[k]} = $${i + 2}`).join(', ');
      await this.db.query(`UPDATE privacy_settings SET ${sets}, updated_at = now() WHERE user_id = $1`, [userId, ...entries.map(([, v]) => v)]);
      if (patch.privateAccount === false) await this.follows.acceptAllPending(userId);
      await this.audit.record({ actorId: userId, action: 'privacy.updated', metadata: { fields: entries.map(([k]) => k) } });
    }
    return this.privacy(userId);
  }

  /**
   * Public profile by username. Returns 404, never 403, when hidden by privacy or a
   * block in either direction, so the response does not reveal that the account exists.
   */
  async publicProfile(viewerId: string, username: string) {
    const u = await this.db.one<{ id: string; username: string; display_name: string; bio: string; status_text: string }>(
      `SELECT u.id, u.username, u.display_name, u.bio, u.status_text FROM users u
         JOIN privacy_settings p ON p.user_id = u.id
        WHERE u.username = $1 AND u.state = 'active'
          AND (p.discoverable_by_username OR u.id = $2)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = u.id))`,
      [username, viewerId],
    );
    if (!u) throw Errors.notFound('User');
    const [counts, relationship, privacy] = await Promise.all([
      this.follows.counts(u.id),
      u.id === viewerId ? null : this.follows.relationship(viewerId, u.id),
      this.db.one<{ private_account: boolean }>('SELECT private_account FROM privacy_settings WHERE user_id = $1', [u.id]),
    ]);
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      bio: u.bio,
      statusText: u.status_text,
      privateAccount: privacy?.private_account ?? false,
      followerCount: counts.followers,
      followingCount: counts.following,
      // null on your own profile.
      relationship,
    };
  }

  /** Everything we hold about the user that is theirs to take (GDPR Art. 15/20 style export). */
  async exportData(userId: string) {
    const [profile, privacy, sessions, blocks, reports, audit, messages, media, pushDevices, notifications, social, stories, communities, follows] = await Promise.all([
      this.me(userId),
      this.privacy(userId),
      this.db.query('SELECT id, device_name, user_agent, host(ip) AS ip, created_at, last_used_at, revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at', [userId]),
      this.db.query('SELECT blocked_id, created_at FROM blocks WHERE blocker_id = $1', [userId]),
      this.db.query('SELECT id, subject_type, subject_id, reason, details, status, created_at FROM reports WHERE reporter_id = $1', [userId]),
      this.db.query('SELECT action, host(ip) AS ip, created_at FROM audit_log WHERE actor_id = $1 ORDER BY created_at', [userId]),
      this.messaging.exportFor(userId),
      this.db.query(`SELECT id, kind, content_type, byte_size, file_name, state, created_at FROM media WHERE owner_id = $1 ORDER BY created_at`, [userId]),
      this.db.query(
        `SELECT id, session_id, provider, created_at, last_success_at, disabled_at, disabled_reason FROM push_devices WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      ),
      this.db.one('SELECT push_enabled, preview, quiet_start, quiet_end, time_zone, updated_at FROM notification_settings WHERE user_id = $1', [userId]),
      this.posts.exportFor(userId),
      this.stories.exportFor(userId),
      this.communities.exportFor(userId),
      this.db.query(
        `SELECT follower_id, followee_id, state, created_at, accepted_at FROM follows WHERE follower_id = $1 OR followee_id = $1 ORDER BY created_at`,
        [userId],
      ),
    ]);
    await this.audit.record({ actorId: userId, action: 'account.exported' });
    return {
      exportedAt: new Date().toISOString(),
      format: 'nexa-export-v1',
      profile,
      privacy,
      sessions: sessions.rows,
      blocks: blocks.rows,
      reportsFiled: reports.rows,
      securityLog: audit.rows,
      // Messages you sent. Files are listed; download them from the app while signed in.
      messagesSent: messages,
      mediaUploaded: media.rows,
      // Push tokens themselves are left out: they are device secrets, not personal content.
      pushDevices: pushDevices.rows,
      notificationSettings: notifications,
      posts: social.posts,
      comments: social.comments,
      likes: social.likes,
      stories,
      communities,
      follows: follows.rows,
    };
  }

  async deactivate(userId: string, password: string) {
    await this.confirmPassword(userId, password);
    await this.db.tx(async (tx) => {
      await this.db.query(`UPDATE users SET state = 'deactivated', updated_at = now() WHERE id = $1`, [userId], tx);
      await this.db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'deactivated' WHERE user_id = $1 AND revoked_at IS NULL`, [userId], tx);
      await this.db.query('DELETE FROM push_devices WHERE user_id = $1', [userId], tx);
      await this.audit.record({ actorId: userId, action: 'account.deactivated' }, tx);
    });
  }

  /**
   * Deletion scrubs personal data immediately and keeps only a tombstone row (id, state,
   * deleted_at) so foreign keys from audit and safety records stay valid. Reports the
   * user filed are kept for safety review with the reporter detached. Messages they sent
   * are wiped for everyone and their files deleted. See docs/security-privacy.md.
   */
  async deleteAccount(userId: string, password: string) {
    await this.confirmPassword(userId, password);
    const { mediaIds, groupNotices } = await this.db.tx(async (tx) => {
      const sentMedia = await this.messaging.scrubUser(userId, tx);
      const groupNotices = await this.groups.leaveAll(userId, tx);
      const postMedia = await this.posts.scrubUser(userId, tx);
      const storyMedia = await this.stories.scrubUser(userId, tx);
      await this.communities.scrubUser(userId, tx);
      await this.db.query('DELETE FROM follows WHERE follower_id = $1 OR followee_id = $1', [userId], tx);
      await this.db.query(
        `UPDATE users SET state = 'deleted', deleted_at = now(), updated_at = now(),
           email = NULL, email_verified_at = NULL, phone_e164 = NULL, phone_verified_at = NULL, username = NULL,
           password_hash = NULL, display_name = '', bio = '', status_text = '', avatar_object_key = NULL,
           mfa_totp_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_counter = NULL
         WHERE id = $1`,
        [userId],
        tx,
      );
      await this.db.query('DELETE FROM sessions WHERE user_id = $1', [userId], tx);
      await this.db.query('DELETE FROM one_time_tokens WHERE user_id = $1', [userId], tx);
      await this.db.query('DELETE FROM privacy_settings WHERE user_id = $1', [userId], tx);
      await this.db.query('DELETE FROM notification_settings WHERE user_id = $1', [userId], tx);
      await this.db.query('DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId], tx);
      await this.db.query('UPDATE reports SET reporter_id = NULL WHERE reporter_id = $1', [userId], tx);
      await this.db.query('UPDATE audit_log SET ip = NULL WHERE actor_id = $1', [userId], tx);
      await this.audit.record({ actorId: userId, action: 'account.deleted' }, tx);
      const owned = await this.db.query<{ id: string }>(`SELECT id FROM media WHERE owner_id = $1`, [userId], tx);
      return { mediaIds: [...new Set([...sentMedia, ...postMedia, ...storyMedia, ...owned.rows.map((r) => r.id)])], groupNotices };
    });
    await this.groups.announceAll(groupNotices).catch(() => undefined);
    // Stored files go once nothing references them (a forwarded copy keeps its own reference).
    for (const id of mediaIds) await this.media.releaseIfUnused(id).catch(() => undefined);
  }

  private async confirmPassword(userId: string, password: string) {
    const u = await this.db.one<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!(await verifyPassword(u?.password_hash ?? null, password))) throw Errors.invalidCredentials();
  }
}
