import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { AccessTier } from './delegate.entity';

/** The roles a staff account can hold. */
export const STAFF_ROLES = [
  AccessTier.ADMIN,
  AccessTier.EVENT_ADMIN,
  AccessTier.SESSION_ADMIN,
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export class SetAdminDto {
  @ApiProperty({ description: 'true grants access, false revokes it' })
  @IsBoolean()
  admin: boolean;

  @ApiPropertyOptional({
    description:
      "Which access to grant: 'admin' (the whole console, default), 'event_admin' (the events in editionIds) or 'session_admin' (the Capture tab only). Ignored when revoking.",
    enum: STAFF_ROLES,
  })
  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: StaffRole;

  /** An event organiser's editions; required with role 'event_admin'. */
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  editionIds?: string[];
}
