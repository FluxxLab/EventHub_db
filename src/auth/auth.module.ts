import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from './entities/refresh-token.entity';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { DelegateModule } from '../delegate/delegate.module';
import { JwtStrategy } from './strategies/jwt.stategies';
import { SessionsGateway } from '../sessions/sessions.gateway';
import { OtpService } from './otp.service';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import { NotificationsModule } from '../notifications/notifications.module';
import { SessionsModule } from '../sessions/sessions.module';
@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshToken]),
    DelegateModule,
    NotificationsModule,
    // SessionsGateway is provided here (it needs JwtModule for the handshake),
    // so its SessionsService dependency has to resolve in this module too.
    SessionsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<number>('JWT_EXPIRES_IN'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    SessionsGateway,
    OtpService,
    GoogleIdTokenVerifier,
  ],
  exports: [JwtModule, OtpService],
})
export class AuthModule {}
