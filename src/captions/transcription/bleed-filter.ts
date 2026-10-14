/**
 * Mic bleed in a multi-mic room: a speaker's voice also reaches the mics
 * beside theirs, more quietly, and each channel is transcribed on its own -
 * so the same words arrive twice, in overlapping pieces, credited to two
 * people. This keeps one copy.
 *
 * Each final is held for a moment. If another mic produced most of the same
 * words in that time, the copy Deepgram heard more clearly (higher
 * confidence: the speaker's own mic) is kept and the other dropped; an echo
 * arriving after its original was already let through is dropped too. Lines
 * are never merged or edited, only kept or dropped, and a mic that is not
 * echoing anyone passes through after the hold.
 */
export interface BleedFinal {
  text: string;
  channel: number;
  /** Deepgram's confidence in the transcript, 0-1. */
  confidence: number;
  /** Lets the line through to captions. */
  emit: () => void;
}

interface Held extends BleedFinal {
  words: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface Released {
  channel: number;
  words: Set<string>;
  at: number;
}

/** The words of a line, for comparing: lower-case, without punctuation, one-letter words left out. */
export function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/** Share of the shorter line's words that the other also has (0-1). */
export function overlap(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let common = 0;
  for (const w of small) if (large.has(w)) common++;
  return common / small.size;
}

export class BleedFilter {
  private held: Held[] = [];
  private released: Released[] = [];

  constructor(
    /** How long a final waits for an echo from another mic. */
    private readonly holdMs = 1000,
    /** How long a let-through line still catches late echoes. */
    private readonly windowMs = 3000,
    /** Overlap at which two lines count as one said twice. */
    private readonly threshold = 0.6,
    private readonly now: () => number = Date.now,
  ) {}

  push(final: BleedFinal): void {
    const words = wordsOf(final.text);
    // two words are too few to call an echo ("yes okay"); let them through
    if (words.size < 3) {
      final.emit();
      return;
    }
    const now = this.now();
    this.released = this.released.filter((r) => now - r.at <= this.windowMs);
    const echoesShown = this.released.some(
      (r) =>
        r.channel !== final.channel &&
        overlap(r.words, words) >= this.threshold,
    );
    if (echoesShown) return;

    const rival = this.held.find(
      (h) =>
        h.channel !== final.channel &&
        overlap(h.words, words) >= this.threshold,
    );
    if (rival) {
      if (final.confidence <= rival.confidence) return; // the held one is the clearer
      clearTimeout(rival.timer);
      this.held = this.held.filter((h) => h !== rival);
    }
    const held: Held = {
      ...final,
      words,
      timer: setTimeout(() => this.release(held), this.holdMs),
    };
    this.held.push(held);
  }

  /** Lets everything still held through, as the stream closes. */
  flush(): void {
    for (const h of this.held) {
      clearTimeout(h.timer);
      h.emit();
    }
    this.held = [];
  }

  private release(held: Held): void {
    this.held = this.held.filter((h) => h !== held);
    this.released.push({
      channel: held.channel,
      words: held.words,
      at: this.now(),
    });
    held.emit();
  }
}
