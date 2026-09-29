import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { SessionsService } from './sessions.service';
import { SpeakerRevealInterceptor } from './speaker-reveal.interceptor';

/**
 * The reveal is a withholding rule, and a withholding rule fails silently: a
 * leak returns data rather than throwing, so nothing else in the system would
 * report it. These assert the shape callers actually receive.
 */
describe('SpeakerRevealInterceptor', () => {
  const speaker = (id: string, name: string) => ({
    id,
    name,
    role: 'Minister',
    organisation: 'Federal Ministry of Health',
    avatarUrl: 'https://cdn.example/a.jpg',
  });

  const build = (revealed: boolean) => {
    const sessions = {
      speakersRevealed: jest.fn().mockResolvedValue(revealed),
      hiddenSpeaker: () => ({
        id: 'tba',
        name: 'To be announced',
        role: null,
        organisation: null,
        avatarUrl: null,
      }),
    } as unknown as SessionsService;
    return new SpeakerRevealInterceptor(sessions);
  };

  const run = async (
    interceptor: SpeakerRevealInterceptor,
    payload: unknown,
    role?: AccessTier,
  ) => {
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(payload) };
    return firstValueFrom(interceptor.intercept(context, next));
  };

  it('collapses a whole line-up to one placeholder, so the count is withheld too', async () => {
    const result = (await run(build(false), [
      {
        id: 's1',
        title: 'Opening Plenary',
        speakers: [
          speaker('a', 'Prof. Chimezie Anyakora'),
          speaker('b', 'Dr. Amara Okafor'),
          speaker('c', 'Ngozi Eze'),
          speaker('d', 'Tunde Bakare'),
        ],
      },
    ])) as { speakers: unknown[] }[];

    expect(result[0].speakers).toHaveLength(1);
    expect(result[0].speakers[0]).toEqual({
      id: 'tba',
      name: 'To be announced',
      role: null,
      organisation: null,
      avatarUrl: null,
    });
  });

  it('withholds organisation and photo, not just the name', async () => {
    const result = (await run(build(false), {
      speakers: [speaker('a', 'Prof. Chimezie Anyakora')],
    })) as { speakers: Record<string, unknown>[] };

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Chimezie');
    expect(serialised).not.toContain('Federal Ministry of Health');
    expect(serialised).not.toContain('cdn.example');
    expect(result.speakers[0].role).toBeNull();
  });

  it('leaves a session with no speakers alone rather than inventing a slot', async () => {
    const payload = [{ id: 's1', title: 'Break', speakers: [] }];
    const result = (await run(build(false), payload)) as {
      speakers: unknown[];
    }[];
    expect(result[0].speakers).toEqual([]);
  });

  it('redacts speakers nested below the top level', async () => {
    const result = (await run(build(false), {
      data: {
        sessions: [{ speakers: [speaker('a', 'Prof. Chimezie Anyakora')] }],
      },
    })) as { data: { sessions: { speakers: { name: string }[] }[] } };

    expect(result.data.sessions[0].speakers[0].name).toBe('To be announced');
  });

  it('passes everything through once revealed', async () => {
    const payload = [{ speakers: [speaker('a', 'Prof. Chimezie Anyakora')] }];
    const result = await run(build(true), payload);
    expect(result).toBe(payload);
  });

  it('exempts admin, who builds the line-up', async () => {
    const payload = [{ speakers: [speaker('a', 'Prof. Chimezie Anyakora')] }];
    const result = await run(build(false), payload, AccessTier.ADMIN);
    expect(result).toBe(payload);
  });

  it('does not consult the flag for an admin request', async () => {
    // held separately rather than read back off the object: asserting on
    // `sessions.speakersRevealed` passes an unbound method, which the lint
    // rules reject.
    const speakersRevealed = jest.fn().mockResolvedValue(false);
    const sessions = {
      speakersRevealed,
      hiddenSpeaker: () => ({ id: 'tba', name: 'To be announced' }),
    } as unknown as SessionsService;
    const interceptor = new SpeakerRevealInterceptor(sessions);

    await run(interceptor, [{ speakers: [] }], AccessTier.ADMIN);

    expect(speakersRevealed).not.toHaveBeenCalled();
  });

  it('survives a payload that is not an object', async () => {
    await expect(run(build(false), null)).resolves.toBeNull();
    await expect(run(build(false), 'ok')).resolves.toBe('ok');
  });
});
