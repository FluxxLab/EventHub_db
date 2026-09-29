import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Meals (27 Sep 2026): the meals an event serves, the food counters that
 * serve them through a private scanner link, and each plate handed over.
 * The unique (meal, ticket, seat) index is what stops a second collection.
 */
export class Meals1790250000000 implements MigrationInterface {
  name = 'Meals1790250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "meals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "editionId" uuid NOT NULL,
        "name" varchar(120) NOT NULL,
        "startsAt" timestamptz NOT NULL,
        "endsAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_meals" PRIMARY KEY ("id"),
        CONSTRAINT "FK_meals_edition" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_meals_edition" ON "meals" ("editionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "meal_counters" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "editionId" uuid NOT NULL,
        "name" varchar(120) NOT NULL,
        "keyHash" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_meal_counters" PRIMARY KEY ("id"),
        CONSTRAINT "FK_meal_counters_edition" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_meal_counters_edition" ON "meal_counters" ("editionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "meal_servings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "mealId" uuid NOT NULL,
        "ticketId" uuid NOT NULL,
        "seat" integer NOT NULL DEFAULT 1,
        "counterId" uuid,
        "servedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_meal_servings" PRIMARY KEY ("id"),
        CONSTRAINT "FK_meal_servings_meal" FOREIGN KEY ("mealId") REFERENCES "meals"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_meal_servings_counter" FOREIGN KEY ("counterId") REFERENCES "meal_counters"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_meal_servings_seat" ON "meal_servings" ("mealId", "ticketId", "seat")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "meal_servings"`);
    await queryRunner.query(`DROP TABLE "meal_counters"`);
    await queryRunner.query(`DROP TABLE "meals"`);
  }
}
