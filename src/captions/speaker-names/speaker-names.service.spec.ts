import { SpeakerNamesService } from './speaker-names.service';
import type { SpeakerName } from './speaker-name.entity';
import { INTRO_DELAY_MS, MIC_GAP_MS } from './speaker-naming-plan';

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const at = (s: number) => T0 + s * 1000;

/** A repository of bindings in memory, enough for what the service asks of it. */
class FakeNames {
  rows: SpeakerName[] = [];
  private n = 0;

  create(v: Partial<SpeakerName>) {
    return { ...v } as SpeakerName;
  }
  save(row: SpeakerName) {
    if (!row.id) {
      row.id = `b${++this.n}`;
      row.createdAt = new Date();
      this.rows.push(row);
    }
    return Promise.resolve(row);
  }
  find({ where }: { where: Record<string, unknown> }) {
    return Promise.resolve(
      this.rows.filter((r) =>
        Object.entries(where).every(([k, v]) => {
          const value = r[k as keyof SpeakerName];
          if (v && typeof v === 'object' && '_type' in v) {
            const op = v as { _type: string; _value: unknown };
            if (op._type === 'not') return value !== op._value;
            if (op._type === 'in')
              return (op._value as unknown[]).includes(value);
          }
          return value === v;
        }),
      ),
    );
  }
  findOneBy({ id }: { id: string }) {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
  delete({ id }: { id: string }) {
    this.rows = this.rows.filter((r) => r.id !== id);
    return Promise.resolve({ affected: 1 });
  }
}

function build() {
  const names = new FakeNames();
  const introQueue = { add: jest.fn().mockResolvedValue({}) };
  const realtime = { emitToRoom: jest.fn() };
  const session = {
    id: 's1',
    title: 'Opening plenary',
    room: 'Main Hall',
    startsAt: new Date(at(0)),
    editionId: 'e1',
    speakers: [{ id: 'sp1', name: 'Dr Amina Bello', organisation: 'FMoH' }],
  };
  const service = new SpeakerNamesService(
    names as never,
    {} as never,
    introQueue as never,
    { add: jest.fn(), getJob: jest.fn() } as never,
    { findById: jest.fn().mockResolvedValue(session) } as never,
    {
      findById: jest.fn().mockResolvedValue({ speakerNaming: 'programme' }),
    } as never,
    realtime as never,
    { configured: false } as never,
  );
  return { service, names, introQueue, realtime };
}

const events = (realtime: { emitToRoom: jest.Mock }, event: string) =>
  realtime.emitToRoom.mock.calls
    .filter(([, e]) => e === event)
    .map(
      ([, , payload]) =>
        payload as { id: string; status: string; toAt: string | null },
    );

const line = (
  over: Partial<Parameters<SpeakerNamesService['onFinal']>[0]>,
) => ({
  id: 'seg1',
  sessionId: 's1',
  room: 'Main Hall',
  text: 'and that is the point',
  speaker: 2,
  mic: null,
  language: 'en',
  at: at(10),
  ...over,
});

describe('SpeakerNamesService live hooks', () => {
  it('queues a look at a line that sounds like an introduction, a few seconds later', async () => {
    const { service, introQueue } = build();
    await service.runStarted('Main Hall', 's1');
    await service.onFinal(line({ text: 'Please welcome Dr Amina Bello.' }));
    expect(introQueue.add).toHaveBeenCalledWith(
      'introduction',
      expect.objectContaining({
        sessionId: 's1',
        segmentId: 'seg1',
        kind: 'speaker',
        key: 2,
        at: new Date(at(10)).toISOString(),
      }),
      expect.objectContaining({ jobId: 'intro-seg1', delay: INTRO_DELAY_MS }),
    );
    await service.onFinal(line({ id: 'seg2', text: 'and that is the point' }));
    expect(introQueue.add).toHaveBeenCalledTimes(1);
  });

  it('does not queue translated or keyless lines', async () => {
    const { service, introQueue } = build();
    await service.onFinal(
      line({ text: 'Please welcome Dr Amina Bello.', language: 'ha' }),
    );
    await service.onFinal(
      line({ text: 'Please welcome Dr Amina Bello.', speaker: null }),
    );
    expect(introQueue.add).not.toHaveBeenCalled();
  });

  it('a reopen ends every open voice binding and tells the room', async () => {
    const { service, names, realtime } = build();
    await names.save(
      names.create({
        sessionId: 's1',
        kind: 'speaker',
        key: 1,
        name: 'Dr Amina Bello',
        organisation: null,
        speakerId: 'sp1',
        status: 'auto',
        source: 'introduction',
        evidence: null,
        fromAt: new Date(at(0)),
        toAt: null,
      }),
    );
    await names.save(
      names.create({
        sessionId: 's1',
        kind: 'mic',
        key: 1,
        name: 'Chair',
        organisation: null,
        speakerId: null,
        status: 'confirmed',
        source: 'operator',
        evidence: null,
        fromAt: new Date(at(0)),
        toAt: null,
      }),
    );
    await service.runStarted('Main Hall', 's1');
    expect(names.rows[0].toAt).not.toBeNull();
    expect(names.rows[1].toAt).toBeNull();
    const named = events(realtime, 'captions:named');
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ id: 'b1', status: 'auto' });
    expect(named[0].toAt).not.toBeNull();
    // closed, so the voice is unnamed from here
    expect(
      service.attributeNow(
        's1',
        { speaker: 1, mic: null, at: Date.now() },
        null,
      ).name,
    ).toBeNull();
  });

  it('a mic silent for longer than the gap drops its binding at its last line', async () => {
    const { service, names, realtime } = build();
    await names.save(
      names.create({
        sessionId: 's1',
        kind: 'mic',
        key: 2,
        name: 'Guest',
        organisation: null,
        speakerId: null,
        status: 'auto',
        source: 'introduction',
        evidence: null,
        fromAt: new Date(at(0)),
        toAt: null,
      }),
    );
    await service.onFinal(line({ speaker: null, mic: 2, at: at(10) }));
    await service.onFinal(
      line({ id: 'seg2', speaker: null, mic: 2, at: at(10) + MIC_GAP_MS }),
    );
    expect(names.rows[0].toAt).toBeNull();
    await service.onFinal(
      line({
        id: 'seg3',
        speaker: null,
        mic: 2,
        at: at(10) + 2 * MIC_GAP_MS + 1,
      }),
    );
    expect(names.rows[0].toAt).toEqual(new Date(at(10) + MIC_GAP_MS));
    expect(events(realtime, 'captions:named')).toHaveLength(1);
  });
});

describe('SpeakerNamesService operator', () => {
  it('a typed name is confirmed at once and cuts short what it overlaps', async () => {
    const { service, names, realtime } = build();
    await service.runStarted('Main Hall', 's1');
    const first = await service.create('s1', {
      kind: 'speaker',
      key: 2,
      name: 'Dr Amina Bello',
      speakerId: 'sp1',
      fromAt: new Date(at(0)).toISOString(),
    });
    expect(first).toMatchObject({
      status: 'confirmed',
      source: 'operator',
      organisation: 'FMoH',
      fromAt: new Date(at(0)).toISOString(),
      toAt: null,
    });
    await service.create('s1', {
      kind: 'speaker',
      key: 2,
      name: 'Someone Else',
      fromAt: new Date(at(60)).toISOString(),
    });
    expect(names.rows[0].toAt).toEqual(new Date(at(60)));
    // the live path sees the change at once: the cache is reloaded before
    // the room is told
    expect(
      service.attributeNow('s1', { speaker: 2, mic: null, at: at(30) }, null)
        .name,
    ).toBe('Dr Amina Bello');
    expect(
      service.attributeNow('s1', { speaker: 2, mic: null, at: at(90) }, null)
        .name,
    ).toBe('Someone Else');
    expect(
      (
        await service.attribute(
          's1',
          { speaker: 2, mic: null, at: at(30) },
          null,
        )
      ).name,
    ).toBe('Dr Amina Bello');
    expect(
      (
        await service.attribute(
          's1',
          { speaker: 2, mic: null, at: at(90) },
          null,
        )
      ).name,
    ).toBe('Someone Else');
    expect(events(realtime, 'captions:named').map((e) => e.id)).toEqual([
      'b1',
      'b1',
      'b2',
    ]);
  });

  it('a suggestion names nothing until confirmed; rejecting or deleting announces it as rejected', async () => {
    const { service, names, realtime } = build();
    await names.save(
      names.create({
        sessionId: 's1',
        kind: 'speaker',
        key: 3,
        name: 'Ngozi Adeyemi',
        organisation: null,
        speakerId: null,
        status: 'suggested',
        source: 'introduction',
        evidence: 'I am Ngozi Adeyemi',
        fromAt: new Date(at(0)),
        toAt: null,
      }),
    );
    expect(
      (
        await service.attribute(
          's1',
          { speaker: 3, mic: null, at: at(5) },
          null,
        )
      ).name,
    ).toBeNull();
    await service.update('b1', { status: 'confirmed' });
    expect(
      (
        await service.attribute(
          's1',
          { speaker: 3, mic: null, at: at(5) },
          null,
        )
      ).name,
    ).toBe('Ngozi Adeyemi');
    await service.update('b1', { status: 'rejected' });
    expect(
      (
        await service.attribute(
          's1',
          { speaker: 3, mic: null, at: at(5) },
          null,
        )
      ).name,
    ).toBeNull();
    expect(events(realtime, 'captions:named').map((e) => e.status)).toEqual([
      'confirmed',
      'rejected',
    ]);
    await service.remove('b1');
    expect(names.rows).toHaveLength(0);
    expect(events(realtime, 'captions:named').at(-1)?.status).toBe('rejected');
    await expect(service.remove('b1')).rejects.toThrow('No such speaker name');
  });
});
