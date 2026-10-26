import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { RealtimeBus } from '../realtime/realtime-bus.service';
import { GroupPolicy, MessagingService, NO_VIEWER } from './messaging.service';

export const MAX_GROUP_MEMBERS = 256;

export type GroupRole = 'owner' | 'admin' | 'member';

export interface GroupPatch {
  title?: string;
  description?: string;
  sendPolicy?: GroupPolicy;
  infoPolicy?: GroupPolicy;
  addPolicy?: GroupPolicy;
}

/** What a system message records. Clients render the sentence; ids are resolved against the member list. */
export type SystemEvent =
  | { type: 'group_created'; title: string }
  | { type: 'members_added'; userIds: string[] }
  | { type: 'member_removed'; userId: string }
  | { type: 'member_left' }
  | { type: 'role_changed'; userId: string; role: GroupRole }
  | { type: 'group_updated'; fields: string[]; title?: string };

const cannotAdd = (userIds: string[]) =>
  new AppError(HttpStatus.FORBIDDEN, 'cannot_add', 'Some people can’t be added to groups by you', { userIds });

interface GroupRow {
  id: string;
  kind: string;
  send_policy: GroupPolicy;
  info_policy: GroupPolicy;
  add_policy: GroupPolicy;
}

/**
 * Group chats on top of the messaging module. Every change runs in one transaction that
 * holds the conversation row lock, writes a system message into the history, and is
 * announced after commit, so members see changes in the same order as messages.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly messaging: MessagingService,
    private readonly bus: RealtimeBus,
    private readonly limits: RateLimitService,
  ) {}

  async create(userId: string, input: { title: string; description: string; memberIds: string[] }) {
    await this.limits.consume({ name: 'group:create', limit: 20, windowSeconds: 3600 }, userId);
    const others = [...new Set(input.memberIds)].filter((id) => id !== userId);
    if (others.length + 1 > MAX_GROUP_MEMBERS) throw tooMany();
    const out = await this.db.tx(async (tx) => {
      await this.assertCanAdd(userId, others, tx);
      const c = await this.db.one<{ id: string }>(
        `INSERT INTO conversations (kind, title, description, created_by, last_message_at) VALUES ('group', $1, $2, $3, now()) RETURNING id`,
        [input.title, input.description, userId],
        tx,
      );
      await this.db.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, added_by)
         SELECT $1, u, CASE WHEN u = $2 THEN 'owner' ELSE 'member' END, $2 FROM unnest($3::uuid[]) AS u`,
        [c!.id, userId, [userId, ...others]],
        tx,
      );
      const messageId = await this.system(tx, c!.id, userId, { type: 'group_created', title: input.title });
      return { id: c!.id, messageId };
    });
    await this.announce(out.id, out.messageId);
    return this.messaging.getConversation(userId, out.id);
  }

  async update(userId: string, conversationId: string, patch: GroupPatch) {
    const fields = Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (!fields.length) return this.messaging.getConversation(userId, conversationId);
    const messageId = await this.db.tx(async (tx) => {
      const { group, role } = await this.lockGroup(userId, conversationId, tx);
      const policyChange = fields.some((f) => f.endsWith('Policy'));
      if (policyChange && role === 'member') throw Errors.forbidden('Only admins can change group permissions');
      if (group.info_policy === 'admins' && role === 'member') throw Errors.forbidden('Only admins can edit this group');
      const cols: Record<string, string> = {
        title: 'title',
        description: 'description',
        sendPolicy: 'send_policy',
        infoPolicy: 'info_policy',
        addPolicy: 'add_policy',
      };
      const entries = fields.map((f) => [cols[f], (patch as Record<string, unknown>)[f]] as const);
      await this.db.query(
        `UPDATE conversations SET ${entries.map(([c], i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [conversationId, ...entries.map(([, v]) => v)],
        tx,
      );
      return this.system(tx, conversationId, userId, { type: 'group_updated', fields, ...(patch.title !== undefined ? { title: patch.title } : {}) });
    });
    await this.announce(conversationId, messageId);
    return this.messaging.getConversation(userId, conversationId);
  }

  async addMembers(userId: string, conversationId: string, userIds: string[]) {
    const result = await this.db.tx(async (tx) => {
      const { group, role } = await this.lockGroup(userId, conversationId, tx);
      if (group.add_policy === 'admins' && role === 'member') throw Errors.forbidden('Only admins can add people to this group');
      const current = new Set((await this.messaging.members(conversationId, tx)).map((m) => m.user_id));
      const fresh = [...new Set(userIds)].filter((id) => !current.has(id));
      if (!fresh.length) return null;
      if (current.size + fresh.length > MAX_GROUP_MEMBERS) throw tooMany();
      await this.assertCanAdd(userId, fresh, tx);
      const messageId = await this.system(tx, conversationId, userId, { type: 'members_added', userIds: fresh });
      const seq = await this.seqOf(messageId, tx);
      // New members start just before the "added" notice: they see it, and nothing earlier.
      await this.db.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, added_by, visible_from_seq, last_delivered_seq, last_read_seq)
         SELECT $1, u, 'member', $2, $4, $4, $4 FROM unnest($3::uuid[]) AS u`,
        [conversationId, userId, fresh, seq - 1],
        tx,
      );
      return messageId;
    });
    if (result) await this.announce(conversationId, result);
    return this.messaging.getConversation(userId, conversationId);
  }

  async setRole(userId: string, conversationId: string, targetId: string, role: GroupRole) {
    const messageId = await this.db.tx(async (tx) => {
      const { role: myRole } = await this.lockGroup(userId, conversationId, tx);
      const target = await this.memberRole(conversationId, targetId, tx);
      if (!target) throw Errors.notFound('Member');
      if (targetId === userId) throw Errors.validation([{ path: 'userId', message: 'You cannot change your own role' }]);
      if (target === role) return null;
      if (role === 'owner') {
        if (myRole !== 'owner') throw Errors.forbidden('Only the owner can hand over the group');
        await this.setMemberRole(conversationId, userId, 'admin', tx);
      } else if (role === 'admin') {
        if (myRole === 'member') throw Errors.forbidden('Only admins can make people admins');
        if (target === 'owner') throw Errors.forbidden('The owner’s role can only change by handing over the group');
      } else {
        if (myRole !== 'owner') throw Errors.forbidden('Only the owner can remove admin rights');
      }
      await this.setMemberRole(conversationId, targetId, role, tx);
      return this.system(tx, conversationId, userId, { type: 'role_changed', userId: targetId, role });
    });
    if (messageId) await this.announce(conversationId, messageId);
    return this.messaging.getConversation(userId, conversationId);
  }

  /** Removes someone (admins), or leaves when targetId is the caller. */
  async removeMember(userId: string, conversationId: string, targetId: string) {
    const messageId = await this.db.tx(async (tx) => {
      const { role: myRole } = await this.lockGroup(userId, conversationId, tx);
      if (targetId === userId) return this.leaveLocked(tx, conversationId, userId, myRole);
      const target = await this.memberRole(conversationId, targetId, tx);
      if (!target) throw Errors.notFound('Member');
      if (myRole === 'member') throw Errors.forbidden('Only admins can remove people');
      if (target === 'owner' || (target === 'admin' && myRole !== 'owner')) throw Errors.forbidden('Only the owner can remove admins');
      const id = await this.system(tx, conversationId, userId, { type: 'member_removed', userId: targetId });
      await this.db.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, targetId], tx);
      return id;
    });
    await this.announce(conversationId, messageId);
    await this.bus.publish([targetId], { type: 'conversation.removed', data: { id: conversationId } });
  }

  /** Account deletion: leave every group inside the deletion transaction. Returns the notices to announce. */
  async leaveAll(userId: string, tx: PoolClient) {
    const { rows } = await this.db.query<{ conversation_id: string; role: GroupRole }>(
      `SELECT cm.conversation_id, cm.role FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = $1 AND c.kind = 'group' ORDER BY cm.conversation_id`,
      [userId],
      tx,
    );
    const out: { conversationId: string; messageId: string }[] = [];
    for (const r of rows) {
      await this.db.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [r.conversation_id], tx);
      out.push({ conversationId: r.conversation_id, messageId: await this.leaveLocked(tx, r.conversation_id, userId, r.role) });
    }
    return out;
  }

  /** Sends what leaveAll queued, once its transaction has committed. */
  async announceAll(items: { conversationId: string; messageId: string }[]) {
    for (const i of items) await this.announce(i.conversationId, i.messageId);
  }

  // ---------------------------------------------------------------- internals

  private async leaveLocked(tx: PoolClient, conversationId: string, userId: string, role: GroupRole) {
    const id = await this.system(tx, conversationId, userId, { type: 'member_left' });
    await this.db.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId], tx);
    if (role === 'owner') {
      // The longest-serving admin takes over, or failing that the longest-standing member.
      const next = await this.db.one<{ user_id: string }>(
        `SELECT user_id FROM conversation_members WHERE conversation_id = $1
          ORDER BY (role = 'admin') DESC, joined_at, user_id LIMIT 1`,
        [conversationId],
        tx,
      );
      if (next) {
        await this.setMemberRole(conversationId, next.user_id, 'owner', tx);
        await this.system(tx, conversationId, next.user_id, { type: 'role_changed', userId: next.user_id, role: 'owner' });
      }
    }
    return id;
  }

  /** Locks the group row, then checks the caller is a member. Not a member and not a group look the same. */
  private async lockGroup(userId: string, conversationId: string, tx: PoolClient) {
    const group = await this.db.one<GroupRow>(
      `SELECT id, kind, send_policy, info_policy, add_policy FROM conversations WHERE id = $1 AND kind = 'group' FOR UPDATE`,
      [conversationId],
      tx,
    );
    const role = group ? await this.memberRole(conversationId, userId, tx) : null;
    if (!group || !role) throw Errors.notFound('Conversation');
    return { group, role };
  }

  private async memberRole(conversationId: string, userId: string, db: Queryable) {
    const r = await this.db.one<{ role: GroupRole }>('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId], db);
    return r?.role ?? null;
  }

  private async setMemberRole(conversationId: string, userId: string, role: GroupRole, tx: Queryable) {
    await this.db.query('UPDATE conversation_members SET role = $3, updated_at = now() WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId, role], tx);
  }

  /**
   * Adding someone to a group puts it in their chat list, so it follows their settings:
   * nobody blocked either way, and "who can add me to groups" (everyone, people I follow, nobody).
   */
  private async assertCanAdd(adderId: string, userIds: string[], tx: Queryable) {
    if (!userIds.length) return;
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT u.id FROM unnest($2::uuid[]) AS t(id)
         JOIN users u ON u.id = t.id AND u.state = 'active'
         LEFT JOIN privacy_settings p ON p.user_id = u.id
        WHERE NOT blocked_either_way($1, u.id)
          AND (COALESCE(p.who_can_add_to_groups, 'everyone') = 'everyone'
               OR (p.who_can_add_to_groups = 'following' AND follows_actively(u.id, $1)))`,
      [adderId, userIds],
      tx,
    );
    const ok = new Set(rows.map((r) => r.id));
    const refused = userIds.filter((id) => !ok.has(id));
    if (refused.length) throw cannotAdd(refused);
  }

  private async system(tx: PoolClient, conversationId: string, actorId: string, event: SystemEvent) {
    const seq = await this.messaging.nextSeq(conversationId, tx);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO messages (conversation_id, seq, change_seq, sender_id, client_id, kind, system_event)
       VALUES ($1, $2, $2, $3, $4, 'system', $5) RETURNING id`,
      [conversationId, seq, actorId, `sys_${randomBytes(12).toString('hex')}`, JSON.stringify(event)],
      tx,
    );
    await this.db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId], tx);
    return row!.id;
  }

  private async seqOf(messageId: string, tx: Queryable) {
    return Number((await this.db.one<{ seq: string }>('SELECT seq FROM messages WHERE id = $1', [messageId], tx))!.seq);
  }

  /** After commit: the notice goes out like any message, and members refresh the group's details. */
  private async announce(conversationId: string, messageId: string) {
    const message = await this.messaging.loadOne(NO_VIEWER, messageId);
    if (message) await this.messaging.publishToMembers(conversationId, { type: 'message.created', data: message });
    await this.messaging.publishToMembers(conversationId, { type: 'conversation.changed', data: { id: conversationId } });
  }
}

const tooMany = () => Errors.conflict('group_full', `A group can have at most ${MAX_GROUP_MEMBERS} members`);
