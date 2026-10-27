import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService, Queryable } from '../database/database.service';
import { MessagingService, NO_VIEWER } from '../messaging/messaging.service';
import { PushService } from '../push/push.service';
import { RealtimeBus } from '../realtime/realtime-bus.service';

export type CallMedia = 'audio' | 'video';
export type CallState = 'ringing' | 'accepted' | 'connected' | 'ended';
export type EndReason = 'completed' | 'cancelled' | 'missed' | 'declined' | 'busy' | 'failed' | 'connection_lost';

/** WebRTC session descriptions and ICE candidates, relayed as-is between the two devices. */
export type Signal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null };

interface CallRow {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  media: CallMedia;
  state: CallState;
  end_reason: EndReason | null;
  ended_by: string | null;
  caller_conn: string;
  callee_conn: string | null;
  caller_lost_at: Date | null;
  callee_lost_at: Date | null;
  created_at: Date;
  answered_at: Date | null;
  connected_at: Date | null;
  ended_at: Date | null;
}

function callDto(c: CallRow) {
  return {
    id: c.id,
    conversationId: c.conversation_id,
    callerId: c.caller_id,
    calleeId: c.callee_id,
    media: c.media,
    state: c.state,
    endReason: c.end_reason,
    endedBy: c.ended_by,
    /** The connection each side is using; other connections of the same person don't take part. */
    callerConnectionId: c.caller_conn,
    calleeConnectionId: c.callee_conn,
    /** True while that side's device has dropped off and may still come back. */
    callerReconnecting: !!c.caller_lost_at,
    calleeReconnecting: !!c.callee_lost_at,
    createdAt: c.created_at,
    answeredAt: c.answered_at,
    connectedAt: c.connected_at,
    endedAt: c.ended_at,
    durationSeconds: durationSeconds(c),
  };
}
export type CallDto = ReturnType<typeof callDto>;

function durationSeconds(c: Pick<CallRow, 'connected_at' | 'ended_at'>) {
  if (!c.connected_at) return 0;
  const end = c.ended_at ?? new Date();
  return Math.max(0, Math.round((end.getTime() - c.connected_at.getTime()) / 1000));
}

/** Outcomes the callee never picked up: they get a missed-call notification. */
const MISSED: EndReason[] = ['missed', 'cancelled', 'busy'];

/** One SELECT for every call read. */
const CALL_COLUMNS = `id, conversation_id, caller_id, callee_id, media, state, end_reason, ended_by, caller_conn, callee_conn,
  caller_lost_at, callee_lost_at, created_at, answered_at, connected_at, ended_at`;

/**
 * One-to-one call state and signalling. Media never touches the server: the two devices
 * exchange WebRTC offers, answers and ICE candidates through here, then connect directly
 * or through TURN. Every transition is a single conditional UPDATE, so two devices (or
 * two API instances) racing to accept, hang up or time out a call cannot both win.
 *
 *   ringing ──accept──▶ accepted ──media up──▶ connected
 *      │                   │                      │
 *      └───────────────────┴──────────────────────┴──▶ ended (reason)
 */
@Injectable()
export class CallsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Calls');
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly bus: RealtimeBus,
    private readonly messaging: MessagingService,
    private readonly push: PushService,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.CALL_SWEEP_INTERVAL_MS;
    if (!every) return;
    this.timer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = this.sweep()
        .then(() => undefined)
        .catch((e) => this.logger.warn(`call sweep failed: ${(e as Error).message}`))
        .finally(() => (this.sweeping = null));
    }, every);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.sweeping;
  }

  // ---------------------------------------------------------------- transitions

  /**
   * Starts ringing the other person in a direct chat. If they are already on a call, the
   * call ends at once as "busy" (and they get a missed-call notice), like a phone line.
   */
  async start(userId: string, connectionId: string, conversationId: string, media: CallMedia) {
    await this.limits.consume({ name: 'calls:start', limit: 20, windowSeconds: 600 }, userId);
    const out = await this.db.tx(async (tx) => {
      const calleeId = await this.messaging.assertCanCall(userId, conversationId, tx);
      // Two people calling each other at the same moment: lock both lines in a fixed order
      // so one call wins cleanly instead of the two transactions deadlocking.
      for (const id of [userId, calleeId].sort()) await this.db.query(`SELECT pg_advisory_xact_lock(hashtextextended('call_line:' || $1, 0))`, [id], tx);
      const call = (await this.db.one<CallRow>(
        `INSERT INTO calls (conversation_id, caller_id, callee_id, media, caller_conn) VALUES ($1, $2, $3, $4, $5) RETURNING ${CALL_COLUMNS}`,
        [conversationId, userId, calleeId, media, connectionId],
        tx,
      ))!;
      const mine = await this.db.one('INSERT INTO call_lines (user_id, call_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [userId, call.id], tx);
      if (!mine) throw Errors.conflict('already_in_call', 'You are already on a call');
      const theirs = await this.db.one('INSERT INTO call_lines (user_id, call_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [calleeId, call.id], tx);
      if (theirs) return { call, ended: [] };
      return { call, ended: await this.endIn(tx, 'id = $1', [call.id], `'busy'`, null) };
    });
    await this.announce(out.ended);
    if (out.ended.length) return callDto(out.ended[0]!.call);
    await this.publish(out.call);
    return callDto(out.call);
  }

  /** The callee answers on this connection. Their other devices stop ringing. */
  async accept(userId: string, connectionId: string, callId: string) {
    const row = await this.db.one<CallRow>(
      `UPDATE calls SET state = 'accepted', answered_at = now(), callee_conn = $3
        WHERE id = $1 AND callee_id = $2 AND state = 'ringing' RETURNING ${CALL_COLUMNS}`,
      [callId, userId, connectionId],
    );
    if (!row) {
      await this.require(userId, callId);
      throw Errors.conflict('call_not_ringing', 'This call is no longer ringing');
    }
    await this.publish(row);
    return callDto(row);
  }

  async decline(userId: string, callId: string) {
    const ended = await this.db.tx((tx) => this.endIn(tx, `id = $1 AND callee_id = $2 AND state = 'ringing'`, [callId, userId], `'declined'`, userId));
    if (!ended.length) {
      await this.require(userId, callId);
      throw Errors.conflict('call_not_ringing', 'This call is no longer ringing');
    }
    await this.announce(ended);
    return callDto(ended[0]!.call);
  }

  /**
   * Either side hangs up, from any of their devices. `failed` means the device gave up
   * because media could not connect or broke and could not be restored.
   */
  async hangup(userId: string, callId: string, failed = false) {
    const reason = `CASE WHEN $3 THEN 'failed'
                         WHEN state = 'connected' THEN 'completed'
                         WHEN state = 'ringing' AND callee_id = $2 THEN 'declined'
                         ELSE 'cancelled' END`;
    const ended = await this.db.tx((tx) => this.endIn(tx, `id = $1 AND (caller_id = $2 OR callee_id = $2)`, [callId, userId, failed], reason, userId));
    if (!ended.length) {
      const c = await this.require(userId, callId);
      return callDto(c); // already over: hanging up twice is harmless
    }
    await this.announce(ended);
    return callDto(ended[0]!.call);
  }

  /** A device reports that media is flowing. The first report starts the call's clock. */
  async connected(userId: string, connectionId: string, callId: string) {
    const row = await this.db.one<CallRow>(
      `UPDATE calls SET state = 'connected', connected_at = now()
        WHERE id = $1 AND state = 'accepted'
          AND ((caller_id = $2 AND caller_conn = $3) OR (callee_id = $2 AND callee_conn = $3))
        RETURNING ${CALL_COLUMNS}`,
      [callId, userId, connectionId],
    );
    if (row) {
      await this.publish(row);
      return callDto(row);
    }
    return callDto(await this.require(userId, callId));
  }

  /** Relays an offer, answer or ICE candidate to the other side's device in the call. */
  async signal(userId: string, connectionId: string, callId: string, signal: Signal) {
    const c = await this.require(userId, callId);
    const caller = c.caller_id === userId;
    const mine = caller ? c.caller_conn : c.callee_conn;
    if ((c.state !== 'accepted' && c.state !== 'connected') || mine !== connectionId) {
      throw Errors.conflict('call_not_active', 'This device is not in an active call');
    }
    await this.limits.consume({ name: 'calls:signal', limit: 600, windowSeconds: 60 }, userId);
    const to = caller ? c.callee_id : c.caller_id;
    const toConn = caller ? c.callee_conn! : c.caller_conn;
    await this.bus.publish([to], { type: 'call.signal', connectionId: toConn, data: { callId, from: userId, signal } });
    return { relayed: true };
  }

  /**
   * After a dropped connection comes back (a new WebSocket), the device takes its place in
   * the call again. The caller then restarts ICE to rebuild the media path.
   */
  async resume(userId: string, connectionId: string, callId: string) {
    const row = await this.db.one<CallRow>(
      `UPDATE calls SET
         caller_conn = CASE WHEN caller_id = $2 THEN $3 ELSE caller_conn END,
         caller_lost_at = CASE WHEN caller_id = $2 THEN NULL ELSE caller_lost_at END,
         callee_conn = CASE WHEN callee_id = $2 THEN $3 ELSE callee_conn END,
         callee_lost_at = CASE WHEN callee_id = $2 THEN NULL ELSE callee_lost_at END
        WHERE id = $1 AND state <> 'ended' AND (caller_id = $2 OR (callee_id = $2 AND state <> 'ringing'))
        RETURNING ${CALL_COLUMNS}`,
      [callId, userId, connectionId],
    );
    if (!row) {
      const c = await this.require(userId, callId);
      throw Errors.conflict(c.state === 'ended' ? 'call_ended' : 'call_not_active', c.state === 'ended' ? 'This call has ended' : 'This device is not in the call');
    }
    await this.publish(row);
    return callDto(row);
  }

  /** A realtime connection closed: if it carried a call, the call waits for it to come back. */
  async connectionClosed(userId: string, connectionId: string) {
    const { rows } = await this.db.query<CallRow>(
      `UPDATE calls SET
         caller_lost_at = CASE WHEN caller_id = $1 AND caller_conn = $2 THEN now() ELSE caller_lost_at END,
         callee_lost_at = CASE WHEN callee_id = $1 AND callee_conn = $2 THEN now() ELSE callee_lost_at END
        WHERE state <> 'ended' AND ((caller_id = $1 AND caller_conn = $2) OR (callee_id = $1 AND callee_conn = $2))
        RETURNING ${CALL_COLUMNS}`,
      [userId, connectionId],
    );
    for (const r of rows) await this.publish(r);
  }

  /** Ends calls that rang out, never connected, or lost a device for too long. Safe on every instance at once. */
  async sweep() {
    const c = this.config;
    const ended = await this.db.tx((tx) =>
      this.endIn(
        tx,
        `(state = 'ringing' AND created_at < now() - make_interval(secs => $1))
          OR (state = 'accepted' AND answered_at < now() - make_interval(secs => $2))
          OR caller_lost_at < now() - make_interval(secs => $3)
          OR callee_lost_at < now() - make_interval(secs => $3)`,
        [c.CALL_RING_SECONDS, c.CALL_CONNECT_SECONDS, c.CALL_RECONNECT_GRACE_SECONDS],
        `CASE WHEN caller_lost_at < now() - make_interval(secs => $3) OR callee_lost_at < now() - make_interval(secs => $3)
                THEN CASE WHEN state = 'ringing' THEN 'cancelled' ELSE 'connection_lost' END
              WHEN state = 'ringing' THEN 'missed'
              ELSE 'failed' END`,
        null,
      ),
    );
    await this.announce(ended);
    return ended.map((e) => callDto(e.call));
  }

  // ---------------------------------------------------------------- reads

  /** The call this user is on or being rung for, so a device that (re)connects can show it. */
  async active(userId: string) {
    const c = await this.db.one<CallRow>(
      `SELECT ${CALL_COLUMNS} FROM calls WHERE id = (SELECT call_id FROM call_lines WHERE user_id = $1) AND state <> 'ended'`,
      [userId],
    );
    return { call: c ? callDto(c) : null };
  }

  async get(userId: string, callId: string) {
    return callDto(await this.require(userId, callId));
  }

  /** Call history, newest first. */
  async history(userId: string, opts: { limit: number; cursor?: string }) {
    const params: unknown[] = [userId, opts.limit + 1];
    let cursorSql = '';
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      cursorSql = 'AND (c.created_at, c.id) < ($3::timestamptz, $4::uuid)';
    }
    const { rows } = await this.db.query<CallRow & { peer_id: string; peer_username: string | null; peer_name: string; peer_state: string }>(
      `SELECT c.${CALL_COLUMNS.replace(/,\s*/g, ', c.')}, p.id AS peer_id, p.username AS peer_username, p.display_name AS peer_name, p.state AS peer_state
         FROM calls c JOIN users p ON p.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
        WHERE (c.caller_id = $1 OR c.callee_id = $1) ${cursorSql}
        ORDER BY c.created_at DESC, c.id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      calls: page.map((r) => ({
        ...callDto(r),
        direction: r.caller_id === userId ? ('outgoing' as const) : ('incoming' as const),
        peer: { id: r.peer_id, username: r.peer_state === 'deleted' ? null : r.peer_username, displayName: r.peer_state === 'deleted' ? 'Deleted account' : r.peer_name },
      })),
      nextCursor: rows.length > opts.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  // ---------------------------------------------------------------- internals

  private async require(userId: string, callId: string, db?: Queryable) {
    const c = await this.db.one<CallRow>(`SELECT ${CALL_COLUMNS} FROM calls WHERE id = $1 AND (caller_id = $2 OR callee_id = $2)`, [callId, userId], db);
    if (!c) throw Errors.notFound('Call');
    return c;
  }

  /**
   * Ends every live call matching `where`, in one statement, then frees both people's lines
   * and records the outcome in the chat ("Missed voice call"). The callee gets a push
   * notification for calls they never picked up. `reasonSql` sees the row as it was.
   */
  private async endIn(tx: PoolClient, where: string, params: unknown[], reasonSql: string, endedBy: string | null) {
    const p = [...params, endedBy];
    const { rows } = await this.db.query<CallRow>(
      `UPDATE calls SET state = 'ended', end_reason = ${reasonSql}, ended_at = now(), ended_by = $${p.length}::uuid
        WHERE state <> 'ended' AND (${where}) RETURNING ${CALL_COLUMNS}`,
      p,
      tx,
    );
    const out: { call: CallRow; messageId: string; notify: boolean }[] = [];
    for (const call of rows) {
      await this.db.query('DELETE FROM call_lines WHERE call_id = $1', [call.id], tx);
      const seq = await this.messaging.nextSeq(call.conversation_id, tx);
      const event = { type: 'call', callId: call.id, media: call.media, outcome: call.end_reason, durationSeconds: durationSeconds(call) };
      const msg = await this.db.one<{ id: string }>(
        `INSERT INTO messages (conversation_id, seq, change_seq, sender_id, client_id, kind, system_event)
         VALUES ($1, $2, $2, $3, $4, 'system', $5) RETURNING id`,
        [call.conversation_id, seq, call.caller_id, `call_${randomBytes(12).toString('hex')}`, JSON.stringify(event)],
        tx,
      );
      await this.db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [call.conversation_id], tx);
      // The caller has seen their own call notice.
      await this.db.query(
        `UPDATE conversation_members SET last_delivered_seq = $3, last_read_seq = $3, updated_at = now() WHERE conversation_id = $1 AND user_id = $2`,
        [call.conversation_id, call.caller_id, seq],
        tx,
      );
      const notify = MISSED.includes(call.end_reason!) && !call.answered_at;
      if (notify) await this.push.enqueueMessage(tx, call.conversation_id, msg!.id, call.caller_id);
      out.push({ call, messageId: msg!.id, notify });
    }
    return out;
  }

  /** After commit: both people's devices learn the outcome, and the chat gets the notice. */
  private async announce(ended: { call: CallRow; messageId: string; notify: boolean }[]) {
    if (ended.some((e) => e.notify)) this.push.kick();
    for (const e of ended) {
      await this.publish(e.call);
      const message = await this.messaging.loadOne(NO_VIEWER, e.messageId);
      if (message) await this.messaging.publishToMembers(e.call.conversation_id, { type: 'message.created', data: message });
    }
  }

  private async publish(c: CallRow) {
    await this.bus.publish([c.caller_id, c.callee_id], { type: 'call.updated', data: callDto(c) });
  }
}
