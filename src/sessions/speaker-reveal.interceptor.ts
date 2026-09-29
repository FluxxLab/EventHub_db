import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, mergeMap } from 'rxjs';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { SessionsService } from './sessions.service';

/**
 * Withholds speaker identities from every response, until they are revealed.
 *
 * This was originally done by calling the service's redaction helper in each
 * controller that returned sessions. That works only for as long as everyone
 * remembers: the rule was a denylist of the four endpoints that happened to
 * exist, and the next endpoint returning a session would have leaked the
 * line-up by default, silently - a leak returns data rather than throwing, so
 * nothing would have failed to tell anyone.
 *
 * Here the default is inverted. Any response containing a `speakers` array is
 * redacted on the way out, wherever it came from, and an endpoint has to leave
 * the HTTP layer entirely to escape it.
 *
 * Two things it deliberately does not cover, because they return speakers as
 * the top-level resource rather than nested in a session, and "one placeholder
 * per line-up" makes no sense for them: GET /speakers and speaker search. Both
 * return an empty list before the reveal, gated in SessionsService.
 */
@Injectable()
export class SpeakerRevealInterceptor implements NestInterceptor {
  /** Guards against a pathological or cyclic payload; real ones are 2-3 deep. */
  private static readonly MAX_DEPTH = 6;

  constructor(private readonly sessions: SessionsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<{
      user?: { role?: AccessTier };
    }>();
    // event organisers build programmes too, so they see the line-up early
    const isAdmin =
      request?.user?.role === AccessTier.ADMIN ||
      request?.user?.role === AccessTier.EVENT_ADMIN;

    // `data` is typed as unknown rather than left as the handler's `any`, so
    // the walk below cannot silently dereference something untyped.
    return next.handle().pipe(
      mergeMap((data: unknown) =>
        from(
          (async (): Promise<unknown> => {
            if (isAdmin || (await this.sessions.speakersRevealed()))
              return data;
            return this.redact(data, 0);
          })(),
        ),
      ),
    );
  }

  /**
   * Rewrites `speakers` wherever it appears. Returns the input untouched when
   * nothing matched, so responses that carry no speakers are not needlessly
   * copied.
   */
  private redact(value: unknown, depth: number): unknown {
    if (depth > SpeakerRevealInterceptor.MAX_DEPTH) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const redacted = this.redact(item, depth + 1);
        if (redacted !== item) changed = true;
        return redacted;
      });
      return changed ? next : value;
    }
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date || Buffer.isBuffer(value)) return value;

    const source = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(source)) {
      if (key === 'speakers' && Array.isArray(item)) {
        // Exactly one placeholder for the whole line-up: one per speaker would
        // still publish how many there are, and "four to be announced" on a
        // panel is a fact about the line-up being withheld.
        next[key] = item.length ? [this.sessions.hiddenSpeaker()] : item;
        changed = changed || item.length > 0;
        continue;
      }
      const redacted = this.redact(item, depth + 1);
      if (redacted !== item) changed = true;
      next[key] = redacted;
    }

    return changed ? next : value;
  }
}
