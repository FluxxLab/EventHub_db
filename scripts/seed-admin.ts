/**
 * Create the organiser account for the admin console, or promote an existing account to it.
 *
 *   pnpm seed:admin -- --email you@pic.org.ng --password "a-strong-password" --name "Your Name"
 *
 * The same values can come from ADMIN_EMAIL, ADMIN_PASSWORD and ADMIN_NAME instead of flags.
 * Running it again for the same email resets that account's password and keeps it an organiser,
 * so it doubles as the "I'm locked out of the console" fix. Nothing about other accounts changes.
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import dataSource from '../src/config/data-source';
import { AccessTier, Delegate } from '../src/delegate/entities/delegate.entity';

function option(name: string, env: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return (i >= 0 ? args[i + 1] : undefined) ?? process.env[env];
}

async function main() {
  const email = option('email', 'ADMIN_EMAIL')?.trim().toLowerCase();
  const password = option('password', 'ADMIN_PASSWORD');
  const name = option('name', 'ADMIN_NAME')?.trim() || 'PIC Organiser';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Pass a valid --email (or set ADMIN_EMAIL).');
  }
  // Same minimum the sign-in endpoint enforces, or the account could never sign in.
  if (!password || password.length < 8) {
    throw new Error('Pass a --password of at least 8 characters (or set ADMIN_PASSWORD).');
  }

  await dataSource.initialize();
  try {
    const repo = dataSource.getRepository(Delegate);
    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await repo.findOne({ where: { email } });

    if (existing) {
      await repo.update(existing.id, {
        accessTier: AccessTier.ADMIN,
        passwordHash,
        hasChosenPassword: true,
        pendingReview: false,
        consentAt: existing.consentAt ?? new Date(),
      });
      console.log(`Promoted ${email} to organiser and reset its password.`);
    } else {
      await repo.save(
        repo.create({
          email,
          name,
          passwordHash,
          accessTier: AccessTier.ADMIN,
          hasChosenPassword: true,
          pendingReview: false,
          consentAt: new Date(),
        }),
      );
      console.log(`Created organiser account ${email}.`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
