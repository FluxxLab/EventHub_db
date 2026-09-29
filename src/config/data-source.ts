import 'dotenv/config';
import { DataSource } from 'typeorm';

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  // One transaction per migration rather than one around the whole run.
  // Two migrations add enum values, which Postgres will not do inside a
  // transaction on every version, so they declare `transaction = false`;
  // TypeORM 1.x refuses that override under the default "all" mode and the
  // deploy's migration step fails before it starts.
  migrationsTransactionMode: 'each',
});
