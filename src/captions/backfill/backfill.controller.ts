import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { BackfillSubmitDto, BackfillUploadDto } from './backfill.dto';
import { BackfillService } from './backfill.service';

/**
 * A capture desk's recording of what it could not stream live, uploaded later.
 * Open to the tiers that may capture captions at all (the capture:start
 * socket check): admins and session admins.
 */
@ApiTags('captions')
@ApiBearerAuth()
@Controller('captions/backfill')
export class BackfillController {
  constructor(private readonly backfill: BackfillService) {}

  @Post('upload-url')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({
    summary:
      "A presigned PUT for a desk's recording, bound to its exact size and type",
  })
  @ApiResponse({ status: 200, description: '{ url, key }' })
  uploadUrl(@Body() dto: BackfillUploadDto) {
    return this.backfill.uploadUrl(dto);
  }

  @Post()
  @HttpCode(202)
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({
    summary:
      'Caption an uploaded desk recording into the sessions it covers; one job per key',
  })
  @ApiResponse({ status: 202, description: '{ jobId }' })
  @ApiResponse({ status: 400, description: 'Not uploaded, or invalid' })
  submit(@Body() dto: BackfillSubmitDto) {
    return this.backfill.submit(dto);
  }

  @Get(':jobId')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN)
  @ApiOperation({ summary: 'How a back-fill job is getting on' })
  @ApiResponse({
    status: 200,
    description: '{ state, inserted?, skipped?, sessions?, error? }',
  })
  @ApiResponse({ status: 404, description: 'No such job (or expired)' })
  status(@Param('jobId') jobId: string) {
    if (!/^backfill-[0-9a-f-]{36}$/.test(jobId)) {
      throw new BadRequestException('Not a back-fill job id');
    }
    return this.backfill.status(jobId);
  }
}
