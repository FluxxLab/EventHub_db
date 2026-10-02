import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Campaign design (2 Oct 2026): each email campaign's logo, banner, colours
 * and header and footer text. Null keeps the PIC layout, so campaigns
 * written before this read as they always did.
 */
export class CampaignDesign1790260000000 implements MigrationInterface {
  name = 'CampaignDesign1790260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "email_campaigns" ADD "design" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email_campaigns" DROP COLUMN "design"`,
    );
  }
}
