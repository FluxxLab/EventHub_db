import { HttpStatus, NotFoundException } from '@nestjs/common';
import { DiscussionService } from './discussions.service';
import type { SessionComment } from './entities/session-comment.entity';

const comment = (over: Partial<SessionComment> = {}): SessionComment => ({
  id: 'c1',
  sessionId: 's1',
  authorId: 'a1',
  body: 'A fair point.',
  clientId: null,
  flagged: false,
  likes: 0,
  dislikes: 0,
  hiddenAt: null,
  hiddenBy: null,
  createdAt: new Date('2027-09-07T10:00:00Z'),
  ...over,
});

function build(row: SessionComment | null) {
  const comments = {
    findOneBy: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue({}),
  };
  const realtime = { emitToRoom: jest.fn() };
  const delegates = {
    authorsByIds: jest
      .fn()
      .mockResolvedValue(
        new Map([
          [
            'a1',
            { name: 'Ngozi Eze', organisation: 'UN Women', avatarUrl: null },
          ],
        ]),
      ),
  };
  const security = { record: jest.fn() };
  const lockedAt = new Date('2027-09-07T11:00:00Z');
  const lockRows = new Map<string, { sessionId: string; lockedAt: Date }>();
  const insert = {
    insert: () => insert,
    values: (v: { sessionId: string }) => {
      if (!lockRows.has(v.sessionId))
        lockRows.set(v.sessionId, { sessionId: v.sessionId, lockedAt });
      return insert;
    },
    orIgnore: () => insert,
    execute: () => Promise.resolve({}),
  };
  const locks = {
    existsBy: jest.fn(({ sessionId }: { sessionId: string }) =>
      Promise.resolve(lockRows.has(sessionId)),
    ),
    findOneBy: jest.fn(({ sessionId }: { sessionId: string }) =>
      Promise.resolve(lockRows.get(sessionId) ?? null),
    ),
    createQueryBuilder: () => insert,
    delete: jest.fn(({ sessionId }: { sessionId: string }) => {
      lockRows.delete(sessionId);
      return Promise.resolve({});
    }),
  };
  const sessions = {
    findById: jest.fn((id: string) =>
      id === 'missing'
        ? Promise.reject(new NotFoundException('Session not found'))
        : Promise.resolve({ id }),
    ),
  };
  const service = new DiscussionService(
    { ...comments, save: jest.fn(), create: jest.fn() } as never,
    {} as never,
    sessions as never,
    realtime as never,
    delegates as never,
    security as never,
    locks as never,
  );
  return { service, comments, realtime, lockedAt };
}

describe('DiscussionService thread lock', () => {
  it('locks a thread, tells the room, and turns new comments away with 423', async () => {
    const t = build(null);
    await expect(t.service.lockThread('s1', 'admin-1')).resolves.toEqual({
      sessionId: 's1',
      locked: true,
      lockedAt: t.lockedAt,
    });
    expect(t.realtime.emitToRoom).toHaveBeenCalledWith(
      'discussion:s1',
      'discussion:locked',
      { sessionId: 's1', locked: true, lockedAt: t.lockedAt },
    );

    const refused = t.service.postComment('s1', 'a1', { body: 'Late' });
    await expect(refused).rejects.toMatchObject({
      status: HttpStatus.LOCKED,
    });
    // other threads are untouched
    await expect(t.service.threadState('s2')).resolves.toMatchObject({
      locked: false,
    });
  });

  it('is idempotent both ways and announces the unlock', async () => {
    const t = build(null);
    await t.service.lockThread('s1', 'admin-1');
    await t.service.lockThread('s1', 'admin-2');
    await expect(t.service.threadState('s1')).resolves.toMatchObject({
      locked: true,
      lockedAt: t.lockedAt, // the first lock's time is kept
    });

    await expect(t.service.unlockThread('s1')).resolves.toEqual({
      sessionId: 's1',
      locked: false,
      lockedAt: null,
    });
    await t.service.unlockThread('s1');
    expect(t.realtime.emitToRoom).toHaveBeenLastCalledWith(
      'discussion:s1',
      'discussion:locked',
      { sessionId: 's1', locked: false, lockedAt: null },
    );
    await expect(t.service.threadState('s1')).resolves.toMatchObject({
      locked: false,
    });
  });

  it('404s for a session that does not exist', async () => {
    const t = build(null);
    await expect(
      t.service.lockThread('missing', 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.realtime.emitToRoom).not.toHaveBeenCalled();
  });
});

describe('DiscussionService moderation', () => {
  describe('keepComment', () => {
    it('clears the report so the comment leaves the review queue', async () => {
      const t = build(comment({ flagged: true }));
      await expect(t.service.keepComment('c1')).resolves.toMatchObject({
        flagged: false,
      });
      expect(t.comments.update).toHaveBeenCalledWith('c1', { flagged: false });
      expect(t.realtime.emitToRoom).not.toHaveBeenCalled(); // nothing changes on phones
    });

    it('404s for a comment that does not exist', async () => {
      const t = build(null);
      await expect(t.service.keepComment('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('unhideComment', () => {
    it('shows the comment again, clears its report and sends it back to the room', async () => {
      const t = build(
        comment({
          flagged: true,
          hiddenAt: new Date('2027-09-07T10:05:00Z'),
          hiddenBy: 'admin-1',
        }),
      );
      await expect(t.service.unhideComment('c1')).resolves.toMatchObject({
        hiddenAt: null,
        flagged: false,
      });
      expect(t.comments.update).toHaveBeenCalledWith('c1', {
        hiddenAt: null,
        hiddenBy: null,
        flagged: false,
      });
      expect(t.realtime.emitToRoom).toHaveBeenCalledWith(
        'discussion:s1',
        'discussion:comment',
        expect.objectContaining({
          id: 'c1',
          authorName: 'Ngozi Eze',
          body: 'A fair point.',
        }),
      );
    });

    it('leaves a comment that is not hidden alone', async () => {
      const t = build(comment());
      await t.service.unhideComment('c1');
      expect(t.comments.update).not.toHaveBeenCalled();
      expect(t.realtime.emitToRoom).not.toHaveBeenCalled();
    });

    it('404s for a comment that does not exist', async () => {
      const t = build(null);
      await expect(t.service.unhideComment('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
