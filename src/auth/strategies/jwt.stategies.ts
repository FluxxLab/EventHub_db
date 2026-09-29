import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { REDIS } from '../../common/redis/redis.module';
import { Redis } from 'ioredis';

export interface AuthUser {
  id: string;
  role: AccessTier;
  jti: string;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(REDIS)
    private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: {
    sub: string;
    role: AccessTier;
    jti: string;
    exp: number;
    typ?: string;
  }) {
    /**
     * a refresh token must never work as an access token
     */
    if (payload.typ) throw new UnauthorizedException(); // access tokens have no typ; refresh & pass do

    return {
      id: payload.sub,
      role: payload.role,
      accessTier: payload.role,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
