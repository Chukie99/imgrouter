import { config } from "../config.js";

const DAY_MS = 86_400_000;

/**
 * Next daily quota reset boundary, expressed as an epoch timestamp.
 * The provider resets at local midnight in a fixed timezone; we model that zone
 * with a constant UTC offset (config.resetTzOffsetMinutes).
 */
export function defaultResetAt(from: number = Date.now()): number {
  const tzMs = config.resetTzOffsetMinutes * 60_000;
  const local = from + tzMs;
  const nextMidnightLocal = (Math.floor(local / DAY_MS) + 1) * DAY_MS;
  return nextMidnightLocal - tzMs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
