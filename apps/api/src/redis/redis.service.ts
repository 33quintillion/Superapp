import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  }

  /** After every module's onModuleDestroy, so sockets can still clean up while closing. */
  async onApplicationShutdown() {
    await this.client.quit().catch(() => undefined);
  }
}
