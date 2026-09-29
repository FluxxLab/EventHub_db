import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Certificate artwork is an image: pdfkit places it as the page. */
export const CERTIFICATE_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;

export class CertificateUploadDto {
  @ApiProperty({ enum: CERTIFICATE_CONTENT_TYPES, example: 'image/png' })
  @IsIn(CERTIFICATE_CONTENT_TYPES)
  contentType: string;
}

export class TextPlacementDto {
  @ApiProperty({ minimum: 0, maximum: 1, example: 0.5 })
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;

  @ApiProperty({ minimum: 0, maximum: 1, example: 0.52 })
  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;

  @ApiProperty({
    description: 'Font size as a fraction of the page height',
    example: 0.06,
  })
  @IsNumber()
  @Min(0.01)
  @Max(0.3)
  size: number;

  @ApiProperty({
    description: 'Widest the text may run, as a fraction of the page width',
    example: 0.7,
  })
  @IsNumber()
  @Min(0.05)
  @Max(1)
  maxWidth: number;

  @ApiProperty({ example: '#002d74' })
  @Matches(/^#[0-9a-f]{6}$/i, {
    message: 'color must be a hex colour like #002d74',
  })
  color: string;

  @ApiProperty({ enum: ['sans', 'serif'] })
  @IsIn(['sans', 'serif'])
  font: 'sans' | 'serif';

  @ApiProperty()
  @IsBoolean()
  bold: boolean;

  @ApiProperty({ enum: ['left', 'center', 'right'] })
  @IsIn(['left', 'center', 'right'])
  align: 'left' | 'center' | 'right';
}

export class SaveCertificateTemplateDto {
  @ApiProperty({
    description: 'The key returned by the certificate upload URL',
    example: 'certificates/6f1c…',
  })
  @IsString()
  // Only artwork uploaded for certificates: never a pointer at some other stored object.
  @Matches(/^certificates\/[0-9a-f-]{36}$/, {
    message: 'key must come from the certificate upload',
  })
  key: string;

  @ApiProperty({ enum: CERTIFICATE_CONTENT_TYPES })
  @IsIn(CERTIFICATE_CONTENT_TYPES)
  contentType: 'image/png' | 'image/jpeg';

  @ApiProperty({ description: 'Artwork width in pixels' })
  @IsInt()
  @Min(100)
  @Max(20000)
  width: number;

  @ApiProperty({ description: 'Artwork height in pixels' })
  @IsInt()
  @Min(100)
  @Max(20000)
  height: number;

  @ApiProperty({ type: TextPlacementDto })
  @ValidateNested()
  @Type(() => TextPlacementDto)
  name: TextPlacementDto;

  @ApiPropertyOptional({
    type: TextPlacementDto,
    nullable: true,
    description: 'Null leaves the code off the artwork',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => TextPlacementDto)
  code?: TextPlacementDto | null;
}
