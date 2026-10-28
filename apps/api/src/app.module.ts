import { DynamicModule, Global, Module } from '@nestjs/common';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { BookingsService } from './business/bookings.service';
import { BusinessController } from './business/business.controller';
import { BusinessesService } from './business/businesses.service';
import { OrdersService } from './business/orders.service';
import { IntegrationsController } from './integrations/integrations.controller';
import { LedgerService } from './payments/ledger';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { DisputesService } from './payments/disputes.service';
import { ReconciliationService } from './payments/reconciliation.service';
import { SubscriptionsService } from './payments/subscriptions.service';
import { IntegrationsService } from './integrations/integrations.service';
import { CallsController } from './calls/calls.controller';
import { CallsService } from './calls/calls.service';
import { IceService } from './calls/ice.service';
import { AuthController, SessionsController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { BreachedPasswordsService } from './auth/breached-passwords.service';
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
import { GroupsController } from './messaging/groups.controller';
import { GroupsService } from './messaging/groups.service';
import { RealtimeBus } from './realtime/realtime-bus.service';
import { RealtimeController, RealtimeGateway } from './realtime/realtime.gateway';
import { PushController } from './push/push.controller';
import { PushProviders } from './push/push.providers';
import { PushService } from './push/push.service';
import { PushWorker } from './push/push.worker';
import { CommunitiesService } from './social/communities.service';
import { FollowsService } from './social/follows.service';
import { PostsService } from './social/posts.service';
import { SocialController } from './social/social.controller';
import { StoriesService } from './social/stories.service';
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
        GroupsController,
        MediaController,
        RealtimeController,
        PushController,
        SocialController,
        CallsController,
        BusinessController,
        IntegrationsController,
        AdminController,
        PaymentsController,
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
        BreachedPasswordsService,
        UsersService,
        SafetyService,
        StorageService,
        MediaService,
        RealtimeBus,
        PushProviders,
        PushService,
        PushWorker,
        MessagingService,
        GroupsService,
        FollowsService,
        PostsService,
        StoriesService,
        CommunitiesService,
        IceService,
        CallsService,
        BusinessesService,
        LedgerService,
        PaymentsService,
        SubscriptionsService,
        DisputesService,
        ReconciliationService,
        OrdersService,
        BookingsService,
        IntegrationsService,
        AdminService,
        RealtimeGateway,
      ],
      exports: [APP_CONFIG, DatabaseService, RedisService, RateLimitService, AuditService, SafetyService],
    };
  }
}
