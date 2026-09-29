/**
 * An edition's audience: every delegate who holds a ticket for it, or who
 * bookmarked or attended one of its sessions. One definition shared by the
 * cards' "N delegates registered" line and the attendees list, so the number
 * on the card and the length of the list it opens cannot drift apart.
 *
 * `editionMatch` is the right-hand side of the edition filter, written by
 * the caller in its own placeholder style: `= ANY($1)` for a raw query over
 * many editions, `= :editionId` inside a query builder. It is never built
 * from user input. UNION (not UNION ALL) leaves one row per delegate per
 * edition however many ways they are connected to it.
 *
 * Shape matters at 3,000 delegates: the edition filter sits on `sessions`
 * inside every branch, so each branch starts from the requested editions'
 * sessions (index on sessions."editionId") and walks into bookmarks and
 * attendance by "sessionId" (indexes from the ScaleIndexes migration). The
 * earlier shape UNIONed the whole of both tables before joining sessions,
 * which de-duplicated every bookmark on the platform on every card render.
 */
export function editionAudienceSql(editionMatch: string): string {
  return `
    SELECT s."editionId" AS "editionId", b."delegateId" AS "delegateId"
    FROM sessions s
    JOIN session_bookmarks b ON b."sessionId" = s.id
    WHERE s."editionId" ${editionMatch}
    UNION
    SELECT s."editionId" AS "editionId", a."delegateId" AS "delegateId"
    FROM sessions s
    JOIN session_attendance a ON a."sessionId" = s.id
    WHERE s."editionId" ${editionMatch}
    UNION
    SELECT t."editionId" AS "editionId", t."delegateId" AS "delegateId"
    FROM tickets t
    WHERE t."editionId" ${editionMatch}`;
}
