import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertDocumentDto {
  @ApiProperty({ example: 'The Purple Book 2026' })
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty({
    description:
      'The `key` returned by POST /documents/upload-url, or an external https URL. Keys are signed when the document is read, so this is not required to be a URL.',
    example: 'documents/6f1c2b9e-...',
  })
  @IsString()
  @MaxLength(512)
  url: string;

  @ApiPropertyOptional({
    example: '4.2 MB',
    description: 'Shown next to the download button',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  sizeLabel?: string;
}
