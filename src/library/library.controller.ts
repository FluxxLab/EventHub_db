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
import { Audit } from '../common/decorators/audit.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import {
  LibraryUploadDto,
  SaveLibraryItemDto,
  UpdateLibraryItemDto,
} from './library.dto';
import { LibraryService } from './library.service';

@ApiTags('library')
@ApiBearerAuth()
@Controller()
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('editions/:id/library')
  @ApiOperation({
    summary:
      "The app's learning library: published resources, session materials and the Purple Book",
  })
  view(@Param('id', ParseUUIDPipe) id: string) {
    return this.library.library(id);
  }

  @Get('editions/:id/library/manage')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Every resource of the edition, published or not' })
  manage(@Param('id', ParseUUIDPipe) id: string) {
    return this.library.manage(id);
  }

  @Post('editions/:id/library/upload-url')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'Signed URL for a resource file (PDF, Word, PowerPoint, Excel, MP3 or M4A; up to 100 MB)',
  })
  uploadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LibraryUploadDto,
  ) {
    return this.library.presignFile(id, dto.contentType, dto.contentLength);
  }

  @Post('editions/:id/library')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({
    type: 'library_item_created',
    description: 'Learning resource added',
  })
  @ApiOperation({ summary: 'Add a resource: an uploaded file or a link' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveLibraryItemDto,
  ) {
    return this.library.create(id, dto);
  }

  @Patch('library/items/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'libraryItem' })
  @ApiOperation({ summary: 'Edit, reorder, publish or hide a resource' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLibraryItemDto,
  ) {
    return this.library.update(id, dto);
  }

  @Delete('library/items/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'libraryItem' })
  @Audit({
    type: 'library_item_deleted',
    description: 'Learning resource deleted',
  })
  @ApiOperation({ summary: 'Delete a resource (and its file)' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.library.remove(id);
  }
}
