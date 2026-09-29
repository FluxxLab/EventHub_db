/**
 * A live transcription connection that reopens itself.
 *
 * Provider-agnostic on purpose: the Deepgram specifics (options, message
 * parsing) stay in deepgram.provider.ts, and this is the part that has to be
 * right under failure - so it is tested on its own with fake timers.
 */

export interface LiveConnection {
  send(chunk: Buffer): void;
  keepAlive(): void;
  close(): void;
}

export interface CloseInfo {
  code?: number;
  reason?: string;
}

export interface ResilientStreamOptions {
  room: string;
  /** Open one connection. `onClose` must fire once when it closes. */
  connect: (onClose: (info: CloseInfo) => void) => Promise<LiveConnection>;
  /** Fired after a dropped connection has been replaced (not on the first open). */
  onReopen?: () => void;
  log: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** 500ms, 1s, 2s, 4s ... capped. `attempt` is 1-based. */
export function reconnectDelay(
  attempt: number,
  baseDelayMs = 500,
  maxDelayMs = 30_000,
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export class ResilientStream {
  private current: LiveConnection | null = null;
  /** Which connect() call is live; closes from any older one are ignored. */
  private generation = 0;
  private liveGeneration = -1;
  private attempt = 0;
  private closing = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dropped = 0;
  /** A connection that closed before openOnce() had adopted it. */
  private closedBeforeLive = -1;

  constructor(private readonly opts: ResilientStreamOptions) {}

  /** The first open. Rejects if it fails, so capture:start can report it. */
  async start(): Promise<void> {
    await this.openOnce();
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /**
   * Returns false when the chunk was dropped because the connection is being
   * re-established.
   *
   * Dropped, deliberately not buffered: the desk's audio is a WebM stream, and
   * a fresh connection cannot decode the middle of a container without the
   * header that only the recorder's first chunk carries. Buffered chunks would
   * be undecodable on the new socket and make Deepgram hang up again. Instead
   * onReopen asks the desk for a new recording, whose first chunk carries the
   * header. Nothing is lost from the archive: the service writes every chunk
   * to the recording file before it gets here.
   */
  send(chunk: Buffer): boolean {
    const conn = this.current;
    if (!conn) {
      this.dropped += 1;
      return false;
    }
    conn.send(chunk);
    return true;
  }

  keepAlive(): void {
    try {
      this.current?.keepAlive();
    } catch {
      // the reconnect path covers a connection too far gone for this
    }
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const conn = this.current;
    this.current = null;
    conn?.close();
  }

  private async openOnce(): Promise<void> {
    const generation = ++this.generation;
    const conn = await this.opts.connect((info) =>
      this.onClosed(generation, info),
    );
    if (this.closing) {
      // closed while the connection was opening
      conn.close();
      return;
    }
    if (this.closedBeforeLive === generation) {
      throw new Error('connection closed as soon as it opened');
    }
    const isReopen = this.liveGeneration !== -1;
    this.current = conn;
    this.liveGeneration = generation;
    this.attempt = 0;
    this.opts.log.log(`stream open (${this.opts.room})`);
    if (isReopen) {
      if (this.dropped > 0) {
        this.opts.log.warn(
          `dropped ${this.dropped} audio chunk(s) while reconnecting (${this.opts.room})`,
        );
      }
      this.dropped = 0;
      this.opts.onReopen?.();
    }
  }

  private onClosed(generation: number, info: CloseInfo): void {
    // A connection that never became live, or one already replaced.
    if (generation !== this.liveGeneration) {
      if (generation === this.generation) this.closedBeforeLive = generation;
      return;
    }
    this.current = null;
    if (this.closing) return;
    this.opts.log.warn(
      `stream dropped (${this.opts.room}): code=${info.code ?? 'none'} reason=${info.reason || 'none'}`,
    );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.attempt += 1;
    const wait = reconnectDelay(
      this.attempt,
      this.opts.baseDelayMs,
      this.opts.maxDelayMs,
    );
    this.opts.log.warn(
      `reopening stream (${this.opts.room}) in ${wait}ms, attempt ${this.attempt}`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closing) return;
      this.openOnce().catch((error: Error) => {
        this.opts.log.error(
          `reopen failed (${this.opts.room}), attempt ${this.attempt}: ${error.message}`,
        );
        // Keep trying, backing off further each time, until close().
        this.scheduleReconnect();
      });
    }, wait);
  }
}
