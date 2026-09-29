import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { SecurityService } from '../security/security.service';
import { AUDIT_KEY } from './decorators/audit.decorator';
import type { AuditMeta } from './decorators/audit.decorator';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: SecurityService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(
      AUDIT_KEY,
      context.getHandler(),
    );
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(
      tap(() => {
        void this.service.record({
          ...meta,
          actorId: req.user?.id ?? null,
          metadata: { params: req.params, body: this.scrub(req.body) },
        });
      }),
    );
  }

  private scrub(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object') return {};
    // secrets are destructured out so they never reach the audit log
    const {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      password,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      passwordHash,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      token,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      refreshToken,
      ...safe
    } = body as Record<string, unknown>;
    return safe;
  }
}
