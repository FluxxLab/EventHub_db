import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/** Most ids one presence lookup answers; a screen asks about what it shows. */
export const PRESENCE_BATCH_MAX = 100;

export class PresenceQueryDto {
  @ApiProperty({
    type: String,
    description: `Comma-separated delegate ids, at most ${PRESENCE_BATCH_MAX}`,
    example:
      '6f1c0f6e-2d1a-4a1e-9a0e-2c7f3f0f9b21,0b8e3c55-1f7a-4a2b-8d8e-7d9b8c6f5a41',
  })
  // `?ids=a,b` and `?ids=a&ids=b` both arrive as one list, duplicates dropped
  @Transform(({ value }: { value: unknown }) => {
    const parts = (Array.isArray(value) ? value : [value])
      .filter((v): v is string => typeof v === 'string')
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    return [...new Set(parts)];
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRESENCE_BATCH_MAX)
  @IsUUID('all', { each: true })
  ids: string[];
}
