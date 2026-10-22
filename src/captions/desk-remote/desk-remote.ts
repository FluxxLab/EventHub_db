/**
 * Running a sound desk from another computer.
 *
 * The desk is a browser on the laptop wired to the venue's mixer. It reports
 * what it has (its input channels, how each room is patched, what is on air)
 * every few seconds, and does what an organiser asks from their own console:
 * patch a room to a channel, start it, stop it. The server only passes the
 * report and the requests along; the desk does the work, as if clicked there.
 */

export type DeskChannel = { value: string; label: string };
export type DeskRoom = {
  room: string;
  /** The channel it is patched to, or null. */
  source: string | null;
  /** 'capturing', 'connecting', 'error'… or null when not running. */
  status: string | null;
  message: string | null;
};
export type DeskState = {
  deskId: string;
  name: string;
  /** False until someone on the desk has opened its audio inputs. */
  connected: boolean;
  channels: DeskChannel[];
  rooms: DeskRoom[];
  reportedAt: string;
};

export type DeskAction = 'patch' | 'start' | 'stop';
export type DeskCommand = {
  id: string;
  action: DeskAction;
  room: string;
  /** For patch: the channel, or '' to unpatch. */
  source?: string;
  by: string;
};

const str = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** A desk's report as it is kept, or null when it is not one. */
export function cleanState(body: unknown, now = new Date()): DeskState | null {
  const b = body as Record<string, unknown> | null;
  const deskId = str(b?.deskId, 64);
  if (!deskId || !/^[a-z0-9-]+$/i.test(deskId)) return null;
  const channels = (Array.isArray(b?.channels) ? b.channels : [])
    .slice(0, 64)
    .map((c) => {
      const o = c as Record<string, unknown>;
      const value = str(o?.value, 300);
      return value ? { value, label: str(o?.label, 120) ?? value } : null;
    })
    .filter((c): c is DeskChannel => c !== null);
  const rooms = (Array.isArray(b?.rooms) ? b.rooms : [])
    .slice(0, 40)
    .map((r) => {
      const o = r as Record<string, unknown>;
      const room = str(o?.room, 255);
      return room
        ? {
            room,
            source: str(o?.source, 300),
            status: str(o?.status, 20),
            message: str(o?.message, 200),
          }
        : null;
    })
    .filter((r): r is DeskRoom => r !== null);
  return {
    deskId,
    name: str(b?.name, 60) ?? `Desk ${deskId.slice(0, 4)}`,
    connected: b?.connected === true,
    channels,
    rooms,
    reportedAt: now.toISOString(),
  };
}
