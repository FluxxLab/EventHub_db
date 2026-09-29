import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RolesGuard } from './common/guards/roles.guard';
import { EditionScopeGuard } from './common/edition-scope/edition-scope.guard';
import { EditionScopeModule } from './common/edition-scope/edition-scope.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { SessionsModule } from './sessions/sessions.module';
import { SpeakerRevealInterceptor } from './sessions/speaker-reveal.interceptor';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { DelegateModule } from './delegate/delegate.module';
import { ResourcesModule } from './resources/resources.module';
import { PassModule } from './pass/pass.module';
import { EditionsModule } from './editions/editions.module';
import { validateEnv } from './config/env.validation';
import { RealtimeModule } from './common/realtime/realtime.module';
import { RedisModule } from './common/redis/redis.module';
import { VotingModule } from './voting/voting.module';
import { TriviaModule } from './trivia/trivia.module';
import { DiscussionsModule } from './discussions/discussions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditInterceptor } from './common/audit.interceptor';
import { SecurityModule } from './security/security.module';
import { AdminModule } from './admin/admin.module';
import { LiveOpsModule } from './live-ops/live-ops.module';
import { CaptionsModule } from './captions/captions.module';
import { SearchModule } from './search/search.module';
import { TicketingModule } from './ticketing/ticketing.module';
// Post-summit report (GS-26, 15 Sep 2026): the features the delegates asked for.
import { QuestionsModule } from './questions/questions.module';
import { FeedbackModule } from './feedback/feedback.module';
import { MaterialsModule } from './materials/materials.module';
import { PollsModule } from './polls/polls.module';
import { PassportModule as ExhibitionPassportModule } from './passport/passport.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ReviewsModule } from './reviews/reviews.module';
// API-managed reference data (24 Sep 2026): the lists the app used to hard-code.
import { CatalogModule } from './catalog/catalog.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { LeadsModule } from './leads/leads.module';
import { MealsModule } from './meals/meals.module';
import { GalleryModule } from './gallery/gallery.module';
import { LibraryModule } from './library/library.module';
import { ThrottleModule } from './common/throttle/throttle.module';
import { AppThrottlerGuard } from './common/throttle/app-throttler.guard';

@Module({
  imports: [
    EditionScopeModule,
    /**
     * Infrastructure
     */
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('DB_HOST'),
        port: config.getOrThrow<number>('DB_PORT'),
        username: config.getOrThrow<string>('DB_USER'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        database: config.getOrThrow<string>('DB_NAME'),
        autoLoadEntities: true,
        synchronize: false,
        /**
         * node-postgres pool, per API instance. With 2+ instances the total
         * (DB_POOL_MAX x instances) must stay under Postgres/RDS
         * max_connections, leaving room for migrations and psql.
         * A statement that runs past DB_STATEMENT_TIMEOUT_MS is cancelled by
         * Postgres rather than holding a connection while 3,000 phones wait.
         */
        extra: {
          max: config.get<number>('DB_POOL_MAX') ?? 30,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
          statement_timeout:
            config.get<number>('DB_STATEMENT_TIMEOUT_MS') ?? 10000,
        },
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
        },
      }),
    }),
    ThrottleModule,
    /**
     * Feature modules
     */
    AuthModule,
    DelegateModule,
    SessionsModule,
    RealtimeModule,
    RedisModule,
    VotingModule,
    TriviaModule,
    DiscussionsModule,
    NotificationsModule,
    SecurityModule,
    AdminModule,
    LiveOpsModule,
    CaptionsModule,
    ResourcesModule,
    PassModule,
    EditionsModule,
    SearchModule,
    TicketingModule,
    QuestionsModule,
    FeedbackModule,
    MaterialsModule,
    PollsModule,
    ExhibitionPassportModule,
    AnalyticsModule,
    ReviewsModule,
    CatalogModule,
    CampaignsModule,
    LeadsModule,
    MealsModule,
    GalleryModule,
    LibraryModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // after RolesGuard: event organisers kept to the editions they run
    { provide: APP_GUARD, useClass: EditionScopeGuard },
    // After JwtAuthGuard on purpose: it counts by req.user when there is one.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Withholds speaker identities from every response until they are
    // revealed, so a new endpoint returning a session is covered by default
    // rather than by someone remembering to redact it.
    { provide: APP_INTERCEPTOR, useClass: SpeakerRevealInterceptor },
  ],
})
export class AppModule {}
