import { NotFoundException } from '@nestjs/common';
import { ResourcesService } from './resources.service';
import type { CertificateTemplate } from './certificate-template';

const template: CertificateTemplate = {
  key: 'certificates/11111111-1111-1111-1111-111111111111',
  contentType: 'image/png',
  width: 3508,
  height: 2480,
  name: {
    x: 0.5,
    y: 0.5,
    size: 0.06,
    maxWidth: 0.6,
    color: '#002d74',
    font: 'serif',
    bold: false,
    align: 'center',
  },
  code: null,
  updatedAt: '2027-09-01T00:00:00Z',
};

function build({ withTemplate = true } = {}) {
  const gs27 = {
    id: 'ed-27',
    name: 'GS-27 Gender Summit',
    shortName: 'GS-27',
    isCurrent: true,
    certificateTemplate: withTemplate ? template : null,
  };
  const rows: Record<string, unknown>[] = [];
  const certificates = {
    findOneBy: jest.fn((where: Record<string, string>) =>
      Promise.resolve(
        rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ??
          null,
      ),
    ),
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn((v: Record<string, unknown>) => {
      const saved = { ...v, issuedAt: new Date('2027-09-08T10:00:00Z') };
      rows.push(saved);
      return Promise.resolve(saved);
    }),
  };
  const editions = {
    findOne: jest.fn(
      ({ where }: { where: { id?: string; isCurrent?: boolean } }) =>
        Promise.resolve(where.isCurrent || where.id === 'ed-27' ? gs27 : null),
    ),
    save: jest.fn((e: unknown) => Promise.resolve(e)),
  };
  const storage = {
    deleteObject: jest.fn().mockResolvedValue(undefined),
    presignRead: jest.fn().mockResolvedValue('https://signed'),
  };
  const service = new ResourcesService(
    {} as never,
    certificates as never,
    editions as never,
    storage as never,
    { statusFor: jest.fn() } as never,
    {} as never,
    { get: () => undefined } as never,
  );
  return { service, rows, gs27, storage, editions };
}

describe('ResourcesService certificates per edition', () => {
  it('issues one certificate per delegate per edition, coded for the summit', async () => {
    const t = build();
    const first = await t.service.issueCertificate('d1', 'Ngozi Eze');
    expect(first).toMatchObject({
      delegateId: 'd1',
      editionId: 'ed-27',
      delegateName: 'Ngozi Eze',
    });
    expect(first.code).toMatch(/^GS27-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    const again = await t.service.issueCertificate('d1', 'Ngozi Eze');
    expect(again.code).toBe(first.code);

    // the same delegate at another summit gets that summit's own certificate
    const other = await t.service.issueCertificate('d1', 'Ngozi Eze', {
      id: 'ed-28',
      shortName: 'GS-28',
    });
    expect(other.code).toMatch(/^GS28-/);
    expect(t.rows).toHaveLength(2);
  });

  it('says certificates are not available until the design is uploaded', async () => {
    const t = build({ withTemplate: false });
    await expect(t.service.issueCertificate('d1', 'Ngozi Eze')).rejects.toThrow(
      new NotFoundException(
        'Certificates for GS-27 Gender Summit are not available yet',
      ),
    );
    await expect(
      t.service.certificatePdf('d1', 'Ngozi Eze'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('verifies a code with the summit it belongs to', async () => {
    const t = build();
    const cert = await t.service.issueCertificate('d1', 'Ngozi Eze');
    await expect(
      t.service.verifyCertificate(` ${cert.code.toLowerCase()} `),
    ).resolves.toMatchObject({
      valid: true,
      delegateName: 'Ngozi Eze',
      event: 'GS-27 Gender Summit',
    });
    await expect(
      t.service.verifyCertificate('GS27-NOPE0-NOPE0'),
    ).resolves.toEqual({ valid: false });
  });

  it('replaces a design and tidies the old artwork away', async () => {
    const t = build();
    const saved = await t.service.saveCertificateTemplate('ed-27', {
      ...template,
      key: 'certificates/22222222-2222-2222-2222-222222222222',
    });
    expect(saved.key).toBe('certificates/22222222-2222-2222-2222-222222222222');
    expect(t.storage.deleteObject).toHaveBeenCalledWith(template.key);
    await t.service.removeCertificateTemplate('ed-27');
    expect(t.gs27.certificateTemplate).toBeNull();
  });
});
