import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AvatarUploadDto } from '../delegate/dto/avatar-upload.dto';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { EditionCategory } from '../editions/entities/edition.entity';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { CatalogService } from './catalog.service';
import {
  CreateInterestDto,
  CreateTrackDto,
  UpdateCategoryDto,
  UpdateInterestDto,
  UpdateTrackDto,
} from './dto/catalog.dto';

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('catalog')
export class CatalogController {
  constructor(private readonly service: CatalogService) {}

  /**
   * Public because the app needs its labels before anyone signs in: the
   * sign-up form's gender picker and the category grid render first.
   */
  @Public()
  @Get()
  @ApiOperation({
    summary:
      'Every list the app renders: tracks, interests, genders, report reasons, caption languages, payment countries, categories',
  })
  catalog() {
    return this.service.catalog();
  }

  @Get('tracks')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  // reading the shared list is harmless; changing it stays organiser-only
  @EditionScoped({ from: 'any' })
  @ApiOperation({
    summary: 'The track library events pick from, retired ones included',
  })
  tracks() {
    return this.service.listTracks();
  }

  @Post('tracks')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Add a track to the library' })
  @ApiResponse({ status: 409, description: 'A track has that name already' })
  createTrack(@Body() dto: CreateTrackDto) {
    return this.service.createTrack(dto);
  }

  @Patch('tracks/:id')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary: 'Relabel, reorder or retire a track (value is fixed)',
  })
  updateTrack(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrackDto,
  ) {
    return this.service.updateTrack(id, dto);
  }

  @Delete('tracks/:id')
  @Roles(AccessTier.ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a track nothing is filed under' })
  @ApiResponse({ status: 409, description: 'Sessions or pitches use it' })
  async deleteTrack(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.deleteTrack(id);
  }

  @Get('interests')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  // reading the shared list is harmless; changing it stays organiser-only
  @EditionScoped({ from: 'any' })
  @ApiOperation({ summary: 'Every interest option, retired ones included' })
  interests() {
    return this.service.listInterests();
  }

  @Post('interests')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Add an interest option' })
  @ApiResponse({ status: 409, description: 'The value already exists' })
  createInterest(@Body() dto: CreateInterestDto) {
    return this.service.createInterest(dto);
  }

  @Patch('interests/:id')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({
    summary: 'Relabel, reorder or retire an interest option (value is fixed)',
  })
  updateInterest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInterestDto,
  ) {
    return this.service.updateInterest(id, dto);
  }

  @Delete('interests/:id')
  @Roles(AccessTier.ADMIN)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete an interest option; profiles that saved it keep it',
  })
  async deleteInterest(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.deleteInterest(id);
  }

  @Patch('categories/:slug')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: "Set a category tile's label, image or position" })
  updateCategory(
    @Param('slug', new ParseEnumPipe(EditionCategory)) slug: EditionCategory,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.service.updateCategory(slug, dto);
  }

  @Post('categories/:slug/image-upload')
  @Roles(AccessTier.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Signed URL for tile artwork: PUT the file, then PATCH the returned key as imageKey',
  })
  categoryImageUpload(
    // validated so a typo 400s here rather than after the upload
    @Param('slug', new ParseEnumPipe(EditionCategory)) _slug: EditionCategory,
    @Body() dto: AvatarUploadDto,
  ) {
    return this.service.presignCategoryImage(dto.contentType);
  }
}
