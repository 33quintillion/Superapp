import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Controller, HttpCode, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Post, UseGuards } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { AppError } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { ReceiptBody, SendBody } from '../messaging/messaging.schemas';
import { MessagingService } from '../messaging/messaging.service';
import { RedisService } from '../redis/redis.service';
import { CallsService } from '../calls/calls.service';
import { RealtimeBus, RealtimeEvent } from './realtime-bus.service';

export const REALTIME_PATH = '/v1/realtime';
const TICKET_TTL_SECONDS = 60;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Frames a client may send per 10 s before it is disconnected. */
const FRAME_BUDGET = 200;

export const CloseCodes = { sessionEnded: 4401, tooManyFrames: 4429, slowConsumer: 4408, shutdown: 1001 } as const;

const ticketKey = (t: string) => `rt:ticket:${createHash('sha256').update(t).digest('hex')}`;

const ref = z.string().max(64).optional();
/** WebRTC SDP and ICE candidates, relayed untouched; bounded so a frame stays small. */
const CallSignal = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(32_000) }).strict(),
  z
    .object({
      kind: z.literal('candidate'),
      // null marks the end of candidates.
      candidate: z
        .object({
          candidate: z.string().max(1024),
          sdpMid: z.string().max(64).nullish(),
          sdpMLineIndex: z.number().int().min(0).max(64).nullish(),
          usernameFragment: z.string().max(256).nullish(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
]);
const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), ref }),
  z.object({ type: z.literal('send'), ref, conversationId: z.uuid(), message: SendBody }),
  ReceiptBody.extend({ type: z.literal('receipt'), ref, conversationId: z.uuid() }),
  z.object({ type: z.literal('typing'), conversationId: z.uuid(), typing: z.boolean() }),
  z.object({ type: z.literal('call.start'), ref, conversationId: z.uuid(), media: z.enum(['audio', 'video']) }),
  z.object({ type: z.literal('call.accept'), ref, callId: z.uuid() }),
  z.object({ type: z.literal('call.decline'), ref, callId: z.uuid() }),
  z.object({ type: z.literal('call.hangup'), ref, callId: z.uuid(), failed: z.boolean().optional() }),
  z.object({ type: z.literal('call.connected'), ref, callId: z.uuid() }),
  z.object({ type: z.literal('call.resume'), ref, callId: z.uuid() }),
  z.object({ type: z.literal('call.signal'), ref, callId: z.uuid(), signal: CallSignal }),
]);

interface Conn {
  id: string;
  userId: string;
  sessionId: string;
  ws: WebSocket;
  alive: boolean;
  frames: number;
  lastTyping: Map<string, number>;
  unlisten?: () => Promise<void>;
  timers: NodeJS.Timeout[];
  /** Subscription and presence setup; close handling waits for it so nothing leaks. */
  setup?: Promise<void>;
}

/**
 * Issues one-time tickets for opening a WebSocket. A ticket keeps the long-lived access
 * token out of URLs, and lets the web app's server layer (which holds the tokens in
 * httpOnly cookies) hand the browser something that is useless after 60 seconds.
 */
@Controller('v1/realtime')
@UseGuards(AuthGuard)
export class RealtimeController {
  constructor(
    private readonly redis: RedisService,
    private readonly limits: RateLimitService,
  ) {}

  @Post('tickets')
  @HttpCode(201)
  async ticket(@Auth() a: AccessClaims) {
    await this.limits.consume({ name: 'realtime:ticket', limit: 30, windowSeconds: 60 }, a.userId);
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.client.set(ticketKey(ticket), JSON.stringify(a), 'EX', TICKET_TTL_SECONDS);
    return { ticket, expiresIn: TICKET_TTL_SECONDS, path: REALTIME_PATH };
  }
}

/**
 * The WebSocket endpoint. Client → server frames: ping, send, receipt, typing, and the
 * call frames (call.start, call.accept, call.decline, call.hangup, call.connected,
 * call.resume, call.signal). Server → client frames: ready, pong, ack, error, and events
 * (message.created, message.updated, message.hidden, receipt, typing, presence,
 * conversation.updated, call.updated, call.signal). See docs/realtime.md and docs/calls.md.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Realtime');
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly conns = new Set<Conn>();
  /** Close handlers still running (presence updates), awaited on shutdown. */
  private readonly closing = new Set<Promise<void>>();
  private server?: Server;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void this.upgrade(req, socket, head);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
    private readonly bus: RealtimeBus,
    private readonly messaging: MessagingService,
    private readonly calls: CallsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.onUpgrade);
  }

  get connectionCount() {
    return this.conns.size;
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== REALTIME_PATH) return reject(404, 'Not Found');
      if (!this.originAllowed(req.headers.origin)) return reject(403, 'Forbidden');
      const ticket = url.searchParams.get('ticket') ?? '';
      const raw = ticket ? await this.redis.client.getdel(ticketKey(ticket)) : null;
      const claims = raw ? (JSON.parse(raw) as AccessClaims) : null;
      if (!claims || !(await this.sessionValid(claims))) return reject(401, 'Unauthorized');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, claims));
    } catch (err) {
      this.logger.warn(`upgrade failed: ${(err as Error).message}`);
      reject(500, 'Internal Server Error');
    }
  }

  /** Browsers always send Origin; native apps and servers usually don't. */
  private originAllowed(origin: string | undefined) {
    if (!origin) return true;
    const allowed = this.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    return allowed.includes(origin);
  }

  private async sessionValid(c: AccessClaims) {
    return !!(await this.db.one(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.state = 'active'`,
      [c.sessionId, c.userId],
    ));
  }

  private accept(ws: WebSocket, claims: AccessClaims) {
    const conn: Conn = { id: randomUUID(), userId: claims.userId, sessionId: claims.sessionId, ws, alive: true, frames: 0, lastTyping: new Map(), timers: [] };
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => void this.onFrame(conn, data.toString(), isBinary));
    ws.on('close', () => this.track(this.closed(conn)));
    ws.on('error', () => ws.terminate());
    conn.timers.push(
      setInterval(() => {
        if (!conn.alive) return ws.terminate();
        conn.alive = false;
        ws.ping();
        void this.bus.connectionAlive(conn.userId, conn.id).catch(() => undefined);
      }, this.config.WS_HEARTBEAT_SECONDS * 1000),
      setInterval(() => {
        this.sessionValid(conn)
          .then((ok) => {
            if (!ok) ws.close(CloseCodes.sessionEnded, 'session_ended');
          })
          .catch(() => undefined); // database blip: check again next time
      }, this.config.WS_SESSION_RECHECK_SECONDS * 1000),
      setInterval(() => (conn.frames = 0), 10_000),
    );
    conn.setup = (async () => {
      conn.unlisten = await this.bus.listen(conn.userId, (e) => this.push(conn, e));
      const cameOnline = await this.bus.connectionUp(conn.userId, conn.id);
      if (cameOnline) await this.messaging.announcePresence(conn.userId, true);
      if (ws.readyState === WebSocket.OPEN) {
        this.write(conn, { type: 'ready', data: { connectionId: conn.id, userId: conn.userId, heartbeatSeconds: this.config.WS_HEARTBEAT_SECONDS } });
      }
    })();
    conn.setup.catch((err) => {
      this.logger.warn(`connection setup failed: ${(err as Error).message}`);
      ws.close(1011, 'setup_failed');
    });
  }

  private push(conn: Conn, e: RealtimeEvent) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    if (e.connectionId) {
      if (e.connectionId !== conn.id) return;
      e = { type: e.type, data: e.data };
    }
    // A client that cannot keep up is dropped; it will resync from the change feed.
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) return conn.ws.close(CloseCodes.slowConsumer, 'slow_consumer');
    this.write(conn, e);
  }

  private write(conn: Conn, frame: object) {
    conn.ws.send(JSON.stringify(frame));
  }

  private async onFrame(conn: Conn, raw: string, isBinary: boolean) {
    conn.frames += 1;
    if (conn.frames > FRAME_BUDGET) return conn.ws.close(CloseCodes.tooManyFrames, 'too_many_frames');
    let refId: string | undefined;
    try {
      if (isBinary) throw new AppError(400, 'bad_frame', 'Frames must be JSON text');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AppError(400, 'bad_frame', 'Frames must be JSON text');
      }
      refId = typeof (json as { ref?: unknown })?.ref === 'string' ? (json as { ref: string }).ref.slice(0, 64) : undefined;
      const parsed = ClientFrame.safeParse(json);
      if (!parsed.success) {
        throw new AppError(400, 'validation_failed', 'Frame validation failed', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      }
      const f = parsed.data;
      switch (f.type) {
        case 'ping':
          return this.write(conn, { type: 'pong', ref: f.ref });
        case 'send': {
          const r = await this.messaging.send(conn.userId, f.conversationId, f.message);
          return this.write(conn, { type: 'ack', ref: f.ref, data: r });
        }
        case 'receipt': {
          const r = await this.messaging.markReceipt(conn.userId, f.conversationId, f.kind, f.seq);
          return this.write(conn, { type: 'ack', ref: f.ref, data: r });
        }
        case 'typing': {
          // At most one "typing" per chat every 2 s per connection; "stopped" always goes through.
          const now = Date.now();
          if (f.typing && now - (conn.lastTyping.get(f.conversationId) ?? 0) < 2000) return;
          conn.lastTyping.set(f.conversationId, now);
          return await this.messaging.typing(conn.userId, f.conversationId, f.typing);
        }
        case 'call.start':
          return this.write(conn, { type: 'ack', ref: f.ref, data: await this.calls.start(conn.userId, conn.id, f.conversationId, f.media) });
        case 'call.accept':
          return this.write(conn, { type: 'ack', ref: f.ref, data: await this.calls.accept(conn.userId, conn.id, f.callId) });
        case 'call.decline':
          return this.write(conn, { type: 'ack', ref: f.ref, data: await this.calls.decline(conn.userId, f.callId) });
        case 'call.hangup':
          return this.write(conn, { type: 'ack', ref: f.ref, data: await this.calls.hangup(conn.userId, f.callId, f.failed ?? false) });
        case 'call.connected':
          return this.write(conn, { type: 'ack', ref: f.ref, data: await this.calls.connected(conn.userId, conn.id, f.callId) });
        case 'call.resume':
          return this.write(conn, { type: 'ack', ref: f.ref, data: await this.calls.resume(conn.userId, conn.id, f.callId) });
        case 'call.signal': {
          const r = await this.calls.signal(conn.userId, conn.id, f.callId, f.signal);
          // Candidates are fire-and-forget; only acknowledge when the client asked (ref).
          if (f.ref) this.write(conn, { type: 'ack', ref: f.ref, data: r });
          return;
        }
      }
    } catch (err) {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      if (err instanceof AppError) return this.write(conn, { type: 'error', ref: refId, error: { code: err.code, message: err.message, details: err.details } });
      this.logger.error({ err }, 'realtime frame failed');
      this.write(conn, { type: 'error', ref: refId, error: { code: 'internal_error', message: 'Something went wrong' } });
    }
  }

  private track(p: Promise<void>) {
    this.closing.add(p);
    void p.finally(() => this.closing.delete(p));
  }

  private async closed(conn: Conn) {
    if (!this.conns.delete(conn)) return;
    conn.timers.forEach(clearInterval);
    await conn.setup?.catch(() => undefined);
    await conn.unlisten?.();
    // A call on this connection now waits for the device to come back (or times out).
    await this.calls.connectionClosed(conn.userId, conn.id).catch((err) => this.logger.warn(`call cleanup failed: ${(err as Error).message}`));
    try {
      if (await this.bus.connectionDown(conn.userId, conn.id)) await this.messaging.announcePresence(conn.userId, false);
    } catch {
      // Shutting down; presence entries expire on their own.
    }
  }

  async onModuleDestroy() {
    this.server?.off('upgrade', this.onUpgrade);
    const all = [...this.conns];
    for (const c of all) c.ws.close(CloseCodes.shutdown, 'server_shutdown');
    await Promise.all([...all.map((c) => this.closed(c)), ...this.closing]);
    this.wss.close();
  }
}
