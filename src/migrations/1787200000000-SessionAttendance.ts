import { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionAttendance1787200000000 implements MigrationInterface {
  name = 'SessionAttendance1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "session_attendance" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "delegateId" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_session_attendance" PRIMARY KEY ("id")
      )
    `);

    // the unique pair is what makes recordAttendance idempotent - a delegate
    // rejoining a session's room must not write a second row
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_attendance_pair" ON "session_attendance" ("delegateId", "sessionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_attendance_delegate" ON "session_attendance" ("delegateId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_attendance_delegate"`);
    await queryRunner.query(`DROP INDEX "idx_attendance_pair"`);
    await queryRunner.query(`DROP TABLE "session_attendance"`);
  }
}
