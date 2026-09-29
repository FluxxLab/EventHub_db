import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { EditionAccessService } from './edition-access.service';
import {
  EDITION_SCOPE_KEY,
  type EditionSource,
} from './edition-scope.decorator';
import { EditionScopeGuard, type ScopedRequest } from './edition-scope.guard';

const MINE = '11111111-1111-4111-8111-111111111111';
const THEIRS = '22222222-2222-4222-8222-222222222222';

function build({
  roles,
  sources,
  current = MINE,
  lookups = {},
}: {
  roles?: AccessTier[];
  sources?: EditionSource[];
  current?: string | null;
  lookups?: Record<string, string[]>;
}) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === ROLES_KEY
        ? roles
        : key === EDITION_SCOPE_KEY
          ? sources
          : undefined,
    ),
  } as unknown as Reflector;
  const editionsOf = jest.fn().mockResolvedValue([MINE]);
  const access = {
    editionsOf,
    currentEdition: jest.fn().mockResolvedValue(current),
    editionsFor: jest.fn((via: string, value: unknown) =>
      Promise.resolve(
        via === 'edition'
          ? [value as string]
          : (lookups[`${via}:${String(value)}`] ?? []),
      ),
    ),
  } as unknown as EditionAccessService;
  const guard = new EditionScopeGuard(reflector, access);
  const run = (req: ScopedRequest) =>
    guard.canActivate({
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext);
  return { run, editionsOf };
}

const organiser = { id: 'u1', accessTier: AccessTier.EVENT_ADMIN };
const OPEN = [AccessTier.ADMIN, AccessTier.EVENT_ADMIN];

describe('EditionScopeGuard', () => {
  it('leaves everyone but event organisers alone', async () => {
    const { run, editionsOf } = build({
      roles: OPEN,
      sources: [{ from: 'param', key: 'id' }],
    });
    await expect(
      run({
        user: { id: 'a', accessTier: AccessTier.ADMIN },
        params: { id: THEIRS },
      }),
    ).resolves.toBe(true);
    expect(editionsOf).not.toHaveBeenCalled();
  });

  it('lets an event organiser into their own edition and no other', async () => {
    const { run } = build({
      roles: OPEN,
      sources: [{ from: 'param', key: 'id' }],
    });
    await expect(run({ user: organiser, params: { id: MINE } })).resolves.toBe(
      true,
    );
    await expect(
      run({ user: organiser, params: { id: THEIRS } }),
    ).rejects.toThrow(
      new ForbiddenException('This belongs to an event you do not run'),
    );
  });

  it('follows a record to its edition', async () => {
    const { run } = build({
      roles: OPEN,
      sources: [{ from: 'param', key: 'id', via: 'poll' }],
      lookups: { 'poll:p1': [MINE], 'poll:p2': [THEIRS] },
    });
    await expect(run({ user: organiser, params: { id: 'p1' } })).resolves.toBe(
      true,
    );
    await expect(
      run({ user: organiser, params: { id: 'p2' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // a record that does not exist reveals nothing either
    await expect(
      run({ user: organiser, params: { id: 'nope' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a route opened to the role without saying where its edition comes from', async () => {
    const { run } = build({ roles: OPEN, sources: undefined });
    await expect(run({ user: organiser })).rejects.toThrow(
      'Event organisers cannot do this',
    );
  });

  it('passes routes not opened to the role to RolesGuard, which has already decided', async () => {
    // any signed-in account (their own profile): no scope needed
    const { run } = build({ roles: undefined, sources: undefined });
    await expect(run({ user: organiser })).resolves.toBe(true);
  });

  it('falls back through its sources, and uses the current edition for live-day tools', async () => {
    const sources: EditionSource[] = [
      { from: 'query', key: 'sessionId', via: 'session' },
      { from: 'current' },
    ];
    const ok = build({ roles: OPEN, sources, current: MINE });
    await expect(ok.run({ user: organiser, query: {} })).resolves.toBe(true);
    const elsewhere = build({ roles: OPEN, sources, current: THEIRS });
    await expect(
      elsewhere.run({ user: organiser, query: {} }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('asks an event organiser to name their event when a route needs one', async () => {
    const { run } = build({
      roles: OPEN,
      sources: [{ from: 'query', key: 'editionId' }],
    });
    await expect(run({ user: organiser, query: {} })).rejects.toThrow(
      'Choose one of your events',
    );
  });

  it('refuses a bulk body that mixes editions', async () => {
    const { run } = build({
      roles: OPEN,
      sources: [{ from: 'body', key: '[].editionId' }],
    });
    await expect(
      run({
        user: organiser,
        body: [{ editionId: MINE }, { editionId: MINE }],
      }),
    ).resolves.toBe(true);
    await expect(
      run({
        user: organiser,
        body: [{ editionId: MINE }, { editionId: THEIRS }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attaches the editions for list routes to filter by', async () => {
    const { run } = build({ roles: OPEN, sources: [{ from: 'list' }] });
    const req: ScopedRequest = { user: organiser };
    await expect(run(req)).resolves.toBe(true);
    expect(req.editionScope).toEqual([MINE]);
  });
});

/**
 * The safety net: read every controller and fail if any route lists the event
 * organiser role without an @EditionScoped next to it. The guard refuses such
 * a route at runtime anyway; this says so at build time, with its name.
 */
describe('every route open to event organisers declares its edition', () => {
  const root = join(__dirname, '..', '..');
  const controllers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.controller.ts')) controllers.push(path);
    }
  };
  walk(root);

  it('has @EditionScoped on each of them', () => {
    const missing: string[] = [];
    let opened = 0;
    for (const file of controllers) {
      const source = readFileSync(file, 'utf-8');
      // each member's decorators, up to its name
      for (const block of source.split(/\n {2}(?:async )?\w+\(/)) {
        // from the previous method's closing brace (a decorator's `})` is further indented or followed by more)
        const decorators = block.slice(block.lastIndexOf('\n  }\n') + 1);
        if (!/@Roles\([^)]*EVENT_ADMIN/.test(decorators)) continue;
        opened++;
        if (!decorators.includes('@EditionScoped('))
          missing.push(
            `${file}: ${decorators.match(/@(Get|Post|Put|Patch|Delete)\([^)]*\)/)?.[0]}`,
          );
      }
    }
    expect(missing).toEqual([]);
    expect(opened).toBeGreaterThan(50);
  });
});
