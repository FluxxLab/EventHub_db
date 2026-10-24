import { findOffset, plainText } from './align-recording';

const SPEECH = [
  'Good afternoon everyone and welcome to the innovation showcase',
  'we have distinguished judges seated right here in front of us',
  'out of three hundred and forty three applications we shortlisted eighty nine',
  'there was a further review that was double blinded and done twice',
  'the top six innovators will pitch for five minutes each today',
  'my name is Peter and I am the founder of a learning app for students',
  'we serve more than one hundred and twenty thousand students in Nigeria',
  'students pay one dollar a month to get the AI tools on the app',
];

const DAY = Date.parse('2026-10-22T00:00:00Z');
const H = 3_600_000;

/** The recording: one line every 20 s from its start. */
const recording = SPEECH.map((text, i) => ({
  text,
  startMs: i * 20_000,
  endMs: i * 20_000 + 15_000,
}));

/** The live captions of the same speech, heard from `start`, split into short pieces and a little late. */
function liveFrom(start: number) {
  return SPEECH.flatMap((text, i) => {
    const ws = text.split(' ');
    const half = Math.ceil(ws.length / 2);
    return [
      { text: ws.slice(0, half).join(' '), at: start + i * 20_000 + 2_000 },
      { text: ws.slice(half).join(' '), at: start + i * 20_000 + 9_000 },
    ];
  });
}

describe('finding a recording on the day', () => {
  it('finds the true start when the given one is hours off', () => {
    const trueStart = DAY + 15.5 * H;
    const guess = trueStart - (6 * H + 29 * 60_000);
    const found = findOffset(recording, liveFrom(trueStart), guess);
    expect(found).not.toBeNull();
    expect(Math.abs(found!.offsetMs - (6 * H + 29 * 60_000))).toBeLessThan(
      10_000,
    );
  });

  it('confirms a start that was right', () => {
    const start = DAY + 10 * H;
    expect(
      Math.abs(findOffset(recording, liveFrom(start), start)!.offsetMs),
    ).toBeLessThan(10_000);
  });

  it('gives no answer when the live captions do not hold the recording', () => {
    const other = [
      {
        text: 'a completely different conversation about energy and data centres in Lagos',
        at: DAY + 9 * H,
      },
    ];
    expect(findOffset(recording, other, DAY + 10 * H)).toBeNull();
  });

  it('ignores phrases said all day, like thank you very much', () => {
    const common = Array.from({ length: 40 }, (_, i) => ({
      text: 'thank you very much',
      at: DAY + i * 60_000,
    }));
    const rec = Array.from({ length: 40 }, (_, i) => ({
      text: 'thank you very much',
      startMs: i * 30_000,
      endMs: i * 30_000 + 2_000,
    }));
    expect(findOffset(rec, common, DAY + 5 * H)).toBeNull();
  });

  it('compares text plainly', () => {
    expect(plainText("Okay, so — it's   AI!")).toBe("okay so it's ai");
  });
});
