import {
  changeoverCues,
  cleanVerdict,
  listenFor,
  roomPlans,
  switchPrompt,
  type PlannedSession,
  type RoomPlan,
} from './switch-detector';

const at = (hm: string) => new Date(`2026-10-22T${hm}:00+01:00`);
const session = (
  id: string,
  start: string,
  end: string,
  over: Partial<PlannedSession> = {},
): PlannedSession => ({
  id,
  title: id,
  day: 2,
  startsAt: at(start),
  endsAt: at(end),
  room: 'Main Hall',
  status: 'scheduled',
  speakers: [],
  ...over,
});

const lecture = session('lecture', '10:30', '10:50', {
  status: 'live',
  title:
    'What Africa Stands to Lose: The Unseen Costs of Limited Compute Capacity',
  speakers: [
    { name: 'Prof. Victor Odumuyiwa', organisation: 'University of Lagos' },
  ],
});
const panel = session('panel', '11:00', '11:30', {
  title:
    'From Potential to Progress: Reflections on Nigeria’s National AI Strategy',
  speakers: [
    { name: 'Dr. Olubunmi Ajala' },
    { name: 'Dr. Chinasa Okolo' },
    { name: 'Dr. Olubayo Adekanmbi' },
  ],
});
const plan: RoomPlan = { room: 'Main Hall', live: lecture, next: panel };

describe('which rooms to watch', () => {
  it('pairs each live session with the next scheduled one in its room that day', () => {
    const plans = roomPlans([
      lecture,
      panel,
      session('later', '12:00', '12:30'),
      session('elsewhere', '10:55', '11:30', { room: 'Tamarind A' }),
      session('tomorrow', '09:00', '10:00', { day: 3 }),
      session('idle', '10:00', '11:00', { room: 'Foyer' }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].next?.id).toBe('panel');
  });

  it('listens for the next start from 10 minutes before it, and for an end when a break follows', () => {
    expect(listenFor(plan, at('10:45'))).toBeNull();
    expect(listenFor(plan, at('10:50'))).toBe('start_next');
    expect(listenFor(plan, at('11:40'))).toBe('start_next');
    const beforeLunch: RoomPlan = {
      ...plan,
      next: session('after-lunch', '13:30', '14:00'),
    };
    expect(listenFor(beforeLunch, at('10:40'))).toBeNull();
    expect(listenFor(beforeLunch, at('10:46'))).toBe('end_current');
    expect(listenFor({ ...plan, next: null }, at('10:50'))).toBe('end_current');
  });
});

describe('cues worth asking about', () => {
  it('hears the next session introduced by its speakers or title', () => {
    expect(
      changeoverCues(
        ['Please welcome Dr. Okolo and Dr. Ajala to the stage.'],
        'start_next',
        plan,
      ),
    ).toEqual(
      expect.arrayContaining([
        '"please welcome"',
        'speaker Dr. Olubunmi Ajala',
        'speaker Dr. Chinasa Okolo',
      ]),
    );
    expect(
      changeoverCues(
        ['We now turn to reflections on the national strategy'],
        'start_next',
        plan,
      ),
    ).toEqual(['title words reflections, national, strategy']);
  });

  it('hears a close, and stays quiet on ordinary talk', () => {
    expect(
      changeoverCues(
        ['That brings us to the end of this lecture'],
        'end_current',
        plan,
      ),
    ).toContain('"that brings us to the end"');
    expect(
      changeoverCues(
        ['Compute capacity in Africa remains limited.'],
        'start_next',
        plan,
      ),
    ).toEqual([]);
    expect(
      changeoverCues(
        ['Compute capacity in Africa remains limited.'],
        'end_current',
        plan,
      ),
    ).toEqual([]);
  });
});

describe('what Claude is asked, and what is kept', () => {
  const lines = [
    { at: at('10:58'), text: 'Thank you Professor for that lecture.' },
    {
      at: at('10:59'),
      text: 'Please welcome our panel, Dr. Okolo, Dr. Ajala and our moderator Dr. Adekanmbi.',
    },
  ];

  it('gives the room, both sessions with their speakers, and timed captions', () => {
    const prompt = switchPrompt(plan, lines, at('11:00'));
    expect(prompt).toContain('ROOM: Main Hall');
    expect(prompt).toContain('NEXT SESSION: "From Potential to Progress');
    expect(prompt).toContain('Dr. Chinasa Okolo');
    expect(prompt).toContain('[10:59] Please welcome our panel');
  });

  const answer = {
    verdict: 'next_started' as const,
    confidence: 0.9,
    evidence: 'Please welcome our panel, Dr. Okolo, Dr. Ajala',
    reason: 'The panel was introduced to begin.',
  };

  it('keeps a confident start resting on words that were said', () => {
    expect(cleanVerdict(answer, plan, lines, 0.8)).toEqual({
      kind: 'start_next',
      confidence: 0.9,
      evidence: answer.evidence,
      reason: answer.reason,
    });
  });

  it('drops doubt, invented evidence, a start with nothing next, and "neither"', () => {
    expect(
      cleanVerdict({ ...answer, confidence: 0.6 }, plan, lines, 0.8),
    ).toBeNull();
    expect(
      cleanVerdict(
        {
          ...answer,
          evidence: 'The moderator opened the national strategy panel',
        },
        plan,
        lines,
        0.8,
      ),
    ).toBeNull();
    expect(
      cleanVerdict({ ...answer, evidence: 'Please welcome' }, plan, lines, 0.8),
    ).toBeNull();
    expect(
      cleanVerdict(answer, { ...plan, next: null }, lines, 0.8),
    ).toBeNull();
    expect(
      cleanVerdict({ ...answer, verdict: 'neither' }, plan, lines, 0.8),
    ).toBeNull();
  });

  it('turns a close into an end suggestion', () => {
    expect(
      cleanVerdict(
        {
          ...answer,
          verdict: 'current_ended',
          evidence: 'Thank you Professor for that lecture',
        },
        plan,
        lines,
        0.8,
      )?.kind,
    ).toBe('end_current');
  });
});
