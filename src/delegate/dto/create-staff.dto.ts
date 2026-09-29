import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { STAFF_ROLES, type StaffRole } from '../entities/set-admin.dto';

/**
 * A staff login created by an admin, straight into its role. Staff are not
 * delegates: nobody on the capture desk should have to register in the app,
 * wait for a code and then be promoted before they can sit down.
 */
export class CreateStaffDto {
  @ApiProperty({ example: 'Amaka Obi' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'amaka@policycentre.org' })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'At least 8 characters; they can change it later',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @ApiProperty({
    enum: STAFF_ROLES,
    description:
      "'admin' for the whole console, 'event_admin' for the events in editionIds only, 'session_admin' for the Capture tab only",
  })
  @IsIn(STAFF_ROLES)
  role: StaffRole;

  /** The editions an event organiser runs. Required for 'event_admin', ignored otherwise. */
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  editionIds?: string[];
}
