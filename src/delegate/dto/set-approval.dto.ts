import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetApprovalDto {
  @ApiProperty({
    example: true,
    description:
      'true grants full access; false returns the delegate to the waiting screen',
  })
  @IsBoolean()
  approved: boolean;
}
