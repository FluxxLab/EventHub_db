/**
 * Nigerian numbers, written the way people write them.
 *
 * Delegates type 08012345678 because that is what is on their SIM card, and
 * the API was validating with a rule that only accepted +2348012345678, so
 * registration by SMS failed for anyone who wrote their own number normally.
 * Everything is normalised to E.164 here, once, so the SMS provider and the
 * stored profile only ever see one shape.
 *
 * A number that already carries a country code is left alone, so an
 * international delegate is unaffected.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[\s()\-.]/g, '');
  if (digits.startsWith('+')) return digits;
  // 08012345678 -> +2348012345678
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  // 2348012345678 -> +2348012345678
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  // 8012345678 -> +2348012345678
  if (/^[789]\d{9}$/.test(digits)) return `+234${digits}`;
  return digits;
}
