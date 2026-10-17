import type { TranscriptSegment } from './entities/transcript-segment.entity';

/**
 * When a stored line was said. Its own module so the speaker-naming side can
 * order rows without importing CaptionsService (which imports it back).
 */

/** A stored row's ordering key; archived rows share a createdAt, so add the offset. */
export function seqOf(
  row: Pick<TranscriptSegment, 'createdAt' | 'offsetMs'>,
): number {
  return row.createdAt.getTime() + (row.offsetMs ?? 0);
}

/**
 * seqOf in SQL: the moment a row was said. Live, back-filled and newly
 * archived rows carry it in createdAt; a session archived before archive rows
 * had absolute times shares one createdAt and keeps its order by offset.
 */
export function effectiveTimeSql(alias: string): string {
  return `("${alias}"."createdAt" + COALESCE("${alias}"."offsetMs", 0) * INTERVAL '1 millisecond')`;
}
