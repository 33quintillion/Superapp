import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { MediaService } from '../media/media.service';
import { PushService } from '../push/push.service';
import { RealtimeBus } from '../realtime/realtime-bus.service';
import { SafetyService } from '../safety/safety.service';

export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'voice' | 'file' | 'system' | 'poll' | 'location' | 'contact';

export interface SendInput {
  clientId: string;
  kind: MessageKind;
  body: string;
  mediaId?: string;
  replyToId?: string;
  mentions: string[];
  viewOnce?: boolean;
  poll?: { options: string[]; multiple: boolean };
  location?: { lat: number; lng: number; label: string; liveMinutes?: 15 | 60 | 480 };
  contactUserId?: string;
}

/** Disappearing-message timers a chat can have, in seconds (24 hours, 7 days, 90 days). */
export const DISAPPEAR_OPTIONS = [86400, 604800, 7776000] as const;
/** How long a view-once download link lasts. */
export const VIEW_ONCE_URL_TTL = 60;

/** Edits are allowed for this long after sending. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** "Delete for everyone" is allowed for this long after sending. */
export const DELETE_WINDOW_MS = 48 * 3600 * 1000;
export const MAX_PINS = 10;
export const MAX_BODY = 4000;
export const MAX_POLL_QUESTION = 300;
export const MAX_STARS = 2000;

const cannotMessage = () => new AppError(HttpStatus.FORBIDDEN, 'cannot_message', 'You can’t message this person');
const systemMessage = () => Errors.conflict('system_message', 'Group updates cannot be changed');

export type GroupPolicy = 'everyone' | 'admins';

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: string;
  change_seq: string;
  sender_id: string;
  client_id: string;
  kind: MessageKind;
  body: string;
  forwarded: boolean;
  mentions: string[];
  edited_at: Date | null;
  deleted_at: Date | null;
  pinned_at: Date | null;
  pinned_by: string | null;
  created_at: Date;
  system_event: Record<string, unknown> | null;
  hidden: boolean;
  media: Record<string, unknown> | null;
  reply_to: Record<string, unknown> | null;
  reactions: { userId: string; emoji: string }[];
  view_once: boolean;
  expires_at: Date | null;
  attachment: Record<string, unknown> | null;
  poll: { options: string[]; multiple: boolean; votes: { userId: string; option: number }[] } | null;
  contact: { userId: string; displayName: string; username: string | null } | null;
  opened_by: string[] | null;
}

interface MemberRow {
  user_id: string;
  username: string | null;
  display_name: string;
  state: string;
  avatar_media_id: string | null;
  role: string;
  joined_at: Date;
  last_delivered_seq: string;
  last_read_seq: string;
  show_read_receipts: boolean | null;
}

/** One SELECT shape for every message read, so REST, the change feed and events agree. */
const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.seq, m.change_seq, m.sender_id, m.client_id, m.kind, m.body, m.forwarded,
         m.mentions, m.edited_at, m.deleted_at, m.pinned_at, m.pinned_by, m.created_at, m.system_event,
         m.view_once, m.expires_at, m.attachment,
         CASE WHEN p.message_id IS NULL THEN NULL ELSE json_build_object('options', p.options, 'multiple', p.multiple,
           'votes', COALESCE((SELECT json_agg(json_build_object('userId', v.user_id, 'option', v.option) ORDER BY v.created_at, v.option)
                                FROM poll_votes v WHERE v.message_id = m.id), '[]'::json)) END AS poll,
         CASE WHEN m.kind = 'contact' AND m.attachment IS NOT NULL THEN (
           SELECT json_build_object('userId', cu.id, 'username', CASE WHEN cu.state = 'deleted' THEN NULL ELSE cu.username END,
                  'displayName', CASE WHEN cu.state = 'deleted' THEN 'Deleted account' ELSE cu.display_name END)
             FROM users cu WHERE cu.id = (m.attachment->>'userId')::uuid) END AS contact,
         CASE WHEN m.view_once THEN COALESCE((SELECT json_agg(o.user_id ORDER BY o.opened_at) FROM view_once_opens o WHERE o.message_id = m.id), '[]'::json) END AS opened_by,
         EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = $1) AS hidden,
         CASE WHEN md.id IS NULL THEN NULL ELSE json_build_object(
           'id', md.id, 'kind', md.kind, 'contentType', md.content_type, 'byteSize', md.byte_size,
           'fileName', md.file_name, 'durationMs', md.duration_ms, 'width', md.width, 'height', md.height) END AS media,
         CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
           'id', r.id, 'seq', r.seq, 'senderId', r.sender_id, 'kind', r.kind, 'deleted', r.deleted_at IS NOT NULL,
           'preview', CASE WHEN r.deleted_at IS NULL THEN left(r.body, 120) ELSE '' END) END AS reply_to,
         COALESCE((SELECT json_agg(json_build_object('userId', x.user_id, 'emoji', x.emoji) ORDER BY x.created_at)
                     FROM message_reactions x WHERE x.message_id = m.id), '[]'::json) AS reactions
    FROM messages m
    LEFT JOIN media md ON md.id = m.media_id
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN message_polls p ON p.message_id = m.id`;

function messageDto(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    seq: Number(m.seq),
    changeSeq: Number(m.change_seq),
    senderId: m.sender_id,
    clientId: m.client_id,
    kind: m.kind,
    body: m.deleted_at ? null : m.body,
    media: m.media,
    replyTo: m.reply_to,
    forwarded: m.forwarded,
    mentions: m.mentions,
    system: m.deleted_at ? null : m.system_event,
    poll: m.deleted_at ? null : m.poll,
    location: m.deleted_at || m.kind !== 'location' ? null : m.attachment,
    contact: m.deleted_at ? null : m.contact,
    viewOnce: m.view_once,
    openedBy: m.opened_by,
    expiresAt: m.expires_at,
    reactions: m.reactions,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    pinnedAt: m.pinned_at,
    pinnedBy: m.pinned_by,
    createdAt: m.created_at,
  };
}
export type MessageDto = ReturnType<typeof messageDto>;

/** Messages from before the viewer joined a group stay hidden from them ($1 is the viewer). */
const SINCE_JOINED = `AND m.seq > (SELECT vm.visible_from_seq FROM conversation_members vm WHERE vm.conversation_id = m.conversation_id AND vm.user_id = $1)`;

/** Fixed viewer for event payloads, which go to every member: nobody's hides apply. */
export const NO_VIEWER = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class MessagingService {
  private readonly logger = new Logger('Messaging');

  constructor(
    private readonly db: DatabaseService,
    private readonly bus: RealtimeBus,
    private readonly safety: SafetyService,
    private readonly media: MediaService,
    private readonly limits: RateLimitService,
    private readonly push: PushService,
  ) {}

  // ---------------------------------------------------------------- conversations

  /** Finds or creates the one direct conversation between two users. */
  async openDirect(userId: string, otherId: string) {
    if (userId === otherId) throw Errors.validation([{ path: 'userId', message: 'You cannot start a chat with yourself' }]);
    const other = await this.db.one(`SELECT 1 FROM users WHERE id = $1 AND state = 'active'`, [otherId]);
    // Same answer for "no such user" and "blocked", like profile lookups.
    if (!other || (await this.safety.isBlockedEitherWay(userId, otherId))) throw Errors.notFound('User');
    const key = [userId, otherId].sort().join(':');
    const id = await this.db.tx(async (tx) => {
      const created = await this.db.one<{ id: string }>(
        `INSERT INTO conversations (kind, direct_key, created_by) VALUES ('direct', $1, $2) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
        [key, userId],
        tx,
      );
      if (created) {
        await this.db.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
          [created.id, userId, otherId],
          tx,
        );
        return created.id;
      }
      return (await this.db.one<{ id: string }>('SELECT id FROM conversations WHERE direct_key = $1', [key], tx))!.id;
    });
    return this.getConversation(userId, id);
  }

  async listConversations(userId: string, opts: { archived: boolean; limit: number; cursor?: string }) {
    const params: unknown[] = [userId, opts.archived, opts.limit + 1];
    let cursorSql = '';
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      cursorSql = `AND (COALESCE(c.last_message_at, c.created_at), c.id) < ($4::timestamptz, $5::uuid)`;
    }
    const { rows } = await this.db.query<{ id: string; activity: Date }>(
      `SELECT c.id, COALESCE(c.last_message_at, c.created_at) AS activity FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
        WHERE (cm.archived_at IS NOT NULL) = $2 ${cursorSql}
        ORDER BY activity DESC, c.id DESC LIMIT $3`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    const items = await Promise.all(page.map((r) => this.getConversation(userId, r.id)));
    const last = page[page.length - 1];
    return { conversations: items, nextCursor: rows.length > opts.limit && last ? encodeCursor(last.activity, last.id) : null };
  }

  async getConversation(userId: string, conversationId: string, db?: Queryable) {
    const c = await this.db.one<{
      id: string;
      kind: string;
      title: string;
      last_seq: string;
      last_message_at: Date | null;
      created_at: Date;
      muted_until: Date | null;
      archived_at: Date | null;
      last_read_seq: string;
      description: string;
      send_policy: GroupPolicy;
      info_policy: GroupPolicy;
      add_policy: GroupPolicy;
      disappear_seconds: number | null;
    }>(
      `SELECT c.id, c.kind, c.title, c.last_seq, c.last_message_at, c.created_at, cm.muted_until, cm.archived_at, cm.last_read_seq,
              c.description, c.send_policy, c.info_policy, c.add_policy, c.disappear_seconds
         FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
        WHERE c.id = $1`,
      [conversationId, userId],
      db,
    );
    if (!c) throw Errors.notFound('Conversation');
    const [members, last, unread] = await Promise.all([
      this.members(conversationId, db),
      this.db.one<MessageRow>(
        `${MESSAGE_SELECT} WHERE m.conversation_id = $2 ${SINCE_JOINED}
            AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = $1)
          ORDER BY m.seq DESC LIMIT 1`,
        [userId, conversationId],
        db,
      ),
      this.db.one<{ n: string }>(
        `SELECT count(*) AS n FROM messages m WHERE m.conversation_id = $1 AND m.seq > $3 AND m.sender_id <> $2 AND m.deleted_at IS NULL AND m.kind <> 'system'
            AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = $2)`,
        [conversationId, userId, c.last_read_seq],
        db,
      ),
    ]);
    const me = members.find((m) => m.user_id === userId);
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      lastSeq: Number(c.last_seq),
      lastMessageAt: c.last_message_at,
      lastMessage: last ? messageDto(last) : null,
      unreadCount: Number(unread!.n),
      mutedUntil: c.muted_until,
      archived: !!c.archived_at,
      disappearSeconds: c.disappear_seconds,
      createdAt: c.created_at,
      peerId: c.kind === 'direct' ? (members.find((m) => m.user_id !== userId)?.user_id ?? null) : null,
      group:
        c.kind === 'group'
          ? { description: c.description, sendPolicy: c.send_policy, infoPolicy: c.info_policy, addPolicy: c.add_policy, myRole: me?.role ?? 'member' }
          : null,
      members: members.map((m) => this.memberDto(m, me)),
    };
  }

  async updateMembership(userId: string, conversationId: string, patch: { mutedUntil?: Date | null; archived?: boolean }) {
    await this.requireMember(userId, conversationId);
    const sets: string[] = [];
    const params: unknown[] = [conversationId, userId];
    if (patch.mutedUntil !== undefined) {
      params.push(patch.mutedUntil);
      sets.push(`muted_until = $${params.length}`);
    }
    if (patch.archived !== undefined) sets.push(`archived_at = ${patch.archived ? 'COALESCE(archived_at, now())' : 'NULL'}`);
    if (sets.length) {
      await this.db.query(
        `UPDATE conversation_members SET ${sets.join(', ')}, updated_at = now() WHERE conversation_id = $1 AND user_id = $2`,
        params,
      );
    }
    const conv = await this.getConversation(userId, conversationId);
    await this.bus.publish([userId], { type: 'conversation.updated', data: { id: conv.id, mutedUntil: conv.mutedUntil, archived: conv.archived } });
    return conv;
  }

  // ---------------------------------------------------------------- messages

  /**
   * Idempotent on (conversation, sender, clientId): a retry after a lost ack returns the
   * original message with duplicate=true instead of sending it twice.
   */
  async send(userId: string, conversationId: string, input: SendInput, opts: { forwarded?: boolean; mediaPreauthorised?: boolean } = {}) {
    const existing = await this.findByClientId(userId, conversationId, input.clientId);
    if (existing) return { message: existing, duplicate: true };
    await this.limits.consume({ name: 'message:send', limit: 120, windowSeconds: 60 }, userId);
    let messageId: string;
    try {
      messageId = await this.db.tx(async (tx) => {
        const members = await this.members(conversationId, tx);
        if (!members.some((m) => m.user_id === userId)) throw Errors.notFound('Conversation');
        await this.assertCanSend(userId, conversationId, members, tx);
        await this.validateContent(userId, conversationId, input, members, opts.mediaPreauthorised ?? false, tx);
        const seq = await this.nextSeq(conversationId, tx);
        const row = await this.db.one<{ id: string }>(
          `INSERT INTO messages (conversation_id, seq, change_seq, sender_id, client_id, kind, body, media_id, reply_to_id, forwarded, mentions,
                                 view_once, attachment, expires_at)
           VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   (SELECT now() + make_interval(secs => c.disappear_seconds) FROM conversations c WHERE c.id = $1)) RETURNING id`,
          [
            conversationId,
            seq,
            userId,
            input.clientId,
            input.kind,
            input.body,
            input.mediaId ?? null,
            input.replyToId ?? null,
            opts.forwarded ?? false,
            input.mentions,
            input.viewOnce ?? false,
            attachmentFor(input),
          ],
          tx,
        );
        if (input.kind === 'poll') {
          await this.db.query('INSERT INTO message_polls (message_id, options, multiple) VALUES ($1, $2, $3)', [row!.id, input.poll!.options, input.poll!.multiple], tx);
        }
        await this.db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId], tx);
        // The sender has, by definition, seen their own message on this device.
        await this.db.query(
          `UPDATE conversation_members SET last_delivered_seq = $3, last_read_seq = $3, updated_at = now()
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, userId, seq],
          tx,
        );
        // Same transaction: the notification is queued if and only if the message is saved.
        await this.push.enqueueMessage(tx, conversationId, row!.id, userId);
        return row!.id;
      });
    } catch (err) {
      // Two concurrent retries with the same clientId: the loser returns the winner's message.
      if ((err as { code?: string }).code === '23505') {
        const dup = await this.findByClientId(userId, conversationId, input.clientId);
        if (dup) return { message: dup, duplicate: true };
      }
      throw err;
    }
    this.push.kick();
    const message = (await this.loadOne(NO_VIEWER, messageId))!;
    await this.publishToMembers(conversationId, { type: 'message.created', data: message });
    return { message, duplicate: false };
  }

  /** Newest-first history paging (before) or catch-up paging (after), returned oldest-first. */
  async listMessages(userId: string, conversationId: string, opts: { before?: number; after?: number; limit: number }) {
    await this.requireMember(userId, conversationId);
    const hidden = `AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = $1) ${SINCE_JOINED}`;
    let rows: MessageRow[];
    if (opts.after !== undefined) {
      rows = (
        await this.db.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.seq > $3 ${hidden} ORDER BY m.seq ASC LIMIT $4`, [
          userId,
          conversationId,
          opts.after,
          opts.limit + 1,
        ])
      ).rows;
      const hasMore = rows.length > opts.limit;
      return { messages: rows.slice(0, opts.limit).map(messageDto), hasMore };
    }
    rows = (
      await this.db.query<MessageRow>(
        `${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.seq < $3 ${hidden} ORDER BY m.seq DESC LIMIT $4`,
        [userId, conversationId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit + 1],
      )
    ).rows;
    const hasMore = rows.length > opts.limit;
    return { messages: rows.slice(0, opts.limit).reverse().map(messageDto), hasMore };
  }

  /**
   * Everything that changed after `since`, in change order. A device stores the last
   * nextSince it processed and calls this after reconnecting or on detecting a gap.
   */
  async changes(userId: string, conversationId: string, since: number, limit: number) {
    await this.requireMember(userId, conversationId);
    const head = await this.db.one<{ last_seq: string }>('SELECT last_seq FROM conversations WHERE id = $1', [conversationId]);
    const lastSeq = Number(head!.last_seq);
    const { rows } = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.change_seq > $3 AND m.change_seq <= $4 ${SINCE_JOINED} ORDER BY m.change_seq ASC LIMIT $5`,
      [userId, conversationId, since, lastSeq, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const changes = page.map((r) =>
      r.hidden ? { id: r.id, conversationId, seq: Number(r.seq), changeSeq: Number(r.change_seq), hidden: true as const } : messageDto(r),
    );
    // Changes overwrite each other's change_seq, so when the page is complete jump to the head.
    const nextSince = hasMore ? Number(page[page.length - 1].change_seq) : Math.max(since, lastSeq);
    return { changes, nextSince, hasMore };
  }

  async edit(userId: string, messageId: string, body: string) {
    return this.mutate(userId, messageId, async (m, tx, seq) => {
      if (m.kind === 'system') throw systemMessage();
      if (m.sender_id !== userId) throw Errors.forbidden('Only the sender can edit a message');
      if (m.deleted_at) throw Errors.conflict('message_deleted', 'This message was deleted');
      if (m.kind === 'poll' || m.kind === 'location' || m.kind === 'contact') throw Errors.conflict('not_editable', 'This message can’t be edited');
      if (Date.now() - m.created_at.getTime() > EDIT_WINDOW_MS) throw Errors.conflict('edit_window_passed', 'Messages can only be edited for 15 minutes');
      if (m.kind === 'text' && !body.trim()) throw Errors.validation([{ path: 'body', message: 'A text message cannot be empty' }]);
      await this.db.query('UPDATE messages SET body = $2, edited_at = now(), change_seq = $3 WHERE id = $1', [m.id, body, seq], tx);
    });
  }

  async deleteForEveryone(userId: string, messageId: string) {
    const released: { mediaId: string | null } = { mediaId: null };
    const out = await this.mutate(userId, messageId, async (m, tx, seq) => {
      if (m.kind === 'system') throw systemMessage();
      if (m.sender_id !== userId) throw Errors.forbidden('Only the sender can delete a message for everyone');
      if (m.deleted_at) return;
      if (Date.now() - m.created_at.getTime() > DELETE_WINDOW_MS) throw Errors.conflict('delete_window_passed', 'Messages can only be deleted for everyone for 48 hours');
      released.mediaId = m.media_id;
      await this.db.query(
        `UPDATE messages SET body = '', media_id = NULL, attachment = NULL, mentions = '{}', pinned_at = NULL, pinned_by = NULL, deleted_at = now(), change_seq = $2
          WHERE id = $1`,
        [m.id, seq],
        tx,
      );
      await this.db.query('DELETE FROM message_reactions WHERE message_id = $1', [m.id], tx);
    });
    if (released.mediaId) await this.media.releaseIfUnused(released.mediaId).catch((e) => this.logger.warn(`media release failed: ${e.message}`));
    return out;
  }

  /** Platform moderation (admin dashboard): removes a reported message for everyone, whatever its age. */
  async removeByModerator(messageId: string) {
    const m = await this.db.one<{ conversation_id: string; media_id: string | null }>(
      `SELECT conversation_id, media_id FROM messages WHERE id = $1 AND deleted_at IS NULL AND kind <> 'system'`,
      [messageId],
    );
    if (!m) return false;
    const removed = await this.db
      .tx(async (tx) => {
        const seq = await this.nextSeq(m.conversation_id, tx);
        const r = await this.db.query(
          `UPDATE messages SET body = '', media_id = NULL, attachment = NULL, mentions = '{}', pinned_at = NULL, pinned_by = NULL, deleted_at = now(), change_seq = $2
            WHERE id = $1 AND deleted_at IS NULL`,
          [messageId, seq],
          tx,
        );
        if (!r.rowCount) throw new NoChange(m.conversation_id);
        await this.db.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId], tx);
        return true;
      })
      .catch((err) => {
        if (err instanceof NoChange) return false;
        throw err;
      });
    if (!removed) return false;
    await this.publishToMembers(m.conversation_id, { type: 'message.updated', data: (await this.loadOne(NO_VIEWER, messageId))! });
    if (m.media_id) await this.media.releaseIfUnused(m.media_id).catch((e) => this.logger.warn(`media release failed: ${e.message}`));
    return true;
  }

  /** "Delete for me". Other members keep the message. */
  async hideForMe(userId: string, messageId: string) {
    const m = await this.requireVisibleMessage(userId, messageId);
    const seq = await this.db.tx(async (tx) => {
      const inserted = await this.db.query('INSERT INTO message_hides (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.id, userId], tx);
      if (!inserted.rowCount) return null;
      const s = await this.nextSeq(m.conversation_id, tx);
      await this.db.query('UPDATE messages SET change_seq = $2 WHERE id = $1', [m.id, s], tx);
      return s;
    });
    if (seq !== null) {
      await this.bus.publish([userId], { type: 'message.hidden', data: { id: m.id, conversationId: m.conversation_id, changeSeq: seq } });
      // Everyone else just sees the counter move, so they don't mistake it for a gap.
      const others = (await this.members(m.conversation_id)).map((x) => x.user_id).filter((id) => id !== userId);
      const dto = (await this.loadOne(NO_VIEWER, m.id))!;
      await this.bus.publish(others, { type: 'message.updated', data: dto });
    }
  }

  async react(userId: string, messageId: string, emoji: string | null) {
    return this.mutate(userId, messageId, async (m, tx, seq) => {
      if (m.kind === 'system') throw systemMessage();
      if (m.deleted_at) throw Errors.conflict('message_deleted', 'This message was deleted');
      await this.assertNotBlocked(userId, m.conversation_id, tx);
      if (emoji === null) await this.db.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [m.id, userId], tx);
      else {
        await this.db.query(
          `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
             ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
          [m.id, userId, emoji],
          tx,
        );
      }
      await this.db.query('UPDATE messages SET change_seq = $2 WHERE id = $1', [m.id, seq], tx);
    });
  }

  async pin(userId: string, messageId: string, pinned: boolean) {
    return this.mutate(userId, messageId, async (m, tx, seq) => {
      if (m.kind === 'system') throw systemMessage();
      if (m.deleted_at) throw Errors.conflict('message_deleted', 'This message was deleted');
      await this.assertNotBlocked(userId, m.conversation_id, tx);
      if (pinned && !m.pinned_at) {
        const n = await this.db.one<{ n: string }>('SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND pinned_at IS NOT NULL', [m.conversation_id], tx);
        if (Number(n!.n) >= MAX_PINS) throw Errors.conflict('too_many_pins', `A chat can have at most ${MAX_PINS} pinned messages`);
      }
      await this.db.query(
        `UPDATE messages SET pinned_at = ${pinned ? 'COALESCE(pinned_at, now())' : 'NULL'}, pinned_by = ${pinned ? 'COALESCE(pinned_by, $3)' : 'NULL'}, change_seq = $2 WHERE id = $1`,
        pinned ? [m.id, seq, userId] : [m.id, seq],
        tx,
      );
    });
  }

  async pinned(userId: string, conversationId: string) {
    await this.requireMember(userId, conversationId);
    const { rows } = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.pinned_at IS NOT NULL ${SINCE_JOINED} ORDER BY m.pinned_at DESC`,
      [userId, conversationId],
    );
    return rows.map(messageDto);
  }

  // ---------------------------------------------------------------- polls, stars, timers, view once, live location

  /** Replaces this person's votes on a poll; an empty list takes their vote back. */
  async vote(userId: string, messageId: string, options: number[]) {
    await this.limits.consume({ name: 'poll:vote', limit: 300, windowSeconds: 3600 }, userId);
    return this.mutate(userId, messageId, async (m, tx, seq) => {
      if (m.kind !== 'poll') throw Errors.conflict('not_a_poll', 'This message is not a poll');
      if (m.deleted_at) throw Errors.conflict('message_deleted', 'This message was deleted');
      await this.assertNotBlocked(userId, m.conversation_id, tx);
      const p = (await this.db.one<{ options: string[]; multiple: boolean }>('SELECT options, multiple FROM message_polls WHERE message_id = $1', [m.id], tx))!;
      const chosen = [...new Set(options)].sort((a, b) => a - b);
      if (chosen.some((o) => o >= p.options.length)) throw Errors.validation([{ path: 'options', message: 'That option isn’t in this poll' }]);
      if (!p.multiple && chosen.length > 1) throw Errors.validation([{ path: 'options', message: 'This poll allows one answer' }]);
      const { rows } = await this.db.query<{ option: number }>('SELECT option FROM poll_votes WHERE message_id = $1 AND user_id = $2 ORDER BY option', [m.id, userId], tx);
      if (rows.map((r) => r.option).join(',') === chosen.join(',')) return; // no change
      await this.db.query('DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2', [m.id, userId], tx);
      if (chosen.length) {
        await this.db.query('INSERT INTO poll_votes (message_id, user_id, option) SELECT $1, $2, unnest($3::smallint[])', [m.id, userId, chosen], tx);
      }
      await this.db.query('UPDATE messages SET change_seq = $2 WHERE id = $1', [m.id, seq], tx);
    });
  }

  /** Stars are private: nobody else is told. */
  async star(userId: string, messageId: string, starred: boolean) {
    const m = await this.requireVisibleMessage(userId, messageId);
    if (m.kind === 'system') throw systemMessage();
    if (starred) {
      if (m.deleted_at) throw Errors.conflict('message_deleted', 'This message was deleted');
      const n = await this.db.one<{ n: string }>('SELECT count(*) AS n FROM message_stars WHERE user_id = $1', [userId]);
      if (Number(n!.n) >= MAX_STARS) throw Errors.conflict('too_many_stars', `You can star up to ${MAX_STARS} messages`);
      await this.db.query('INSERT INTO message_stars (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, m.id]);
    } else {
      await this.db.query('DELETE FROM message_stars WHERE user_id = $1 AND message_id = $2', [userId, m.id]);
    }
    await this.bus.publish([userId], { type: 'message.starred', data: { id: m.id, conversationId: m.conversation_id, starred } });
    return { messageId: m.id, starred };
  }

  /** Starred messages, newest star first, from every chat or one. Deleted and expired ones drop out. */
  async starred(userId: string, opts: { conversationId?: string; limit: number; cursor?: string }) {
    const params: unknown[] = [userId, opts.limit + 1];
    let extra = '';
    if (opts.conversationId) {
      params.push(opts.conversationId);
      extra += ` AND m.conversation_id = $${params.length}`;
    }
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      extra += ` AND (s.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const { rows } = await this.db.query<MessageRow & { starred_at: Date }>(
      `${MESSAGE_SELECT.replace('SELECT m.id,', 'SELECT s.created_at AS starred_at, m.id,')}
         JOIN message_stars s ON s.message_id = m.id AND s.user_id = $1
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.deleted_at IS NULL AND m.seq > cm.visible_from_seq
          AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = $1) ${extra}
        ORDER BY s.created_at DESC, m.id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      messages: page.map((r) => ({ ...messageDto(r), starredAt: r.starred_at })),
      nextCursor: rows.length > opts.limit && last ? encodeCursor(last.starred_at, last.id) : null,
    };
  }

  /**
   * Disappearing messages: from now on, new messages in this chat vanish for everyone after
   * the chosen time. Anyone in a direct chat can change it; in a group, whoever may edit the
   * group's info. Everyone sees a notice, as in WhatsApp.
   */
  async setDisappearing(userId: string, conversationId: string, seconds: number | null) {
    await this.limits.consume({ name: 'chat:disappearing', limit: 30, windowSeconds: 3600 }, userId);
    const noticeId = await this.db.tx(async (tx) => {
      const c = await this.db.one<{ kind: string; info_policy: GroupPolicy; disappear_seconds: number | null }>(
        'SELECT kind, info_policy, disappear_seconds FROM conversations WHERE id = $1 FOR UPDATE',
        [conversationId],
        tx,
      );
      const me = c ? await this.db.one<{ role: string }>('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId], tx) : null;
      if (!c || !me) throw Errors.notFound('Conversation');
      if (c.kind === 'group' && c.info_policy === 'admins' && me.role === 'member') {
        throw new AppError(HttpStatus.FORBIDDEN, 'admins_only', 'Only admins can change this in this group');
      }
      if (c.kind === 'direct') await this.assertNotBlocked(userId, conversationId, tx);
      if (c.disappear_seconds === seconds) return null;
      await this.db.query('UPDATE conversations SET disappear_seconds = $2 WHERE id = $1', [conversationId, seconds], tx);
      return this.insertSystem(tx, conversationId, userId, { type: 'disappearing_changed', seconds });
    });
    if (noticeId) {
      await this.publishToMembers(conversationId, { type: 'message.created', data: (await this.loadOne(NO_VIEWER, noticeId))! });
      await this.publishToMembers(conversationId, { type: 'conversation.changed', data: { id: conversationId } });
    }
    return this.getConversation(userId, conversationId);
  }

  /**
   * Opens a view-once photo or video: a short download link, given once per person. The
   * sender is told it was opened. Other ways to download it are closed to everyone but the sender.
   */
  async openViewOnce(userId: string, messageId: string) {
    const m = await this.requireVisibleMessage(userId, messageId);
    if (!m.view_once) throw Errors.conflict('not_view_once', 'This message isn’t view once');
    if (m.deleted_at || !m.media_id) throw Errors.conflict('message_deleted', 'This message was deleted');
    if (m.sender_id === userId) throw Errors.conflict('own_view_once', 'You can’t open a view-once message you sent');
    const opened = await this.db.tx(async (tx) => {
      const ins = await this.db.query('INSERT INTO view_once_opens (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.id, userId], tx);
      if (!ins.rowCount) return false;
      const seq = await this.nextSeq(m.conversation_id, tx);
      await this.db.query('UPDATE messages SET change_seq = $2 WHERE id = $1', [m.id, seq], tx);
      return true;
    });
    if (!opened) throw Errors.conflict('already_opened', 'You’ve already opened this');
    const out = await this.media.viewOnceUrl(m.media_id, VIEW_ONCE_URL_TTL);
    await this.publishToMembers(m.conversation_id, { type: 'message.updated', data: (await this.loadOne(NO_VIEWER, m.id))! });
    return out;
  }

  /** The sender's phone reports where they are while a live location is on. */
  async updateLiveLocation(userId: string, messageId: string, lat: number, lng: number) {
    await this.limits.consume({ name: 'location:live', limit: 120, windowSeconds: 600 }, userId);
    return this.mutate(userId, messageId, async (m, tx, seq) => {
      this.assertLive(userId, m);
      await this.db.query(
        `UPDATE messages SET attachment = attachment || jsonb_build_object('lat', $3::float8, 'lng', $4::float8, 'updatedAt', now()), change_seq = $2
          WHERE id = $1`,
        [m.id, seq, lat, lng],
        tx,
      );
    });
  }

  async stopLiveLocation(userId: string, messageId: string) {
    return this.mutate(userId, messageId, async (m, tx, seq) => {
      this.assertLive(userId, m);
      await this.db.query(`UPDATE messages SET attachment = attachment || jsonb_build_object('liveUntil', now()), change_seq = $2 WHERE id = $1`, [m.id, seq], tx);
    });
  }

  private assertLive(userId: string, m: { kind: MessageKind; sender_id: string; deleted_at: Date | null; attachment: Record<string, unknown> | null }) {
    if (m.kind !== 'location' || m.deleted_at) throw Errors.conflict('not_live', 'This isn’t a live location');
    if (m.sender_id !== userId) throw Errors.forbidden('Only the person sharing can change their live location');
    const until = (m.attachment as { liveUntil?: string | null } | null)?.liveUntil;
    if (!until || new Date(until).getTime() <= Date.now()) throw Errors.conflict('live_ended', 'Live location has ended');
  }

  /** Removes disappearing messages whose time is up, for everyone. Returns how many. */
  async sweepExpired(limit = 500) {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM messages WHERE expires_at <= now() AND deleted_at IS NULL ORDER BY expires_at LIMIT $1`,
      [limit],
    );
    let n = 0;
    for (const r of rows) if (await this.removeByModerator(r.id)) n++;
    return n;
  }

  /** A notice in the chat's history ("Ada turned on disappearing messages"). */
  async insertSystem(tx: Queryable, conversationId: string, actorId: string, event: Record<string, unknown>) {
    const seq = await this.nextSeq(conversationId, tx);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO messages (conversation_id, seq, change_seq, sender_id, client_id, kind, system_event)
       VALUES ($1, $2, $2, $3, $4, 'system', $5) RETURNING id`,
      [conversationId, seq, actorId, `sys_${randomBytes(12).toString('hex')}`, JSON.stringify(event)],
      tx,
    );
    await this.db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId], tx);
    return row!.id;
  }

  /** Copies a message the user can see into other chats, marked as forwarded. */
  async forward(userId: string, messageId: string, conversationIds: string[], clientId: string) {
    const src = await this.requireVisibleMessage(userId, messageId);
    if (src.kind === 'system') throw systemMessage();
    if (src.deleted_at) throw Errors.conflict('message_deleted', 'This message was deleted');
    if (src.view_once || src.kind === 'poll') throw Errors.conflict('not_forwardable', 'This message can’t be forwarded');
    const a = (src.attachment ?? {}) as { lat?: number; lng?: number; label?: string; userId?: string };
    const results = [];
    for (const conversationId of conversationIds) {
      const r = await this.send(
        userId,
        conversationId,
        {
          clientId,
          kind: src.kind,
          body: src.body,
          mediaId: src.media_id ?? undefined,
          mentions: [],
          // A forwarded location is where it was, not a live share.
          location: src.kind === 'location' ? { lat: a.lat!, lng: a.lng!, label: a.label ?? '' } : undefined,
          contactUserId: src.kind === 'contact' ? a.userId : undefined,
        },
        { forwarded: true, mediaPreauthorised: true },
      );
      results.push(r.message);
    }
    return results;
  }

  /** Word-prefix search over the user's own chats. Server-side, because messages are not E2EE yet. */
  async search(userId: string, q: string, opts: { conversationId?: string; limit: number; cursor?: string }) {
    const terms = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
    if (!terms.length) return { results: [], nextCursor: null };
    const tsquery = terms.map((t) => `${t.toLowerCase()}:*`).join(' & ');
    const params: unknown[] = [userId, tsquery, opts.limit + 1];
    let extra = '';
    if (opts.conversationId) {
      params.push(opts.conversationId);
      extra += ` AND m.conversation_id = $${params.length}`;
    }
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      extra += ` AND (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const { rows } = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT}
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.deleted_at IS NULL AND m.seq > cm.visible_from_seq AND to_tsvector('simple', m.body) @@ to_tsquery('simple', $2)
          AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = $1) ${extra}
        ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return { results: page.map(messageDto), nextCursor: rows.length > opts.limit && last ? encodeCursor(last.created_at, last.id) : null };
  }

  /**
   * Moves this user's delivered or read position forward (never back). Read positions are
   * shared only when both people have read receipts switched on, as most messengers do.
   */
  async markReceipt(userId: string, conversationId: string, kind: 'delivered' | 'read', seq: number) {
    await this.requireMember(userId, conversationId);
    const r = await this.db.one<{ last_delivered_seq: string; last_read_seq: string; old_read_seq: string; changed: boolean }>(
      `WITH c AS (SELECT last_seq FROM conversations WHERE id = $1),
            old AS (SELECT last_delivered_seq, last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)
       UPDATE conversation_members cm SET
         last_delivered_seq = GREATEST(cm.last_delivered_seq, LEAST($3, (SELECT last_seq FROM c))),
         last_read_seq = CASE WHEN $4 THEN GREATEST(cm.last_read_seq, LEAST($3, (SELECT last_seq FROM c))) ELSE cm.last_read_seq END,
         updated_at = now()
       FROM old WHERE cm.conversation_id = $1 AND cm.user_id = $2
       RETURNING cm.last_delivered_seq, cm.last_read_seq, old.last_read_seq AS old_read_seq,
         (cm.last_delivered_seq, cm.last_read_seq) IS DISTINCT FROM (old.last_delivered_seq, old.last_read_seq) AS changed`,
      [conversationId, userId, seq, kind === 'read'],
    );
    const out = { conversationId, userId, lastDeliveredSeq: Number(r!.last_delivered_seq), lastReadSeq: Number(r!.last_read_seq) };
    if (r!.changed) {
      const members = await this.members(conversationId);
      const me = members.find((m) => m.user_id === userId)!;
      for (const viewer of members) {
        const visible = viewer.user_id === userId || (me.show_read_receipts !== false && viewer.show_read_receipts !== false);
        await this.bus.publish([viewer.user_id], { type: 'receipt', data: { ...out, lastReadSeq: visible ? out.lastReadSeq : null } });
      }
      // Read here: take the notifications for these messages off the person's other devices.
      await this.push.enqueueClear(userId, conversationId, Number(r!.old_read_seq), out.lastReadSeq);
    }
    return out;
  }

  /** Typing is relayed, never stored. */
  async typing(userId: string, conversationId: string, typing: boolean) {
    const members = await this.members(conversationId);
    if (!members.some((m) => m.user_id === userId)) throw Errors.notFound('Conversation');
    const others = members.filter((m) => m.user_id !== userId).map((m) => m.user_id);
    // In groups, people who blocked each other just don't see each other typing.
    const visible = [];
    for (const o of others) if (!(await this.safety.isBlockedEitherWay(userId, o))) visible.push(o);
    await this.bus.publish(visible, { type: 'typing', data: { conversationId, userId, typing } });
  }

  /** People this user shares a chat with (and is not blocked with), for presence. */
  async chatPeers(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT cm2.user_id FROM conversation_members cm
         JOIN conversation_members cm2 ON cm2.conversation_id = cm.conversation_id AND cm2.user_id <> cm.user_id
        WHERE cm.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = cm2.user_id) OR (b.blocker_id = cm2.user_id AND b.blocked_id = $1))`,
      [userId],
    );
    return rows.map((r) => r.user_id);
  }

  /** Online state is shown only when both people share it, and only between chat peers. */
  async presenceFor(viewerId: string, userIds: string[]) {
    const peers = new Set(await this.chatPeers(viewerId));
    const ids = [...new Set(userIds)].filter((id) => peers.has(id));
    const { rows } = await this.db.query<{ user_id: string; show_online_status: boolean }>(
      'SELECT user_id, show_online_status FROM privacy_settings WHERE user_id = ANY($1::uuid[])',
      [[viewerId, ...ids]],
    );
    const share = new Map(rows.map((r) => [r.user_id, r.show_online_status]));
    const live = await this.bus.presence(ids);
    return userIds.map((id) => {
      const p = live.get(id);
      const visible = !!p && share.get(viewerId) === true && share.get(id) === true;
      return { userId: id, online: visible ? p!.online : null, lastSeenAt: visible ? p!.lastSeenAt : null };
    });
  }

  /** Called when a user comes online or goes offline, so their chat peers' screens update. */
  async announcePresence(userId: string, online: boolean) {
    const shares = await this.db.one<{ show_online_status: boolean }>('SELECT show_online_status FROM privacy_settings WHERE user_id = $1', [userId]);
    if (!shares?.show_online_status) return;
    const peers = await this.chatPeers(userId);
    const { rows } = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM privacy_settings WHERE user_id = ANY($1::uuid[]) AND show_online_status',
      [peers],
    );
    await this.bus.publish(
      rows.map((r) => r.user_id),
      { type: 'presence', data: { userId, online, lastSeenAt: online ? null : new Date().toISOString() } },
    );
  }

  /**
   * Account deletion: the user's sent messages are wiped for everyone (as if deleted for
   * everyone) and their reactions removed. Memberships stay, shown as "Deleted account",
   * so the other person keeps their side of the history. Returns media ids to release after commit.
   */
  async scrubUser(userId: string, tx: PoolClient): Promise<string[]> {
    const media = await this.db.query<{ media_id: string }>(
      'SELECT DISTINCT media_id FROM messages WHERE sender_id = $1 AND media_id IS NOT NULL',
      [userId],
      tx,
    );
    const convs = await this.db.query<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id FROM messages WHERE sender_id = $1 AND deleted_at IS NULL
       UNION SELECT DISTINCT m.conversation_id FROM message_reactions r JOIN messages m ON m.id = r.message_id WHERE r.user_id = $1`,
      [userId],
      tx,
    );
    for (const { conversation_id } of convs.rows) {
      await this.db.query(
        `WITH s AS (
           SELECT m.id, row_number() OVER (ORDER BY m.seq) AS rn FROM messages m
            WHERE m.conversation_id = $1 AND ((m.sender_id = $2 AND m.deleted_at IS NULL)
               OR EXISTS (SELECT 1 FROM message_reactions r WHERE r.message_id = m.id AND r.user_id = $2))),
         c AS (UPDATE conversations SET last_seq = last_seq + (SELECT count(*) FROM s) WHERE id = $1 RETURNING last_seq)
         UPDATE messages m SET change_seq = (SELECT last_seq FROM c) - (SELECT count(*) FROM s) + s.rn,
           body = CASE WHEN m.sender_id = $2 THEN '' ELSE m.body END,
           media_id = CASE WHEN m.sender_id = $2 THEN NULL ELSE m.media_id END,
           attachment = CASE WHEN m.sender_id = $2 THEN NULL ELSE m.attachment END,
           mentions = CASE WHEN m.sender_id = $2 THEN '{}' ELSE m.mentions END,
           pinned_at = CASE WHEN m.sender_id = $2 THEN NULL ELSE m.pinned_at END,
           deleted_at = CASE WHEN m.sender_id = $2 THEN now() ELSE m.deleted_at END
         FROM s WHERE m.id = s.id`,
        [conversation_id, userId],
        tx,
      );
    }
    await this.db.query('DELETE FROM message_reactions WHERE user_id = $1', [userId], tx);
    return media.rows.map((r) => r.media_id);
  }

  /** Everything this user sent, for the data export. */
  async exportFor(userId: string) {
    const { rows } = await this.db.query(
      `SELECT id, conversation_id, kind, body, media_id, created_at, edited_at, deleted_at FROM messages WHERE sender_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows;
  }

  // ---------------------------------------------------------------- internals

  async members(conversationId: string, db?: Queryable) {
    const { rows } = await this.db.query<MemberRow>(
      `SELECT cm.user_id, u.username, u.display_name, u.state, u.avatar_media_id, cm.role, cm.joined_at, cm.last_delivered_seq, cm.last_read_seq, p.show_read_receipts
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id LEFT JOIN privacy_settings p ON p.user_id = cm.user_id
        WHERE cm.conversation_id = $1 ORDER BY cm.joined_at, cm.user_id`,
      [conversationId],
      db,
    );
    return rows;
  }

  private memberDto(m: MemberRow, viewer: MemberRow | undefined) {
    const readVisible = viewer?.user_id === m.user_id || (m.show_read_receipts !== false && viewer?.show_read_receipts !== false);
    return {
      userId: m.user_id,
      username: m.username,
      displayName: m.state === 'deleted' ? 'Deleted account' : m.display_name,
      avatarMediaId: m.avatar_media_id,
      role: m.role,
      lastDeliveredSeq: Number(m.last_delivered_seq),
      lastReadSeq: readVisible ? Number(m.last_read_seq) : null,
    };
  }

  private async requireMember(userId: string, conversationId: string, db?: Queryable) {
    const ok = await this.db.one('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId], db);
    if (!ok) throw Errors.notFound('Conversation');
  }

  /** Takes the conversation's next counter value. Holds the row lock until the transaction ends. */
  async nextSeq(conversationId: string, tx: Queryable): Promise<number> {
    const r = await this.db.one<{ last_seq: string }>('UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq', [conversationId], tx);
    return Number(r!.last_seq);
  }

  /**
   * Calls follow the rules for direct messages: no blocks either way, the other person's
   * account is live, and their "who can message me" setting. Returns the other person's id.
   */
  async assertCanCall(userId: string, conversationId: string, tx: Queryable): Promise<string> {
    const members = await this.members(conversationId, tx);
    if (!members.some((m) => m.user_id === userId)) throw Errors.notFound('Conversation');
    const c = await this.db.one<{ kind: string }>('SELECT kind FROM conversations WHERE id = $1', [conversationId], tx);
    if (c!.kind !== 'direct') throw Errors.conflict('group_calls_unsupported', 'Group calls are not available yet');
    try {
      await this.assertCanSend(userId, conversationId, members, tx);
    } catch (err) {
      if (err instanceof AppError && err.code === 'cannot_message') throw new AppError(HttpStatus.FORBIDDEN, 'cannot_call', 'You can’t call this person');
      throw err;
    }
    return members.find((m) => m.user_id !== userId)!.user_id;
  }

  /** Direct chats only: a block between two people in a group doesn't stop the group. */
  private async assertNotBlocked(userId: string, conversationId: string, db: Queryable) {
    const blocked = await this.db.one(
      `SELECT 1 FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id JOIN blocks b
           ON (b.blocker_id = $2 AND b.blocked_id = cm.user_id) OR (b.blocker_id = cm.user_id AND b.blocked_id = $2)
        WHERE c.id = $1 AND c.kind = 'direct' AND cm.user_id <> $2 LIMIT 1`,
      [conversationId, userId],
      db,
    );
    if (blocked) throw cannotMessage();
  }

  /**
   * Blocks in either direction stop messages. The recipient's "who can message me" setting
   * applies until they have replied in this chat: "nobody" and "contacts" both refuse new
   * chats from strangers (there is no contact list yet, so "contacts" means people you replied to).
   */
  private async assertCanSend(userId: string, conversationId: string, members: MemberRow[], tx: Queryable) {
    const c = await this.db.one<{ kind: string; send_policy: GroupPolicy }>('SELECT kind, send_policy FROM conversations WHERE id = $1', [conversationId], tx);
    if (c!.kind === 'group') {
      const me = members.find((m) => m.user_id === userId)!;
      if (c!.send_policy === 'admins' && me.role === 'member') {
        throw new AppError(HttpStatus.FORBIDDEN, 'admins_only', 'Only admins can send messages in this group');
      }
      return;
    }
    await this.assertNotBlocked(userId, conversationId, tx);
    for (const other of members.filter((m) => m.user_id !== userId)) {
      if (other.state === 'deleted') throw cannotMessage();
      const p = await this.db.one<{ who_can_message: string }>('SELECT who_can_message FROM privacy_settings WHERE user_id = $1', [other.user_id], tx);
      if (!p || p.who_can_message === 'everyone') continue;
      const replied = await this.db.one('SELECT 1 FROM messages WHERE conversation_id = $1 AND sender_id = $2 LIMIT 1', [conversationId, other.user_id], tx);
      if (!replied) throw cannotMessage();
    }
  }

  private async validateContent(userId: string, conversationId: string, input: SendInput, members: MemberRow[], mediaPreauthorised: boolean, tx: Queryable) {
    const extras = { poll: !!input.poll, location: !!input.location, contact: !!input.contactUserId };
    for (const [k, present] of Object.entries(extras)) {
      if (present && input.kind !== k) throw Errors.validation([{ path: k === 'contact' ? 'contactUserId' : k, message: `Only a ${k} message carries this` }]);
    }
    if (input.viewOnce && input.kind !== 'image' && input.kind !== 'video') {
      throw Errors.validation([{ path: 'viewOnce', message: 'Only photos and videos can be view once' }]);
    }
    if (input.kind === 'text' || input.kind === 'poll' || input.kind === 'location' || input.kind === 'contact') {
      if (input.mediaId) throw Errors.validation([{ path: 'mediaId', message: `A ${input.kind} message cannot carry media` }]);
    }
    if (input.kind === 'text') {
      if (!input.body.trim()) throw Errors.validation([{ path: 'body', message: 'A text message cannot be empty' }]);
    } else if (input.kind === 'poll') {
      if (!input.poll) throw Errors.validation([{ path: 'poll', message: 'A poll needs its options' }]);
      input.body = input.body.trim();
      if (!input.body || input.body.length > MAX_POLL_QUESTION) {
        throw Errors.validation([{ path: 'body', message: `Ask a question of 1 to ${MAX_POLL_QUESTION} characters` }]);
      }
    } else if (input.kind === 'location') {
      if (!input.location) throw Errors.validation([{ path: 'location', message: 'A location message needs a place' }]);
      if (input.body) throw Errors.validation([{ path: 'body', message: 'Put the place name in location.label' }]);
    } else if (input.kind === 'contact') {
      if (!input.contactUserId) throw Errors.validation([{ path: 'contactUserId', message: 'Choose whose contact to share' }]);
      if (input.body) throw Errors.validation([{ path: 'body', message: 'A contact card has no text' }]);
      const ok = await this.db.one(
        `SELECT 1 FROM users u WHERE u.id = $2 AND u.state = 'active' AND NOT blocked_either_way($1, u.id)`,
        [userId, input.contactUserId],
        tx,
      );
      if (!ok) throw Errors.notFound('User');
    } else {
      if (!input.mediaId) throw Errors.validation([{ path: 'mediaId', message: `A ${input.kind} message needs a mediaId` }]);
      const m = mediaPreauthorised
        ? await this.db.one<{ kind: string; state: string }>('SELECT kind, state FROM media WHERE id = $1', [input.mediaId], tx)
        : await this.media.requireAttachable(userId, input.mediaId, tx);
      if (!m || m.state !== 'ready') throw Errors.notFound('Media');
      if (m.kind !== input.kind) throw Errors.validation([{ path: 'kind', message: `Media is ${m.kind}, not ${input.kind}` }]);
    }
    if (input.replyToId) {
      const r = await this.db.one('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [input.replyToId, conversationId], tx);
      if (!r) throw Errors.validation([{ path: 'replyToId', message: 'You can only reply to a message in this chat' }]);
    }
    const memberIds = new Set(members.map((m) => m.user_id));
    if (input.mentions.some((id) => !memberIds.has(id))) {
      throw Errors.validation([{ path: 'mentions', message: 'You can only mention people in this chat' }]);
    }
  }

  private async findByClientId(userId: string, conversationId: string, clientId: string) {
    const r = await this.db.one<MessageRow>(`${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.sender_id = $3 AND m.client_id = $4`, [
      NO_VIEWER,
      conversationId,
      userId,
      clientId,
    ]);
    return r ? messageDto(r) : null;
  }

  async loadOne(viewerId: string, messageId: string, db?: Queryable) {
    const r = await this.db.one<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $2`, [viewerId, messageId], db);
    return r ? messageDto(r) : null;
  }

  private async requireVisibleMessage(userId: string, messageId: string, db?: Queryable) {
    const m = await this.db.one<{
      id: string;
      conversation_id: string;
      sender_id: string;
      kind: MessageKind;
      body: string;
      media_id: string | null;
      deleted_at: Date | null;
      pinned_at: Date | null;
      created_at: Date;
      view_once: boolean;
      attachment: Record<string, unknown> | null;
    }>(
      `SELECT m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.media_id, m.deleted_at, m.pinned_at, m.created_at, m.view_once, m.attachment
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
        WHERE m.id = $1 AND m.seq > cm.visible_from_seq`,
      [messageId, userId],
      db,
    );
    if (!m) throw Errors.notFound('Message');
    return m;
  }

  /** Locks the message's conversation, takes the next counter value, applies fn, then broadcasts. */
  private async mutate(
    userId: string,
    messageId: string,
    fn: (m: Awaited<ReturnType<MessagingService['requireVisibleMessage']>>, tx: PoolClient, seq: number) => Promise<void>,
  ) {
    const conversationId = await this.db.tx(async (tx) => {
      const m = await this.requireVisibleMessage(userId, messageId, tx);
      const seq = await this.nextSeq(m.conversation_id, tx);
      // Re-read under the lock so concurrent edits and deletes see each other.
      const locked = (await this.requireVisibleMessage(userId, messageId, tx))!;
      await fn(locked, tx, seq);
      const changed = await this.db.one('SELECT 1 FROM messages WHERE id = $1 AND change_seq = $2', [messageId, seq], tx);
      // Nothing changed (e.g. deleting twice): give the counter value back by rolling back.
      if (!changed) throw new NoChange(m.conversation_id);
      return m.conversation_id;
    }).catch((err) => {
      if (err instanceof NoChange) return null;
      throw err;
    });
    const dto = (await this.loadOne(NO_VIEWER, messageId))!;
    if (conversationId) await this.publishToMembers(conversationId, { type: 'message.updated', data: dto });
    return dto;
  }

  async publishToMembers(conversationId: string, event: { type: string; data: unknown }) {
    const members = await this.members(conversationId);
    await this.bus.publish(
      members.map((m) => m.user_id),
      event,
    );
  }
}

/** What a location or contact message stores beside its text. */
function attachmentFor(input: SendInput): string | null {
  if (input.kind === 'location' && input.location) {
    const { lat, lng, label, liveMinutes } = input.location;
    const liveUntil = liveMinutes ? new Date(Date.now() + liveMinutes * 60_000).toISOString() : null;
    return JSON.stringify({ lat, lng, label, liveUntil, updatedAt: new Date().toISOString() });
  }
  if (input.kind === 'contact' && input.contactUserId) return JSON.stringify({ userId: input.contactUserId });
  return null;
}

class NoChange extends Error {
  constructor(readonly conversationId: string) {
    super('no change');
  }
}
