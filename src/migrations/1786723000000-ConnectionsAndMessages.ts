import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConnectionsAndMessages1786723000000 implements MigrationInterface {
  name = 'ConnectionsAndMessages1786723000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "delegate_connections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fromDelegateId" character varying NOT NULL, "toDelegateId" character varying NOT NULL, "mutual" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_connection_pair" UNIQUE ("fromDelegateId", "toDelegateId"), CONSTRAINT "PK_delegate_connections_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_connection_to" ON "delegate_connections" ("toDelegateId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "direct_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "pairKey" character varying(74) NOT NULL, "senderId" character varying NOT NULL, "recipientId" character varying NOT NULL, "body" text NOT NULL, "readAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_direct_messages_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_dm_pair" ON "direct_messages" ("pairKey", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_dm_sender" ON "direct_messages" ("senderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_dm_recipient" ON "direct_messages" ("recipientId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_dm_recipient"`);
    await queryRunner.query(`DROP INDEX "idx_dm_sender"`);
    await queryRunner.query(`DROP INDEX "idx_dm_pair"`);
    await queryRunner.query(`DROP TABLE "direct_messages"`);
    await queryRunner.query(`DROP INDEX "idx_connection_to"`);
    await queryRunner.query(`DROP TABLE "delegate_connections"`);
  }
}
