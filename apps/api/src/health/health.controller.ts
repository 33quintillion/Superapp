import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up. Does not touch dependencies. */
  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Load balancers should route on this. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok';
      } catch {
        return 'unavailable';
      }
    };
    const [database, redis] = await Promise.all([check(() => this.db.query('SELECT 1')), check(() => this.redis.client.ping())]);
    const ok = database === 'ok' && redis === 'ok';
    reply.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks: { database, redis } };
  }
}
