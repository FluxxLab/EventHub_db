import { ConflictException, HttpStatus } from '@nestjs/common';
import { DiscussionService } from './discussions.service';
import type { SessionComment } from './entities/session-comment.entity';

/**
 * The app re-sends a comment after a timeout, or from its offline queue, with
 * the id it gave the comment when it was written. Whatever the network did,
 * the thread ends up with the comment once.
 */
const CLIENT_ID = '0b0c3d7e-6a52-4a0e-9d7f-2f1b5a9c1e11';

function build(opts: { locked?: boolean; raceOnSave?: boolean } = {}) {
  const rows: SessionComment[] = [];
  let seq = 0;
  const comments = {
    create: jest.fn((v: Partial<SessionComment>) => v),
    save: jest.fn((v: Partial<SessionComment>) => {
      if (opts.raceOnSave) {
        // another copy of the same retry got in first
        rows.push({ ...(v as SessionComment), id: 'c-other' });
        return Promise.reject(
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        );
      }
      const saved = {
        ...(v as SessionComment),
        id: `c${++seq}`,
        createdAt: new Date(),
      };
      rows.push(saved);
      return Promise.resolve(saved);
    }),
    findOneBy: jest.fn(({ authorId, clientId }: Partial<SessionComment>) =>
      Promise.resolve(
        rows.find((r) => r.authorId === authorId && r.clientId === clientId) ??
          null,
      ),
    ),
  };
  const realtime = { emitToRoom: jest.fn() };
  const delegates = {
    authorsByIds: jest.fn().mockResolvedValue(new Map()),
  };
  const locks = {
    existsBy: jest.fn().mockResolvedValue(Boolean(opts.locked)),
  };
  const sessions = { findById: jest.fn().mockResolvedValue({ id: 's1' }) };
  const service = new DiscussionService(
    comments as never,
    {} as never,
    sessions as never,
    realtime as never,
    delegates as never,
    { record: jest.fn() } as never,
    locks as never,
  );
  return { service, rows, comments, realtime, locks };
}

describe('DiscussionService.postComment idempotency', () => {
  it('saves a comment once however many times the same client id arrives', async () => {
    const t = build();
    const first = await t.service.postComment('s1', 'a1', {
      body: 'Offline thought',
      clientId: CLIENT_ID,
    });
    const again = await t.service.postComment('s1', 'a1', {
      body: 'Offline thought',
      clientId: CLIENT_ID,
    });
    expect(again.id).toBe(first.id);
    expect(t.rows).toHaveLength(1);
    expect(t.comments.save).toHaveBeenCalledTimes(1);
    // the room heard it once
    expect(t.realtime.emitToRoom).toHaveBeenCalledTimes(1);
  });

  it('hands back the saved comment even when the thread was locked since', async () => {
    const t = build();
    const first = await t.service.postComment('s1', 'a1', {
      body: 'Sent before the lock',
      clientId: CLIENT_ID,
    });
    t.locks.existsBy.mockResolvedValue(true);
    await expect(
      t.service.postComment('s1', 'a1', {
        body: 'Sent before the lock',
        clientId: CLIENT_ID,
      }),
    ).resolves.toMatchObject({ id: first.id });
    // a new comment is still refused
    await expect(
      t.service.postComment('s1', 'a1', { body: 'After the lock' }),
    ).rejects.toMatchObject({ status: HttpStatus.LOCKED });
  });

  it('keeps client ids per author: someone else reusing one posts their own comment', async () => {
    const t = build();
    await t.service.postComment('s1', 'a1', {
      body: 'Mine',
      clientId: CLIENT_ID,
    });
    await t.service.postComment('s1', 'a2', {
      body: 'Theirs',
      clientId: CLIENT_ID,
    });
    expect(t.rows.map((r) => r.authorId)).toEqual(['a1', 'a2']);
  });

  it('refuses a client id already used on another thread', async () => {
    const t = build();
    await t.service.postComment('s1', 'a1', {
      body: 'Here',
      clientId: CLIENT_ID,
    });
    await expect(
      t.service.postComment('s2', 'a1', { body: 'There', clientId: CLIENT_ID }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns the other copy when two retries race on the unique index', async () => {
    const t = build({ raceOnSave: true });
    await expect(
      t.service.postComment('s1', 'a1', { body: 'Raced', clientId: CLIENT_ID }),
    ).resolves.toMatchObject({ id: 'c-other' });
    expect(t.realtime.emitToRoom).not.toHaveBeenCalled();
  });

  it('still posts every time without a client id (older builds)', async () => {
    const t = build();
    await t.service.postComment('s1', 'a1', { body: 'One' });
    await t.service.postComment('s1', 'a1', { body: 'One' });
    expect(t.rows).toHaveLength(2);
  });
});
