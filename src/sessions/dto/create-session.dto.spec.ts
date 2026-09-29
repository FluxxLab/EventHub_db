import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SessionTrack } from '../entities/session.entity';
import { CreateSessionDto } from './create-session.dto';
import { UpdateSessionDto } from './update-session.dto';

/**
 * The DTO is where a typed "Plenary Session" becomes `plenary` and where
 * "TBC" stops being a room. Run through the same transform-then-validate
 * pipeline the global ValidationPipe uses, so these prove what a request
 * actually gets back rather than what the decorators look like.
 */
const body = (over: Record<string, unknown> = {}) => ({
  title: 'Opening plenary',
  description: 'Welcome',
  day: 1,
  startsAt: '2026-09-08T09:00:00+01:00',
  endsAt: '2026-09-08T10:00:00+01:00',
  room: 'Hestel Hall',
  track: SessionTrack.GENERAL,
  type: 'plenary',
  ...over,
});

const check = async (over: Record<string, unknown>) => {
  const dto = plainToInstance(CreateSessionDto, body(over));
  const errors = await validate(dto);
  return { dto, errors };
};

const messages = (errors: Awaited<ReturnType<typeof check>>['errors']) =>
  errors.flatMap((e) => Object.values(e.constraints ?? {}));

describe('CreateSessionDto.type', () => {
  it('normalises a free-text variant onto the canonical list', async () => {
    const { dto, errors } = await check({ type: 'Plenary (Parallel Session)' });
    expect(errors).toHaveLength(0);
    expect(dto.type).toBe('parallel');
  });

  it('rejects an unrecognised type and lists the allowed values', async () => {
    const { errors } = await check({ type: 'Miscellaneous' });
    const text = messages(errors).join('\n');
    expect(text).toContain('type must be one of:');
    expect(text).toContain('plenary');
    expect(text).toContain('other');
  });
});

describe('CreateSessionDto.room', () => {
  it('trims and collapses whitespace', async () => {
    const { dto, errors } = await check({ room: '  Hestel   Hall ' });
    expect(errors).toHaveLength(0);
    expect(dto.room).toBe('Hestel Hall');
  });

  it.each(['TBC', ' tba ', 'n/a', 'None', '-', ''])(
    'refuses the placeholder "%s"',
    async (room) => {
      const { errors } = await check({ room });
      expect(messages(errors)).toContain(
        'Room must be a real room name; placeholders like TBC cannot receive captions',
      );
    },
  );

  it('still accepts a room whose name merely starts with a placeholder', async () => {
    const { errors } = await check({ room: 'TBC Suite' });
    expect(errors).toHaveLength(0);
  });
});

describe('UpdateSessionDto', () => {
  it('inherits both rules for a partial edit', async () => {
    const dto = plainToInstance(UpdateSessionDto, {
      type: 'Roundtable Discussion',
      room: 'TBD',
    });
    const errors = await validate(dto);
    expect(dto.type).toBe('roundtable');
    expect(messages(errors)).toContain(
      'Room must be a real room name; placeholders like TBC cannot receive captions',
    );
  });

  it('leaves untouched fields alone', async () => {
    const dto = plainToInstance(UpdateSessionDto, { title: 'Renamed' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.type).toBeUndefined();
    expect(dto.room).toBeUndefined();
  });
});
