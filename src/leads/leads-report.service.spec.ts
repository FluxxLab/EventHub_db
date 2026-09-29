import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import { LeadsReportService } from './leads-report.service';

/**
 * The exhibition report: Postgres counts (which arrive as strings) become
 * numbers, each stand gets its own hours, and a stand nobody visited still
 * appears, with zeros.
 */
const EDITION = '22222222-2222-4222-8222-222222222222';

function setup(missing = false) {
  const query = jest
    .fn()
    .mockResolvedValueOnce([
      {
        boothId: 'b1',
        name: 'Kora Health',
        location: 'Hall B',
        isActive: true,
        stamps: '140',
        leads: '32',
        hot: '9',
        warm: '12',
        cold: '4',
        withNotes: '11',
      },
      {
        boothId: 'b2',
        name: 'Quiet corner',
        location: null,
        isActive: true,
        stamps: '3',
        leads: '0',
        hot: '0',
        warm: '0',
        cold: '0',
        withNotes: '0',
      },
    ])
    .mockResolvedValueOnce([
      { boothId: 'b1', day: '2027-09-07', hour: '10', leads: '12' },
      { boothId: 'b1', day: '2027-09-07', hour: '13', leads: '20' },
    ])
    .mockResolvedValueOnce([{ n: '31' }])
    .mockResolvedValueOnce([{ n: '2152' }]);
  const dataSource = { query } as unknown as DataSource;
  const editions = {
    card: jest.fn(() =>
      missing
        ? Promise.reject(new NotFoundException())
        : Promise.resolve({ id: EDITION }),
    ),
  } as unknown as EditionsService;
  return { service: new LeadsReportService(dataSource, editions), query };
}

describe('LeadsReportService', () => {
  it('counts per stand, with each stand’s hours', async () => {
    const report = await setup().service.report(EDITION);
    expect(report).toMatchObject({
      editionId: EDITION,
      ticketHolders: 2152,
      delegatesScanned: 31,
    });
    expect(report.stands[0]).toMatchObject({
      name: 'Kora Health',
      stamps: 140,
      leads: 32,
      hot: 9,
      warm: 12,
      cold: 4,
      withNotes: 11,
      byHour: [
        { day: '2027-09-07', hour: 10, leads: 12 },
        { day: '2027-09-07', hour: 13, leads: 20 },
      ],
    });
    expect(report.stands[1]).toMatchObject({
      name: 'Quiet corner',
      leads: 0,
      byHour: [],
    });
  });

  it('refuses an edition that does not exist', async () => {
    const { service, query } = setup(true);
    await expect(service.report(EDITION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
