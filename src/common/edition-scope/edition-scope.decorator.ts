import { SetMetadata } from '@nestjs/common';

export const EDITION_SCOPE_KEY = 'editionScope';

/**
 * What a request's `id`-like value points at, and so how to find its
 * edition. `sessions` takes a list of session ids (bulk actions);
 * `ticketCode` a scanned `PICT1.<ticketId>.<signature>` payload.
 */
export type EditionVia =
  | 'edition'
  | 'session'
  | 'sessions'
  | 'poll'
  | 'comment'
  | 'question'
  | 'material'
  | 'room'
  | 'booth'
  | 'ticketType'
  | 'review'
  | 'ticketCode'
  | 'trivia'
  | 'pitchTopic'
  | 'pitchEntry'
  | 'notification'
  | 'campaign'
  | 'galleryAlbum'
  | 'galleryPhoto'
  | 'libraryItem'
  | 'meal'
  | 'mealCounter';

/**
 * Where an endpoint's edition comes from, for the EditionScopeGuard:
 * - a value in the route params, query or body (`key` may end in `[]` for a
 *   body that is an array, `*.editionId`), looked up `via` its table;
 * - `current`: the edition the app shows (live-day tools act on it);
 * - `any`: not tied to one edition (a speaker, an upload URL); the person
 *   only needs to run at least one;
 * - `list`: the handler narrows its result to `req.editionScope` itself.
 */
export type EditionSource =
  | { from: 'param' | 'query' | 'body'; key: string; via?: EditionVia }
  | { from: 'current' | 'any' | 'list' };

/**
 * Opens an endpoint to event organisers, for the editions they run. List it
 * with `@Roles(..., AccessTier.EVENT_ADMIN)`. Sources are tried in order and
 * the first that yields a value decides, so `{ from: 'query', key:
 * 'sessionId', via: 'session' }, { from: 'current' }` means "that session's
 * edition, else the current one". A route that lets event organisers in
 * without this is refused outright.
 */
export const EditionScoped = (...sources: EditionSource[]) =>
  SetMetadata(EDITION_SCOPE_KEY, sources);
