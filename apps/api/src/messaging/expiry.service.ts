import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { MessagingService } from './messaging.service';

/** Removes disappearing messages once their time is up, on a timer. Safe on several instances. */
@Injectable()
export class ExpiryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Expiry');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly messaging: MessagingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.DISAPPEAR_SWEEP_INTERVAL_SECONDS;
    if (!every) return;
    this.timer = setInterval(() => void this.tick(), every * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.messaging.sweepExpired();
      if (n) this.logger.log(`removed ${n} disappearing messages`);
    } catch (e) {
      this.logger.warn(`disappearing sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
