import * as bcrypt from 'bcrypt';
import dataSource from '../config/data-source';
import { AccessTier, Delegate } from '../delegate/entities/delegate.entity';

async function run() {
  await dataSource.initialize();
  const repo = dataSource.getRepository(Delegate);

  const email = 'admin@pic.gs26';
  if (await repo.findOneBy({ email })) {
    console.log('admin already exist');
  } else {
    await repo.save(
      repo.create({
        email,
        passwordHash: await bcrypt.hash('ChangeMe_2026!', 12),
        name: 'GS-26 admin',
        accessTier: AccessTier.ADMIN,
      }),
    );
    console.log('admin seeded:', email);
  }
  await dataSource.destroy();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
