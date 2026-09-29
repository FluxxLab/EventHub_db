/**
 * Seed the delegate directory in one go, or purge what was seeded.
 *
 *   pnpm seed:delegates -- --count 120           # insert now
 *   pnpm seed:delegates -- --count 120 --dry-run  # print a sample, touch nothing
 *   pnpm seed:delegates -- --purge                # remove every seeded delegate
 *
 * For a slow trickle that looks like real registrations, set
 * SEED_DELEGATES_TARGET (and optionally SEED_DELEGATES_INTERVAL_MIN) on the
 * API instead - see src/delegate/seed/delegate-seed.service.ts.
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import dataSource from '../src/config/data-source';
import { Delegate } from '../src/delegate/entities/delegate.entity';
import { generate } from '../src/delegate/seed/delegate-seed.data';

// ---------------------------------------------------------------- cli
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const count = Number(value('count', '100'));

  if (flag('dry-run')) {
    const rows = generate(count);
    console.table(
      rows
        .slice(0, 15)
        .map(({ name, title, organisation, country, accessTier, email }) => ({
          name,
          title,
          organisation,
          country,
          accessTier,
          email,
        })),
    );
    console.log(`${rows.length} delegates generated; nothing written.`);
    return;
  }

  await dataSource.initialize();
  const repo = dataSource.getRepository(Delegate);

  // A row is seeded if it was ever marked as such - `hasChosenPassword`
  // false is the current marker, but a row written before that column
  // existed still carries the old `seed` tag and never will have either
  // marker updated retroactively, so both are checked everywhere this
  // matters. Without this a redeploy that changes the marker would orphan
  // every row seeded under the previous one: invisible to --purge, and
  // silently recounted as "not yet seeded" by the trickle service.
  //
  // Accounts made for a ticket someone else bought (tag `ticket-holder`) and
  // accounts created through Google sign-in (`googleSub` set) also have no
  // chosen password. They are real people: never count or purge them as seed
  // rows. Same condition as DelegateSeedService.tick().
  const isSeeded = `("hasChosenPassword" = false AND "googleSub" IS NULL AND NOT ('ticket-holder' = ANY(tags))) OR 'seed' = ANY(tags)`;

  if (flag('purge')) {
    const { affected } = await repo
      .createQueryBuilder()
      .delete()
      .where(isSeeded)
      .execute();
    console.log(`purged ${affected ?? 0} seeded delegate(s)`);
    await dataSource.destroy();
    return;
  }

  const existingSeeded = await repo
    .createQueryBuilder('d')
    .select('d.name')
    .where(isSeeded)
    .getMany();
  // a roster name any earlier run already used - this script before, or the
  // trickle service - must never be handed out again; generate() has no
  // memory of its own between process runs, so this is the only thing
  // stopping two separate runs picking the same real registrant twice
  const rows = generate(count, new Set(existingSeeded.map((d) => d.name)));
  // one unguessable secret for the batch - these accounts are scenery, not logins
  const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
  const entities = rows.map((r) =>
    repo.create({
      ...r,
      passwordHash,
      hasChosenPassword: false,
      pendingReview: false,
      consentAt: new Date(),
      phone: null,
      avatarUrl: null,
    }),
  );
  await repo.save(entities, { chunk: 50 });
  console.log(
    `inserted ${entities.length} seeded delegate(s); ${existingSeeded.length} were already there. Purge with --purge.`,
  );
  await dataSource.destroy();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
