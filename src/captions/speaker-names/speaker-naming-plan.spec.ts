import {
  appliedBindingFor,
  attribute,
  bindingsClosedBy,
  bindingsEndedByReopen,
  claimsIntroduction,
  introductionCandidate,
  matchProgramme,
  micGapExpired,
  MIC_GAP_MS,
  planReview,
  selfBindingStart,
  SESSION_LEAD_MS,
  statusFor,
  type Binding,
  type ExistingBinding,
  type PendingIntro,
} from './speaker-naming-plan';

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const at = (s: number) => T0 + s * 1000;
const d = (s: number) => new Date(at(s));

function binding(over: Partial<Binding> = {}): Binding {
  return {
    kind: 'speaker',
    key: 2,
    name: 'Dr Amina Bello',
    organisation: 'Ministry of Health',
    status: 'auto',
    fromAt: d(0),
    toAt: null,
    ...over,
  };
}

describe('introductionCandidate', () => {
  it.each([
    'Good morning, my name is Amina Bello from the Ministry of Health.',
    "I'm Dr Okafor and I lead the gender desk.",
    'This is Chinedu Eze speaking on behalf of the chamber.',
    'Please welcome Professor Ngozi Adeyemi to the stage.',
    'Joining us now is the Honourable Minister.',
    "I'll hand over to our next speaker, Dr Bello.",
    'Over to you, Ngozi.',
    'Give it up for the youth delegates!',
    'Let me introduce our panel for this session.',
    'Welcome, everyone, to the second day of the summit.',
    'I am Mrs Adaeze Okonkwo, representing UN Women.',
  ])('queues "%s"', (text) => {
    expect(introductionCandidate(text)).toBe(true);
  });

  it.each([
    'I am sure we all agree that inclusion matters.',
    'This is important for every state.',
    'The data shows a gap of thirty percent.',
    'Thank you.',
    "We'll come back to that after the break.",
    'My point is that funding must follow the policy.',
  ])('leaves "%s" alone', (text) => {
    expect(introductionCandidate(text)).toBe(false);
  });
});

describe('statusFor', () => {
  it('applies programme matches on its own, suggests strangers only when everyone is named', () => {
    expect(statusFor('off', true)).toBeNull();
    expect(statusFor('off', false)).toBeNull();
    expect(statusFor('programme', true)).toBe('auto');
    expect(statusFor('programme', false)).toBeNull();
    expect(statusFor('everyone', true)).toBe('auto');
    expect(statusFor('everyone', false)).toBe('suggested');
  });
});

describe('attribute', () => {
  const heard = [binding()];

  it("prefers the operator's mic label, with its organisation", () => {
    expect(
      attribute(
        { speaker: 2, mic: 1, at: at(10) },
        { name: 'Chair', organisation: null },
        [binding({ kind: 'mic', key: 1 })],
      ),
    ).toEqual({ name: 'Chair', organisation: null });
  });

  it('falls back to the applied binding for the voice', () => {
    expect(
      attribute({ speaker: 2, mic: null, at: at(10) }, null, heard),
    ).toEqual({ name: 'Dr Amina Bello', organisation: 'Ministry of Health' });
  });

  it('names by the mic, not the voice, when the line has a mic', () => {
    expect(
      attribute({ speaker: 2, mic: 3, at: at(10) }, undefined, heard),
    ).toEqual({ name: null, organisation: null });
    expect(
      attribute({ speaker: 2, mic: 3, at: at(10) }, undefined, [
        binding({ kind: 'mic', key: 3, name: 'Guest' }),
      ]).name,
    ).toBe('Guest');
  });

  it('ignores suggestions, closed stretches and back-filled rows', () => {
    expect(
      attribute({ speaker: 2, mic: null, at: at(10) }, null, [
        binding({ status: 'suggested' }),
      ]).name,
    ).toBeNull();
    expect(
      attribute({ speaker: 2, mic: null, at: at(10) }, null, [
        binding({ toAt: d(10) }),
      ]).name,
    ).toBeNull();
    expect(
      attribute(
        { speaker: 2, mic: null, at: at(10), backfill: true },
        null,
        heard,
      ).name,
    ).toBeNull();
  });

  it('takes the latest-starting binding when two cover the line', () => {
    const later = binding({ name: 'Second', fromAt: d(5) });
    expect(
      appliedBindingFor([binding(), later], {
        speaker: 2,
        mic: null,
        at: at(10),
      }),
    ).toBe(later);
  });
});

describe('selfBindingStart', () => {
  const sessionStartsAt = at(0);
  const lead = sessionStartsAt - SESSION_LEAD_MS;

  it('names the whole run for a voice, but never before the session lead', () => {
    expect(
      selfBindingStart('speaker', {
        at: at(600),
        runStartedAt: at(100),
        sessionStartsAt,
        firstLineOnMicAt: null,
      }),
    ).toBe(at(100));
    expect(
      selfBindingStart('speaker', {
        at: at(600),
        runStartedAt: lead - 60_000,
        sessionStartsAt,
        firstLineOnMicAt: null,
      }),
    ).toBe(lead);
    expect(
      selfBindingStart('speaker', {
        at: at(600),
        runStartedAt: null,
        sessionStartsAt,
        firstLineOnMicAt: null,
      }),
    ).toBe(lead);
  });

  it("names a mic from its holder's first line, else from the lead", () => {
    expect(
      selfBindingStart('mic', {
        at: at(600),
        runStartedAt: at(100),
        sessionStartsAt,
        firstLineOnMicAt: at(400),
      }),
    ).toBe(at(400));
    expect(
      selfBindingStart('mic', {
        at: at(600),
        runStartedAt: at(100),
        sessionStartsAt,
        firstLineOnMicAt: null,
      }),
    ).toBe(lead);
  });

  it('never starts after the line itself', () => {
    expect(
      selfBindingStart('speaker', {
        at: at(50),
        runStartedAt: at(100),
        sessionStartsAt,
        firstLineOnMicAt: null,
      }),
    ).toBe(at(50));
  });
});

describe('claimsIntroduction', () => {
  const pending: PendingIntro = {
    name: 'Dr Amina Bello',
    organisation: null,
    speakerId: 'sp1',
    status: 'auto',
    evidence: 'Please welcome Dr Amina Bello',
    introducerKind: 'speaker',
    introducerKey: 0,
    seenBefore: [0, 1],
    until: at(90),
  };

  it('is claimed by the first voice not heard before the introduction', () => {
    expect(
      claimsIntroduction(pending, { speaker: 2, mic: null, at: at(10) }, false),
    ).toBe(true);
  });

  it('is not the introducer, a voice already heard, a named voice, or a back-filled row', () => {
    expect(
      claimsIntroduction(pending, { speaker: 0, mic: null, at: at(10) }, false),
    ).toBe(false);
    expect(
      claimsIntroduction(pending, { speaker: 1, mic: null, at: at(10) }, false),
    ).toBe(false);
    expect(
      claimsIntroduction(pending, { speaker: 2, mic: null, at: at(10) }, true),
    ).toBe(false);
    expect(
      claimsIntroduction(
        pending,
        { speaker: 2, mic: null, at: at(10), backfill: true },
        false,
      ),
    ).toBe(false);
  });

  it('lapses after the window', () => {
    expect(
      claimsIntroduction(pending, { speaker: 2, mic: null, at: at(91) }, false),
    ).toBe(false);
  });

  it('for mics, any other mic claims it', () => {
    const onMic: PendingIntro = {
      ...pending,
      introducerKind: 'mic',
      introducerKey: 1,
    };
    expect(
      claimsIntroduction(onMic, { speaker: null, mic: 1, at: at(10) }, false),
    ).toBe(false);
    expect(
      claimsIntroduction(onMic, { speaker: 5, mic: 2, at: at(10) }, false),
    ).toBe(true);
  });
});

describe('micGapExpired', () => {
  it('fires only after more than the gap of silence on the mic', () => {
    expect(micGapExpired(undefined, at(0))).toBe(false);
    expect(micGapExpired(at(0), at(0) + MIC_GAP_MS)).toBe(false);
    expect(micGapExpired(at(0), at(0) + MIC_GAP_MS + 1)).toBe(true);
  });
});

describe('run reset and overlap', () => {
  it('a reopen ends every open voice binding, whatever its status, and no mic binding', () => {
    const open = binding();
    const confirmed = binding({ key: 3, status: 'confirmed' });
    const suggested = binding({ key: 4, status: 'suggested' });
    const ended = bindingsEndedByReopen([
      open,
      confirmed,
      suggested,
      binding({ key: 5, toAt: d(1) }),
      binding({ key: 6, status: 'rejected' }),
      binding({ kind: 'mic', key: 1 }),
    ]);
    expect(ended).toEqual([open, confirmed, suggested]);
  });

  it('a new applied binding cuts short the applied ones it overlaps on its key', () => {
    const earlier = binding({ fromAt: d(0) });
    const closedAlready = binding({ fromAt: d(0), toAt: d(5) });
    const suggestion = binding({ fromAt: d(0), status: 'suggested' });
    const otherKey = binding({ key: 9 });
    expect(
      bindingsClosedBy([earlier, closedAlready, suggestion, otherKey], {
        kind: 'speaker',
        key: 2,
        fromAt: d(10),
      }),
    ).toEqual([earlier]);
  });
});

describe('matchProgramme', () => {
  const speakers = [
    { id: 'sp1', name: 'Dr Amina Bello', organisation: 'FMoH' },
    { id: 'sp2', name: 'Chinedu Eze', organisation: null },
  ];

  it('matches by id, else by name without titles, else not at all', () => {
    expect(matchProgramme(speakers, 'sp2', 'Someone Else')?.id).toBe('sp2');
    expect(matchProgramme(speakers, null, 'amina bello')?.id).toBe('sp1');
    expect(matchProgramme(speakers, 'nope', 'Prof. Chinedu Eze')?.id).toBe(
      'sp2',
    );
    expect(matchProgramme(speakers, null, 'Ngozi Adeyemi')).toBeNull();
  });
});

describe('planReview', () => {
  const lines = [0, 10, 20, 30, 40, 50].map((s) => ({ at: at(s) }));
  const speakers = [
    { id: 'sp1', name: 'Dr Amina Bello', organisation: 'FMoH' },
  ];
  const finding = {
    kind: 'speaker' as const,
    key: 2,
    name: 'Amina Bello',
    organisation: null,
    programmeSpeakerId: 'sp1',
    fromLine: 2,
    toLine: 4,
    confidence: 0.9,
  };
  const existing = (over: Partial<ExistingBinding>): ExistingBinding => ({
    ...binding(),
    id: 'b1',
    source: 'introduction',
    ...over,
  });

  it('turns a finding into a binding from its first line to the line after its last', () => {
    const plan = planReview([finding], lines, [], 'programme', speakers);
    expect(plan.add).toEqual([
      {
        kind: 'speaker',
        key: 2,
        name: 'Dr Amina Bello',
        organisation: 'FMoH',
        speakerId: 'sp1',
        status: 'auto',
        fromAt: d(10),
        toAt: d(40),
      },
    ]);
    expect(plan.remove).toEqual([]);
  });

  it('leaves the end open when the stretch runs to the last line', () => {
    const plan = planReview(
      [{ ...finding, toLine: 6 }],
      lines,
      [],
      'programme',
      speakers,
    );
    expect(plan.add[0].toAt).toBeNull();
  });

  it('drops low confidence, bad line numbers and names the setting ignores', () => {
    const plan = planReview(
      [
        { ...finding, confidence: 0.5 },
        { ...finding, fromLine: 0 },
        { ...finding, toLine: 99 },
        { ...finding, fromLine: 4, toLine: 2 },
        { ...finding, name: 'Nobody Known', programmeSpeakerId: null },
      ],
      lines,
      [],
      'programme',
      speakers,
    );
    expect(plan.add).toEqual([]);
    expect(plan.skipped).toBe(5);
  });

  it('suggests a stranger when the event names everyone', () => {
    const plan = planReview(
      [{ ...finding, name: 'Ngozi Adeyemi', programmeSpeakerId: null }],
      lines,
      [],
      'everyone',
      speakers,
    );
    expect(plan.add[0]).toMatchObject({
      name: 'Ngozi Adeyemi',
      status: 'suggested',
      speakerId: null,
    });
  });

  it('replaces the automatic bindings it overlaps, never a confirmed or operator one', () => {
    const auto = existing({ id: 'auto', fromAt: d(0), toAt: d(25) });
    const elsewhere = existing({ id: 'later', fromAt: d(45), toAt: null });
    let plan = planReview(
      [finding],
      lines,
      [auto, elsewhere],
      'programme',
      speakers,
    );
    expect(plan.remove).toEqual(['auto']);
    expect(plan.add).toHaveLength(1);

    plan = planReview(
      [finding],
      lines,
      [
        existing({
          id: 'kept',
          status: 'confirmed',
          fromAt: d(0),
          toAt: d(25),
        }),
      ],
      'programme',
      speakers,
    );
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.skipped).toBe(1);

    plan = planReview(
      [finding],
      lines,
      [existing({ id: 'typed', source: 'operator', fromAt: d(0), toAt: null })],
      'programme',
      speakers,
    );
    expect(plan.add).toEqual([]);
  });

  it('leaves a binding that already says the same thing alone', () => {
    const same = existing({ id: 'same', fromAt: d(10), toAt: d(40) });
    const plan = planReview([finding], lines, [same], 'programme', speakers);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.skipped).toBe(0);
  });
});
