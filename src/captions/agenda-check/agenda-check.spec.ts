import {
  agendaPrompt,
  cleanAnswer,
  toTurns,
  type AgendaAnswer,
  type AgendaSession,
  type FiledLine,
} from './agenda-check';

const at = (hhmmss: string) => Date.parse(`2026-10-21T${hhmmss}Z`);
const session = (
  id: string,
  title: string,
  start: string,
  end: string,
  status = 'completed',
): AgendaSession => ({
  id,
  title,
  type: 'panel',
  status,
  startsAt: new Date(`2026-10-21T${start}Z`),
  endsAt: new Date(`2026-10-21T${end}Z`),
  speakers:
    id === 'panel' ? [{ name: 'Dr. Tayo Aduloju', organisation: 'NESG' }] : [],
  brief: id === 'panel' ? 'What compute infrastructure Africa needs.' : null,
});

const agenda = [
  session(
    'qa',
    'Moderated Question and Answer Session',
    '11:15:00',
    '11:25:00',
  ),
  session(
    'panel',
    'What compute infrastructure will enable Africa to build and scale AI',
    '11:25:00',
    '12:00:00',
    'scheduled',
  ),
];

const lines: FiledLine[] = [
  {
    sessionId: 'qa',
    at: at('11:15:00'),
    name: null,
    text: 'Any questions from the floor for the professor?',
  },
  {
    sessionId: 'qa',
    at: at('11:15:10'),
    name: null,
    text: 'Yes, at the back.',
  },
  {
    sessionId: 'qa',
    at: at('11:58:00'),
    name: null,
    text: 'Please welcome our panel, Dr. Tayo Aduloju of NESG and Steven from IHS Towers.',
  },
  {
    sessionId: 'qa',
    at: at('11:59:00'),
    name: 'Dr. Tayo Aduloju',
    text: 'Compute infrastructure is the gap we have to close for data centres.',
  },
];

describe('agenda check', () => {
  it('reads lines as turns, joining one voice in one session', () => {
    const turns = toTurns(lines);
    expect(turns.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
    expect(turns[0].lines).toBe(2);
  });

  it('shows the agenda with speakers and the turns with where they are filed', () => {
    const prompt = agendaPrompt('Main Hall', 1, agenda, toTurns(lines));
    expect(prompt).toContain(
      'S2 12:25–13:00 [panel] "What compute infrastructure',
    );
    expect(prompt).toContain('Speakers: Dr. Tayo Aduloju (NESG)');
    expect(prompt).toContain('T2 12:58:00 [S1] Please welcome our panel');
  });

  const answer = (
    over: Partial<AgendaAnswer['misfiled'][number]> = {},
  ): AgendaAnswer => ({
    sessions: [{ session: 'S1', fit: 'partly', note: 'Ends with the panel.' }],
    misfiled: [
      {
        fromTurn: 'T2',
        toTurn: 'T3',
        filedAs: 'S1',
        belongsTo: 'S2',
        confidence: 0.95,
        namesHeard: ['Dr. Tayo Aduloju'],
        evidence: 'Please welcome our panel, Dr. Tayo Aduloju of NESG',
        reason: 'The panel is introduced and speaks on compute.',
        ...over,
      },
    ],
  });

  it('turns a sure finding into a move of that stretch', () => {
    const { fits, fixes } = cleanAnswer(answer(), agenda, toTurns(lines));
    expect(fits).toEqual([
      { sessionId: 'qa', fit: 'partly', note: 'Ends with the panel.' },
    ]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      fromSessionId: 'qa',
      toSessionId: 'panel',
      since: '2026-10-21T11:58:00.000Z',
      until: '2026-10-21T11:59:00.000Z',
      lines: 2,
    });
  });

  it('drops a quote that is not in those turns, a weak guess, or an unknown session', () => {
    const turns = toTurns(lines);
    expect(
      cleanAnswer(
        answer({
          evidence: 'We commit ten billion naira to sovereign compute',
        }),
        agenda,
        turns,
      ).fixes,
    ).toHaveLength(0);
    expect(
      cleanAnswer(answer({ confidence: 0.5 }), agenda, turns).fixes,
    ).toHaveLength(0);
    expect(
      cleanAnswer(answer({ belongsTo: 'S9' }), agenda, turns).fixes,
    ).toHaveLength(0);
    expect(
      cleanAnswer(answer({ belongsTo: 'S1' }), agenda, turns).fixes,
    ).toHaveLength(0);
  });

  it('reports talk that fits no session without a target', () => {
    const { fixes } = cleanAnswer(
      answer({ belongsTo: 'none' }),
      agenda,
      toTurns(lines),
    );
    expect(fixes[0].toSessionId).toBeNull();
  });
});
