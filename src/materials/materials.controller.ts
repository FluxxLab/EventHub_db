import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CreateMaterialDto, UpdateMaterialDto } from './dto/materials.dto';
import { MaterialsService } from './materials.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/**
 * Session materials: slides, papers, communiques and links attached to a
 * session (post-summit report, XV.3). Files are uploaded through the existing
 * POST /documents/upload-url and referenced here by key.
 */
@ApiTags('materials')
@ApiBearerAuth()
@Controller()
export class MaterialsController {
  constructor(private readonly service: MaterialsService) {}

  @Get('sessions/:sessionId/materials')
  @ApiOperation({
    summary: 'Materials attached to a session, in display order',
  })
  list(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.service.list(sessionId);
  }

  @Post('sessions/:sessionId/materials')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'sessionId', via: 'session' })
  @ApiOperation({ summary: 'Attach a material to a session' })
  create(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: CreateMaterialDto,
  ) {
    return this.service.create(sessionId, dto);
  }

  @Patch('materials/:id')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'material' })
  @ApiOperation({ summary: 'Edit a material: title, url, kind, size, order' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMaterialDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete('materials/:id')
  @Roles(AccessTier.ADMIN, AccessTier.SESSION_ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'material' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a material' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
