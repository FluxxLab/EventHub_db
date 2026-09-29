import {
  reconnectDelay,
  ResilientStream,
  type CloseInfo,
  type LiveConnection,
} from './resilient-stream';

const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** A connect() whose outcomes the test scripts, one per call. */
function fakeProvider(outcomes: ('ok' | 'fail')[]) {
  const connections: {
    conn: LiveConnection & { sent: Buffer[]; closed: boolean };
    drop: (info?: CloseInfo) => void;
  }[] = [];
  let calls = 0;
  const connect = jest.fn((onClose: (info: CloseInfo) => void) => {
    const outcome = outcomes[calls++] ?? 'ok';
    if (outcome === 'fail') return Promise.reject(new Error('503'));
    const conn = {
      sent: [] as Buffer[],
      closed: false,
      send(chunk: Buffer) {
        this.sent.push(chunk);
      },
      keepAlive() {},
      close() {
        this.closed = true;
      },
    };
    connections.push({ conn, drop: (info = {}) => onClose(info) });
    return Promise.resolve(conn);
  });
  return { connect, connections };
}

describe('reconnectDelay', () => {
  it('doubles from 500ms and caps at 30s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => reconnectDelay(n))).toEqual([
      500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe('ResilientStream', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  it('keeps retrying with growing backoff when reopening fails, then resumes', async () => {
    const { connect, connections } = fakeProvider([
      'ok',
      'fail',
      'fail',
      'fail',
      'ok',
    ]);
    const onReopen = jest.fn();
    const stream = new ResilientStream({
      room: 'hall',
      connect,
      onReopen,
      log,
    });
    await stream.start();

    connections[0].drop({ code: 1011, reason: 'NET-0001' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('code=1011 reason=NET-0001'),
    );

    // 500ms, then 1s, then 2s, then 4s
    await jest.advanceTimersByTimeAsync(499);
    expect(connect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(onReopen).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(4000);
    expect(connect).toHaveBeenCalledTimes(5);

    expect(stream.isOpen).toBe(true);
    expect(onReopen).toHaveBeenCalledTimes(1);
    stream.send(Buffer.from('x'));
    expect(connections[1].conn.sent).toHaveLength(1);
  });

  it('never waits longer than 30s between attempts', async () => {
    const { connect } = fakeProvider(['ok', ...Array<'fail'>(12).fill('fail')]);
    const stream = new ResilientStream({ room: 'hall', connect, log });
    await stream.start();
    const first = connect.mock.calls[0][0];
    first({});
    // after enough failures every gap is the cap
    await jest.advanceTimersByTimeAsync(
      500 + 1000 + 2000 + 4000 + 8000 + 16000,
    );
    const before = connect.mock.calls.length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(connect.mock.calls.length).toBe(before + 1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(connect.mock.calls.length).toBe(before + 2);
    stream.close();
  });

  it('drops audio while reconnecting instead of writing to the dead socket', async () => {
    const { connect, connections } = fakeProvider(['ok', 'ok']);
    const stream = new ResilientStream({ room: 'hall', connect, log });
    await stream.start();
    connections[0].drop({ code: 1006 });

    expect(stream.send(Buffer.from('lost'))).toBe(false);
    expect(connections[0].conn.sent).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(500);
    expect(stream.send(Buffer.from('kept'))).toBe(true);
    expect(connections[1].conn.sent.map(String)).toEqual(['kept']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 audio chunk'),
    );
  });

  it('stops retrying once closed, and ignores closes from replaced connections', async () => {
    const { connect, connections } = fakeProvider(['ok', 'ok']);
    const stream = new ResilientStream({ room: 'hall', connect, log });
    await stream.start();
    connections[0].drop();
    await jest.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(2);

    connections[0].drop(); // a late duplicate close from the old socket
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);

    stream.close();
    expect(connections[1].conn.closed).toBe(true);
    connections[1].drop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('rejects start() when the first connection fails', async () => {
    const { connect } = fakeProvider(['fail']);
    const stream = new ResilientStream({ room: 'hall', connect, log });
    await expect(stream.start()).rejects.toThrow('503');
  });
});
