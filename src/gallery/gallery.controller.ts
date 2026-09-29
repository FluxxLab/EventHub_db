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
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import {
  AddPhotosDto,
  GalleryUploadDto,
  SaveAlbumDto,
  UpdateAlbumDto,
  UpdatePhotoDto,
} from './dto/gallery.dto';
import { GalleryService } from './gallery.service';

/** Organisers see albums they have not published yet; everyone else only published ones. */
const organiser = (user: AuthUser) =>
  user.role === AccessTier.ADMIN || user.role === AccessTier.EVENT_ADMIN;

@ApiTags('gallery')
@ApiBearerAuth()
@Controller()
export class GalleryController {
  constructor(private readonly gallery: GalleryService) {}

  /* --------------------------------------------------------------- app */

  @Get('editions/:id/gallery')
  @ApiOperation({
    summary: "An edition's published albums, with a cover and a photo count",
  })
  albums(@Param('id', ParseUUIDPipe) id: string) {
    return this.gallery.list(id, false);
  }

  @Get('gallery/albums/:id')
  @ApiOperation({
    summary:
      'An album and its photos, each with signed links to the original and a small copy',
  })
  album(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.gallery.photosOf(id, organiser(user));
  }

  /* ------------------------------------------------------- organisers */

  @Get('editions/:id/gallery/manage')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Every album of the edition, published or not' })
  manage(@Param('id', ParseUUIDPipe) id: string) {
    return this.gallery.list(id, true);
  }

  @Post('editions/:id/gallery/upload-url')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'Signed URL for one photo (JPEG, PNG or WebP, up to 15 MB): PUT the file, then add its key to an album',
  })
  uploadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GalleryUploadDto,
  ) {
    return this.gallery.presignPhoto(id, dto.contentType, dto.contentLength);
  }

  @Post('editions/:id/gallery/albums')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({
    type: 'gallery_album_created',
    description: 'Gallery album created',
  })
  @ApiOperation({ summary: 'Create an album' })
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveAlbumDto) {
    return this.gallery.create(id, dto);
  }

  @Patch('gallery/albums/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'galleryAlbum' })
  @ApiOperation({
    summary: 'Rename, describe, publish or hide an album, or choose its cover',
  })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAlbumDto) {
    return this.gallery.update(id, dto);
  }

  @Delete('gallery/albums/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'galleryAlbum' })
  @Audit({
    type: 'gallery_album_deleted',
    description: 'Gallery album deleted with its photos',
  })
  @ApiOperation({ summary: 'Delete an album with its photos and their files' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.gallery.remove(id);
  }

  @Post('gallery/albums/:id/photos')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'galleryAlbum' })
  @ApiOperation({
    summary: 'Add uploaded photos to an album (up to 50 per call)',
  })
  addPhotos(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddPhotosDto) {
    return this.gallery.addPhotos(id, dto);
  }

  @Patch('gallery/photos/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'galleryPhoto' })
  @ApiOperation({ summary: 'Caption or reorder a photo' })
  updatePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePhotoDto,
  ) {
    return this.gallery.updatePhoto(id, dto);
  }

  @Delete('gallery/photos/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'galleryPhoto' })
  @ApiOperation({ summary: 'Delete a photo and its files' })
  async removePhoto(@Param('id', ParseUUIDPipe) id: string) {
    await this.gallery.removePhoto(id);
  }
}
