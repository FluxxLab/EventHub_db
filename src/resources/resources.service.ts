import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SessionsService } from '../sessions/sessions.service';
import { StorageService } from '../common/storage/storage.service';
import { ParticipationService } from './participation.service';
import { AppDocument } from './entities/app-document.entity';
import { Certificate } from './entities/certificate.entity';
import { UpsertDocumentDto } from './dto/upsert-document.dto';
import {
  codePrefix,
  renderTemplatedCertificate,
  type CertificateTemplate,
} from './certificate-template';
import { SaveCertificateTemplateDto } from './dto/certificate-template.dto';
import { Edition } from '../editions/entities/edition.entity';

export const PURPLE_BOOK_KEY = 'purple-book';

@Injectable()
export class ResourcesService {
  constructor(
    @InjectRepository(AppDocument)
    private readonly documents: Repository<AppDocument>,
    @InjectRepository(Certificate)
    private readonly certificates: Repository<Certificate>,
    @InjectRepository(Edition)
    private readonly editions: Repository<Edition>,
    private readonly storage: StorageService,
    private readonly participation: ParticipationService,
    private readonly sessions: SessionsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether a delegate has to complete the participation checklist before a
   * certificate is issued.
   *
   * Off by default. The checklist was written for the days of the summit
   * itself, when "participation" still had a chance to happen; afterwards it
   * only stands between delegates who attended and the certificate they came
   * for, and the organisers are better placed than a checklist to decide who
   * earned one. Set CERTIFICATE_REQUIRE_PARTICIPATION=true to bring it back
   * for a future event.
   */
  private get requiresParticipation(): boolean {
    return (
      this.config.get<string>('CERTIFICATE_REQUIRE_PARTICIPATION') === 'true'
    );
  }

  /**
   * The stored `url` is an S3 key for anything uploaded through the admin, and
   * the bucket blocks public access - so it is signed on read, exactly like a
   * delegate photo. A genuinely external URL (someone pasted a link to a file
   * hosted elsewhere) is passed through untouched.
   */
  async getDocument(key: string): Promise<AppDocument> {
    const doc = await this.documents.findOneBy({ key });
    if (!doc) throw new NotFoundException(`No document published for "${key}"`);
    const url = await this.storage.resolveStoredUrl(doc.url);
    return { ...doc, url: url ?? doc.url };
  }

  upsertDocument(key: string, dto: UpsertDocumentDto): Promise<AppDocument> {
    return this.documents.save({
      key,
      title: dto.title,
      url: dto.url,
      sizeLabel: dto.sizeLabel ?? null,
    });
  }

  presignDocument(contentType: string) {
    return this.storage.presignUpload({ folder: 'documents', contentType });
  }

  // Human-readable and unambiguous when read aloud or typed from a printout:
  // no vowels (so no accidental words) and no 0/O/1/I lookalikes. The prefix
  // names the summit, so a code says which one it is for.
  private static newCode(prefix: string): string {
    const alphabet = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
    const bytes = randomBytes(10);
    const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(
      '',
    );
    return `${prefix}-${body.slice(0, 5)}-${body.slice(5, 10)}`;
  }

  /**
   * The summit delegates are claiming certificates for now, and its design.
   * Certificates are only available once the organisers have uploaded one.
   */
  private async currentForCertificates(): Promise<
    Edition & { certificateTemplate: CertificateTemplate }
  > {
    const edition = await this.editions.findOne({ where: { isCurrent: true } });
    if (!edition) throw new NotFoundException('There is no current summit');
    if (!edition.certificateTemplate) {
      throw new NotFoundException(
        `Certificates for ${edition.name} are not available yet`,
      );
    }
    return edition as Edition & { certificateTemplate: CertificateTemplate };
  }

  // Issue-once: a second call returns the delegate's existing certificate for
  // this edition rather than minting a new code, so the one they screenshotted
  // stays valid.
  async issueCertificate(
    delegateId: string,
    delegateName: string,
    edition?: Pick<Edition, 'id' | 'shortName'>,
  ): Promise<Certificate> {
    const forEdition = edition ?? (await this.currentForCertificates());
    const existing = await this.certificates.findOneBy({
      delegateId,
      editionId: forEdition.id,
    });
    if (existing) return existing;

    /**
     * Participation, not registration - and now the full checklist rather than
     * attendance alone. A certificate that says "participation" should require
     * having participated: joined a session, played the trivia, backed a pitch,
     * met people, said something.
     *
     * Checked only before the first issue. Once a certificate exists it stays
     * valid regardless, so a delegate can never lose one they earned.
     */
    if (this.requiresParticipation) {
      const participation = await this.participation.statusFor(delegateId);
      if (!participation.unlocked) {
        const remaining = participation.steps
          .filter((s) => !s.done)
          .map((s) => s.label)
          .join('; ');
        throw new ForbiddenException(
          `Complete your summit participation to unlock your certificate. Still to do: ${remaining}`,
        );
      }
    }

    return this.certificates.save(
      this.certificates.create({
        delegateId,
        editionId: forEdition.id,
        delegateName,
        code: ResourcesService.newCode(codePrefix(forEdition.shortName)),
      }),
    );
  }

  // Public check. Deliberately returns only what a verifier needs - the holder's
  // name, the summit and when it was issued - and never the delegate id or
  // contact details.
  async verifyCertificate(code: string): Promise<{
    valid: boolean;
    delegateName?: string;
    issuedAt?: Date;
    event?: string;
  }> {
    const cert = await this.certificates.findOneBy({
      code: code.trim().toUpperCase(),
    });
    if (!cert) return { valid: false };
    const edition = cert.editionId
      ? await this.editions.findOne({ where: { id: cert.editionId } })
      : null;
    return {
      valid: true,
      delegateName: cert.delegateName,
      issuedAt: cert.issuedAt,
      ...(edition ? { event: edition.name } : {}),
    };
  }

  // The PDF is rendered on demand rather than stored: it is derived entirely
  // from the certificate row and the edition's design, so replacing the design
  // updates every certificate without re-issuing any.
  async certificatePdf(
    delegateId: string,
    delegateName: string,
  ): Promise<Buffer> {
    const edition = await this.currentForCertificates();
    const cert = await this.issueCertificate(delegateId, delegateName, edition);
    return renderTemplatedCertificate(
      edition.certificateTemplate,
      await this.artwork(edition.certificateTemplate.key),
      {
        name: cert.delegateName,
        code: cert.code,
        title: `${edition.name} - Certificate of Participation - ${cert.delegateName}`,
      },
    );
  }

  /* ------------------------------------------------ certificate design */

  presignCertificateArtwork(contentType: string) {
    return this.storage.presignUpload({ folder: 'certificates', contentType });
  }

  /** The edition's design, with a short-lived URL to show the artwork in the console. */
  async certificateTemplate(editionId: string): Promise<{
    template: CertificateTemplate | null;
    artworkUrl: string | null;
  }> {
    const edition = await this.edition(editionId);
    const template = edition.certificateTemplate;
    return {
      template,
      artworkUrl: template
        ? await this.storage.presignRead(template.key)
        : null,
    };
  }

  async saveCertificateTemplate(
    editionId: string,
    dto: SaveCertificateTemplateDto,
  ): Promise<CertificateTemplate> {
    const edition = await this.edition(editionId);
    const previous = edition.certificateTemplate?.key;
    const template: CertificateTemplate = {
      key: dto.key,
      contentType: dto.contentType,
      width: dto.width,
      height: dto.height,
      name: dto.name,
      code: dto.code ?? null,
      updatedAt: new Date().toISOString(),
    };
    edition.certificateTemplate = template;
    await this.editions.save(edition);
    // Replaced artwork is not referenced anywhere else; tidy it away.
    if (previous && previous !== dto.key) {
      await this.storage.deleteObject(previous).catch(() => {});
    }
    return template;
  }

  /** Withdraws the design: certificates for the edition stop downloading until a new one is saved. */
  async removeCertificateTemplate(editionId: string): Promise<void> {
    const edition = await this.edition(editionId);
    const key = edition.certificateTemplate?.key;
    edition.certificateTemplate = null;
    await this.editions.save(edition);
    if (key) await this.storage.deleteObject(key).catch(() => {});
  }

  /** A certificate as it will look, with any name, and not issued to anyone. */
  async sampleCertificate(editionId: string, name: string): Promise<Buffer> {
    const edition = await this.edition(editionId);
    const template = edition.certificateTemplate;
    if (!template) {
      throw new NotFoundException('Upload the certificate design first');
    }
    return renderTemplatedCertificate(
      template,
      await this.artwork(template.key),
      {
        name,
        code: `${codePrefix(edition.shortName)}-SAMPL-ECODE`,
        title: `${edition.name} - Sample certificate`,
      },
    );
  }

  private async edition(id: string): Promise<Edition> {
    const edition = await this.editions.findOne({ where: { id } });
    if (!edition) throw new NotFoundException('Edition not found');
    return edition;
  }

  /** The artwork's bytes, read through a short-lived signed URL (the bucket is private). */
  private async artwork(key: string): Promise<Buffer> {
    const response = await fetch(await this.storage.presignRead(key, 120));
    if (!response.ok) {
      throw new ServiceUnavailableException(
        'The certificate design could not be read from storage',
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
