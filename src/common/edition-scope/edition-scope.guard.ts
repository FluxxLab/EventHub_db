import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { EditionAccessService } from './edition-access.service';
import {
  EDITION_SCOPE_KEY,
  type EditionSource,
} from './edition-scope.decorator';

/** The request an event organiser's handlers see: their editions attached. */
export interface ScopedRequest {
  user?: { id: string; accessTier?: AccessTier };
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Set for event organisers only; handlers of `list` routes filter by it. */
  editionScope?: string[];
}

const OUTSIDE = 'This belongs to an event you do not run';

/**
 * Keeps event organisers inside their editions. Runs after RolesGuard, so it
 * only sees routes their role is listed on, and for those it insists on an
 * @EditionScoped declaration: a route opened to the role without saying
 * where its edition comes from is refused, never waved through. Every other
 * caller is untouched.
 */
@Injectable()
export class EditionScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: EditionAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    const user = req.user;
    if (user?.accessTier !== AccessTier.EVENT_ADMIN) return true;

    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<AccessTier[] | undefined>(
      ROLES_KEY,
      targets,
    );
    // open to any signed-in account (their own profile, the app's reads): an
    // event organiser is an account like any other there
    if (!roles?.includes(AccessTier.EVENT_ADMIN)) return true;

    const sources = this.reflector.getAllAndOverride<
      EditionSource[] | undefined
    >(EDITION_SCOPE_KEY, targets);
    if (!sources?.length)
      throw new ForbiddenException('Event organisers cannot do this');

    const allowed = await this.access.editionsOf(user.id);
    req.editionScope = allowed;
    if (allowed.length === 0)
      throw new ForbiddenException('You have not been assigned an event yet');

    for (const source of sources) {
      if (source.from === 'list') return true;
      if (source.from === 'any') return true;
      let editions: string[];
      if (source.from === 'current') {
        const current = await this.access.currentEdition();
        editions = current ? [current] : [];
      } else {
        const named = source as Extract<EditionSource, { key: string }>;
        const value = EditionScopeGuard.read(req, named.from, named.key);
        if (value === undefined || value === null || value === '') continue;
        editions = await this.access.editionsFor(named.via ?? 'edition', value);
      }
      if (
        editions.length === 0 ||
        !editions.every((e) => allowed.includes(e))
      ) {
        throw new ForbiddenException(OUTSIDE);
      }
      return true;
    }
    // none of the sources named an edition: an event organiser has to say which
    throw new ForbiddenException('Choose one of your events');
  }

  /** `key` from params, query or body; `[].editionId` reads it from every item of an array body. */
  static read(
    req: ScopedRequest,
    from: 'param' | 'query' | 'body',
    key: string,
  ): unknown {
    const bag =
      from === 'param' ? req.params : from === 'query' ? req.query : req.body;
    if (key.startsWith('[].')) {
      if (!Array.isArray(bag)) return undefined;
      const field = key.slice(3);
      const values = bag.map((item: unknown) =>
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)[field]
          : undefined,
      );
      // every item must name the same edition, or the request is refused as a whole
      return values.every((v) => v === values[0]) ? values[0] : '__mixed__';
    }
    if (!bag || typeof bag !== 'object') return undefined;
    return (bag as Record<string, unknown>)[key];
  }
}
