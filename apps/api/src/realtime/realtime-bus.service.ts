import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';
import { RedisService } from '../redis/redis.service';

export interface RealtimeEvent {
  type: string;
  data: unknown;
}

type Listener = (e: RealtimeEvent) => void;

const channel = (userId: string) => `rt:u:${userId}`;
const presenceKey = (userId: string) => `presence:${userId}`;
const lastSeenKey = (userId: string) => `lastseen:${userId}`;

/**
 * Cross-instance fan-out over Redis pub/sub, one channel per user. Each API instance
 * subscribes only to the users that have a socket open on it. Delivery over pub/sub is
 * best-effort: clients recover anything they missed from the change feed, so nothing
 * here is the source of truth.
 */
@Injectable()
export class RealtimeBus implements OnApplicationShutdown {
  private readonly logger = new Logger('RealtimeBus');
  private sub: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private subscriber(): Redis {
    if (!this.sub) {
      this.sub = this.redis.client.duplicate();
      this.sub.on('message', (ch: string, raw: string) => {
        const set = this.listeners.get(ch.slice('rt:u:'.length));
        if (!set) return;
        let e: RealtimeEvent;
        try {
          e = JSON.parse(raw);
        } catch {
          return;
        }
        for (const fn of set) fn(e);
      });
    }
    return this.sub;
  }

  async publish(userIds: Iterable<string>, event: RealtimeEvent) {
    const payload = JSON.stringify(event);
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    try {
      const p = this.redis.client.pipeline();
      for (const id of ids) p.publish(channel(id), payload);
      await p.exec();
    } catch (err) {
      // Never fail the write that triggered the event; clients will resync.
      this.logger.warn(`publish failed: ${(err as Error).message}`);
    }
  }

  async listen(userId: string, fn: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
      await this.subscriber().subscribe(channel(userId));
    }
    set.add(fn);
    return async () => {
      const s = this.listeners.get(userId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) {
        this.listeners.delete(userId);
        await this.sub?.unsubscribe(channel(userId)).catch(() => undefined);
      }
    };
  }

  // Presence: a sorted set of live connection ids per user, scored by expiry. A crashed
  // instance's connections age out instead of leaving the user "online" forever.
  private get ttlMs() {
    return this.config.WS_HEARTBEAT_SECONDS * 3 * 1000;
  }

  /** Returns true when this connection took the user from offline to online. */
  async connectionUp(userId: string, connectionId: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.redis.client
      .multi()
      .zremrangebyscore(presenceKey(userId), '-inf', now)
      .zcard(presenceKey(userId))
      .zadd(presenceKey(userId), now + this.ttlMs, connectionId)
      .pexpire(presenceKey(userId), this.ttlMs)
      .exec();
    return (res?.[1]?.[1] as number) === 0;
  }

  async connectionAlive(userId: string, connectionId: string) {
    await this.redis.client
      .multi()
      .zadd(presenceKey(userId), Date.now() + this.ttlMs, connectionId)
      .pexpire(presenceKey(userId), this.ttlMs)
      .exec();
  }

  /** Returns true when this was the user's last live connection. */
  async connectionDown(userId: string, connectionId: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.redis.client
      .multi()
      .zrem(presenceKey(userId), connectionId)
      .zremrangebyscore(presenceKey(userId), '-inf', now)
      .zcard(presenceKey(userId))
      .exec();
    const offline = (res?.[2]?.[1] as number) === 0;
    if (offline) await this.redis.client.set(lastSeenKey(userId), new Date(now).toISOString(), 'EX', 90 * 24 * 3600);
    return offline;
  }

  async presence(userIds: string[]): Promise<Map<string, { online: boolean; lastSeenAt: string | null }>> {
    const out = new Map<string, { online: boolean; lastSeenAt: string | null }>();
    if (!userIds.length) return out;
    const now = Date.now();
    const p = this.redis.client.pipeline();
    for (const id of userIds) {
      p.zcount(presenceKey(id), now, '+inf');
      p.get(lastSeenKey(id));
    }
    const res = (await p.exec()) ?? [];
    userIds.forEach((id, i) => {
      out.set(id, { online: (res[i * 2]?.[1] as number) > 0, lastSeenAt: (res[i * 2 + 1]?.[1] as string | null) ?? null });
    });
    return out;
  }

  /** After every module's onModuleDestroy, so sockets can still clean up while closing. */
  async onApplicationShutdown() {
    await this.sub?.quit().catch(() => undefined);
  }
}
