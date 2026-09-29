import { ApiPropertyOptional, ApiProperty, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { AccessTier } from '../entities/delegate.entity';

const GRANTABLE_TIERS = [
  AccessTier.STANDARD,
  AccessTier.VIP,
  AccessTier.VVIP,
  AccessTier.PRESS,
] as const;

export class CreateRegistrationEntryDto {
  @ApiPropertyOptional({
    description:
      'Match key: applicant email (invite code auto-generated if omitted)',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    maxLength: 255,
    description: 'Match key: printed invite code',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  inviteCode?: string;

  @ApiPropertyOptional({ maxLength: 255, description: 'Organiser label (' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 255,
    example: 'Policy Innovation Centre',
    description: 'Prefilled into sign-up; empty string clears',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organisation?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    example: 'Programme Officer',
    description: 'Job title; prefilled into sign-up; empty string clears',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @ApiProperty({ enum: GRANTABLE_TIERS })
  @IsIn(GRANTABLE_TIERS)
  assignedTier: AccessTier;
}

export class UpdateRegistrationEntryDto extends PartialType(
  CreateRegistrationEntryDto,
) {}
