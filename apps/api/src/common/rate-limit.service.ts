import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { RedisService } from '../redis/redis.service';
import { Errors } from './errors';

export interface RateRule {
  /** Logical bucket name, e.g. "login:ip". */
  name: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Fixed-window counters in Redis, shared by every API instance. Callers pick the
 * key (IP, account, or both) so abuse of one account from many IPs is also caught.
 */
@Injectable()
export class RateLimitService {
  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async consume(rule: RateRule, key: string): Promise<void> {
    if (this.config.RATE_LIMIT_DISABLED) return;
    const window = Math.floor(Date.now() / 1000 / rule.windowSeconds);
    const redisKey = `rl:${rule.name}:${key}:${window}`;
    const [[, count]] = (await this.redis.client.multi().incr(redisKey).expire(redisKey, rule.windowSeconds).exec()) as [
      [Error | null, number],
    ];
    if (count > rule.limit) {
      const retryAfter = rule.windowSeconds - (Math.floor(Date.now() / 1000) % rule.windowSeconds);
      throw Errors.rateLimited(retryAfter);
    }
  }
}
