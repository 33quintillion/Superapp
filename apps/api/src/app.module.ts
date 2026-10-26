import { DynamicModule, Global, Module } from '@nestjs/common';
import { AuthController, SessionsController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { TokenService } from './auth/token.service';
import { AuditService } from './common/audit.service';
import { RateLimitService } from './common/rate-limit.service';
import { APP_CONFIG, AppConfig } from './config/config';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { MailService } from './mail/mail.service';
import { RedisService } from './redis/redis.service';
import { SafetyController } from './safety/safety.controller';
import { SafetyService } from './safety/safety.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { MessagingController } from './messaging/messaging.controller';
import { MessagingService } from './messaging/messaging.service';
import { RealtimeBus } from './realtime/realtime-bus.service';
import { RealtimeController, RealtimeGateway } from './realtime/realtime.gateway';
import { PushController } from './push/push.controller';
import { PushProviders } from './push/push.providers';
import { PushService } from './push/push.service';
import { PushWorker } from './push/push.worker';
import { StorageService } from './storage/storage.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Global()
@Module({})
export class AppModule {
  static forConfig(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        SessionsController,
        UsersController,
        SafetyController,
        MessagingController,
        MediaController,
        RealtimeController,
        PushController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        DatabaseService,
        RedisService,
        RateLimitService,
        AuditService,
        MailService,
        TokenService,
        AuthGuard,
        AuthService,
        UsersService,
        SafetyService,
        StorageService,
        MediaService,
        RealtimeBus,
        PushProviders,
        PushService,
        PushWorker,
        MessagingService,
        RealtimeGateway,
      ],
      exports: [APP_CONFIG, DatabaseService, RedisService, RateLimitService, AuditService, SafetyService],
    };
  }
}
