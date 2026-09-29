const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The event a `*:join` / `*:leave` message names, from `{ editionId }` or a
 * bare id. Anything else (nothing, a malformed id) is null, which the event
 * gateways treat as the summit-wide room older clients join.
 */
export function editionFromJoin(body: unknown): string | null {
  const value =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).editionId
      : body;
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/**
 * Where an event-scoped push goes: the event's own room, plus the
 * summit-wide room so clients that join without naming an event (the
 * console) keep hearing everything. socket.io delivers once to a socket in
 * both. A row made before events were linked has no event room.
 */
export function eventRooms(
  all: string,
  one: (editionId: string) => string,
  editionId: string | null | undefined,
): string | string[] {
  return editionId ? [one(editionId), all] : all;
}
