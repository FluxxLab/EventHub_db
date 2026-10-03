import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ChangeTicketTierDto {
  /** Another ticket tier of the same event. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ticketTypeId: string;
}
