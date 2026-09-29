import type { ConfigService } from '@nestjs/config';

/**
 * A positive number from the environment, or the fallback when it is unset or
 * not a positive number. Captions' timings and limits read through this, so a
 * bad value degrades to the tested default instead of, say, polling every 0 ms.
 */
export function positiveSetting(
  config: Pick<ConfigService, 'get'> | undefined,
  key: string,
  fallback: number,
): number {
  const value = Number(config?.get<string | number>(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
