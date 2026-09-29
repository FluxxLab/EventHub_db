/**
 * Trivia scoring (FR-10), decided 26 Sep 2026. Kept deliberately simple so a
 * delegate can work out their own score:
 *
 * - a correct answer is worth BASE_POINTS (100);
 * - plus a speed bonus of up to SPEED_BONUS_MAX (50), falling linearly from
 *   the moment the question went live to nothing after SPEED_WINDOW_SECONDS
 *   (30, the countdown the app shows). Answering after 3 s earns
 *   floor(50 * (1 - 3/30)) = 45, so 145 in all;
 * - a wrong answer, or no answer, is worth 0. There is no penalty for trying.
 *
 * A question made live before `liveAt` existed has no start time, so its
 * correct answers score the base alone.
 *
 * Answers are scored when the question closes, never before: until then the
 * score would give the answer away. `scoreQuestionSql` does it in one UPDATE
 * and must agree with `pointsFor`, which the specs pin.
 */
export const BASE_POINTS = 100;
export const SPEED_BONUS_MAX = 50;
export const SPEED_WINDOW_SECONDS = 30;

export function pointsFor(correct: boolean, elapsedMs: number | null): number {
  if (!correct) return 0;
  if (elapsedMs === null) return BASE_POINTS;
  const left = 1 - Math.max(0, elapsedMs) / (SPEED_WINDOW_SECONDS * 1000);
  const bonus = Math.floor(SPEED_BONUS_MAX * left);
  return BASE_POINTS + Math.min(SPEED_BONUS_MAX, Math.max(0, bonus));
}

/**
 * Scores every answer to one question in place: $1 question id, $2 correct
 * option, $3 when it went live (or null). Re-running it re-scores, which is
 * what a corrected answer key needs.
 */
export const scoreQuestionSql = `
  UPDATE "trivia_answers" SET "points" = CASE
    WHEN "chosenOption"::text <> $2 THEN 0
    WHEN $3::timestamptz IS NULL THEN ${BASE_POINTS}
    ELSE ${BASE_POINTS} + LEAST(${SPEED_BONUS_MAX}, GREATEST(0, FLOOR(
      ${SPEED_BONUS_MAX} * (1 - GREATEST(0, EXTRACT(EPOCH FROM ("createdAt" - $3::timestamptz))) / ${SPEED_WINDOW_SECONDS})
    )))::int
  END
  WHERE "questionId" = $1`;
