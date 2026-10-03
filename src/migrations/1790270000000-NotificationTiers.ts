import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification tiers (3 Oct 2026): an announcement can go to holders of
 * chosen ticket tiers of its event. Empty is everyone at the event, which is
 * what every earlier announcement was.
 */
export class NotificationTiers1790270000000 implements MigrationInterface {
  name = 'NotificationTiers1790270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD "ticketTypeIds" uuid[] NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "ticketTypeIds"`,
    );
  }
}
