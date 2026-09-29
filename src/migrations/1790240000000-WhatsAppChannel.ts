import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Announcements on WhatsApp (27 Sep 2026): a delegate's opt-in, with when
 * they gave it, and a flag on each announcement sent that way too.
 */
export class WhatsAppChannel1790240000000 implements MigrationInterface {
  name = 'WhatsAppChannel1790240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "whatsappOptIn" boolean NOT NULL DEFAULT false, ADD "whatsappOptInAt" timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD "whatsapp" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "whatsapp"`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN "whatsappOptInAt", DROP COLUMN "whatsappOptIn"`,
    );
  }
}
