import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DocumentUploadDto } from './dto/document-upload.dto';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { DelegatesService } from '../delegate/delegates.service';
import type { Response } from 'express';
import { UpsertDocumentDto } from './dto/upsert-document.dto';
import {
  CertificateUploadDto,
  SaveCertificateTemplateDto,
} from './dto/certificate-template.dto';
import { Audit } from '../common/decorators/audit.decorator';
import { PURPLE_BOOK_KEY, ResourcesService } from './resources.service';
import { ParticipationService } from './participation.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

@ApiTags('resources')
@ApiBearerAuth()
@Controller()
export class ResourcesController {
  constructor(
    private readonly service: ResourcesService,
    private readonly delegates: DelegatesService,
    private readonly participation: ParticipationService,
  ) {}

  // FR-15. Served from the database rather than a build-time constant so the
  // Purple Book can be republished without shipping a new app version.
  @Get('documents/purple-book')
  @ApiOperation({
    summary: 'The Purple Book: title, download URL and size label',
  })
  @ApiResponse({ status: 404, description: 'Not published yet' })
  purpleBook() {
    return this.service.getDocument(PURPLE_BOOK_KEY);
  }

  @Put('documents/purple-book')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Publish or replace the Purple Book' })
  setPurpleBook(@Body() dto: UpsertDocumentDto) {
    return this.service.upsertDocument(PURPLE_BOOK_KEY, dto);
  }

  @Post('documents/upload-url')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'any' })
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Signed URL for a document: PUT the file, then send the returned key as the document url',
  })
  documentUploadUrl(@Body() dto: DocumentUploadDto) {
    return this.service.presignDocument(dto.contentType);
  }

  /**
   * The participation checklist that unlocks the certificate.
   *
   * Separate from issuing so the app can show progress *before* a delegate is
   * eligible - a locked certificate with no explanation is just a dead end,
   * and the point of the checklist is to tell them what is still missing.
   */
  @Get('certificates/me/participation')
  @ApiOperation({
    summary: 'Participation checklist and whether the certificate is unlocked',
  })
  @ApiResponse({
    status: 200,
    description: 'Steps, progress and unlocked flag',
  })
  participationStatus(@CurrentUser() user: AuthUser) {
    return this.participation.statusFor(user.id);
  }

  // FR-16. Issued on first request rather than pre-generated for everyone, so a
  // certificate only exists for a delegate who actually asked for one.
  @Post('certificates/me')
  @HttpCode(200)
  @ApiOperation({
    summary: "Issue (or return) this delegate's certificate of participation",
  })
  async myCertificate(@CurrentUser() user: AuthUser) {
    const delegate = await this.delegates.getProfile(user.id);
    const cert = await this.service.issueCertificate(
      delegate.id,
      delegate.name,
    );
    return {
      code: cert.code,
      delegateName: cert.delegateName,
      issuedAt: cert.issuedAt,
    };
  }

  @Get('certificates/me.pdf')
  @ApiOperation({
    summary:
      'Download the certificate as a PDF. Issues it first if needed, so the same participation gate applies.',
  })
  @ApiResponse({ status: 200, description: 'application/pdf' })
  @ApiResponse({
    status: 403,
    description: 'Participation checklist not complete',
  })
  async certificatePdf(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const delegate = await this.delegates.getProfile(user.id);
    const pdf = await this.service.certificatePdf(delegate.id, delegate.name);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="certificate.pdf"',
    );
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  }

  @Public()
  @Get('certificates/verify/:code')
  @ApiOperation({
    summary:
      'Check a certificate code. Public: a verifier has the code, not an account',
  })
  verify(@Param('code') code: string) {
    return this.service.verifyCertificate(code);
  }

  /* ------------------------------------------------ certificate design */

  @Get('editions/:id/certificate')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      "An edition's certificate design and a short-lived URL to its artwork (null when none)",
  })
  certificateTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.certificateTemplate(id);
  }

  @Post('editions/:id/certificate/upload-url')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Signed URL for certificate artwork (PNG or JPG): PUT the file, then save the returned key with the design',
  })
  certificateUploadUrl(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() dto: CertificateUploadDto,
  ) {
    return this.service.presignCertificateArtwork(dto.contentType);
  }

  @Put('editions/:id/certificate')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @Audit({
    type: 'certificate_design_saved',
    description: 'Certificate design saved',
  })
  @ApiOperation({
    summary:
      "Save an edition's certificate design: artwork and where the name and code go. Every certificate of the edition renders on it from now on.",
  })
  saveCertificateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveCertificateTemplateDto,
  ) {
    return this.service.saveCertificateTemplate(id, dto);
  }

  @Delete('editions/:id/certificate')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @HttpCode(204)
  @Audit({
    type: 'certificate_design_removed',
    description: 'Certificate design removed',
  })
  @ApiOperation({
    summary:
      'Withdraw the design: certificates for the edition stop downloading until a new one is saved',
  })
  async removeCertificateTemplate(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.removeCertificateTemplate(id);
  }

  @Get('editions/:id/certificate/sample.pdf')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'The certificate as delegates will get it, with any name (not issued to anyone)',
  })
  async sampleCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('name') name: string | undefined,
    @Res() res: Response,
  ) {
    const pdf = await this.service.sampleCertificate(
      id,
      (name ?? '').trim().slice(0, 120) || 'Adaeze Nwachukwu-Okonkwo',
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'inline; filename="sample-certificate.pdf"',
    );
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  }
}
