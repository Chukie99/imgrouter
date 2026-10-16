import { config } from "../config.js";
import { getAccount, listAccounts, logQuota, updateAccount } from "../db/accounts.js";
import type { Account } from "../db/types.js";
import { defaultResetAt } from "../scheduler/clock.js";

// In-process in-flight counter per account (not persisted — process-local pacing).
const inflight = new Map<string, number>();

// In-process sliding-window call timestamps per account, for proactive RPM pacing.
const recentCalls = new Map<string, number[]>();
const RPM_WINDOW_MS = 60_000;

// Serialize selection/mutation so two jobs can't reserve the same key slot at once.
let mutex: Promise<void> = Promise.resolve();

async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = mutex;
  let release: () => void = () => {};
  mutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function isCooledDown(account: Account, now: number): boolean {
  return account.cooldownUntil == null || account.cooldownUntil <= now;
}

/** True if the key still has proactive RPM headroom in the current 60s window (prunes stale stamps). */
function withinRpm(id: string, now: number): boolean {
  if (config.rpmPerKey <= 0) return true;
  const fresh = (recentCalls.get(id) ?? []).filter((t) => now - t < RPM_WINDOW_MS);
  if (fresh.length === 0) recentCalls.delete(id);
  else recentCalls.set(id, fresh);
  return fresh.length < config.rpmPerKey;
}

/** If the key is RPM-blocked, the timestamp at which its oldest call ages out; else null. */
function rpmUnblockAt(id: string, now: number): number | null {
  if (config.rpmPerKey <= 0) return null;
  const fresh = (recentCalls.get(id) ?? []).filter((t) => now - t < RPM_WINDOW_MS);
  if (fresh.length < config.rpmPerKey) return null;
  return fresh[0]! + RPM_WINDOW_MS;
}

/**
 * Reserve one account that has quota left and no active cooldown.
 * Caller MUST call releaseKey(id) when the request finishes.
 */
export async function acquireKey(exclude: Set<string>): Promise<Account | null> {
  return withLock(() => {
    const now = Date.now();
    const candidates = listAccounts().filter(
      (account) =>
        account.status === "active" &&
        isCooledDown(account, now) &&
        (config.providerManagedQuota || account.dayUsed < account.dayLimit) &&
        (inflight.get(account.id) ?? 0) < config.maxInflightPerKey &&
        withinRpm(account.id, now) &&
        !exclude.has(account.id),
    );
    if (candidates.length === 0) return null;

    // least-used: prefer the key idle longest, tie-break by lower daily usage
    candidates.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) || a.dayUsed - b.dayUsed);

    const chosen = candidates[0]!;
    inflight.set(chosen.id, (inflight.get(chosen.id) ?? 0) + 1);
    recentCalls.set(chosen.id, [...(recentCalls.get(chosen.id) ?? []), now]);
    updateAccount(chosen.id, { lastUsedAt: now });
    return chosen;
  });
}

export async function releaseKey(id: string): Promise<void> {
  await withLock(() => {
    const current = inflight.get(id) ?? 0;
    if (current <= 1) inflight.delete(id);
    else inflight.set(id, current - 1);
  });
}

export async function reportSuccess(id: string): Promise<void> {
  await withLock(() => {
    const account = getAccount(id);
    if (!account) return;
    updateAccount(id, {
      dayUsed: account.dayUsed + 1,
      okCount: account.okCount + 1,
      cooldownUntil: null,
      resetAt: account.resetAt ?? defaultResetAt(),
    });
    logQuota(id, "success", null);
  });
}

export async function reportRateLimited(id: string, retryAfterMs?: number): Promise<void> {
  await withLock(() => {
    const cooldown = Math.max(retryAfterMs ?? 0, config.rateLimitCooldownMs);
    updateAccount(id, { cooldownUntil: Date.now() + cooldown });
    logQuota(id, "rate_limited", null);
  });
}

export async function reportQuotaExhausted(id: string, resetAtMs?: number): Promise<void> {
  await withLock(() => {
    const account = getAccount(id);
    if (!account) return;
    const observed = account.dayUsed;
    // Learn the real per-key daily limit: shrink toward the observed success count.
    const learnedLimit = observed > 0 ? Math.min(account.dayLimit, observed) : account.dayLimit;
    updateAccount(id, {
      status: "blocked",
      resetAt: resetAtMs ?? defaultResetAt(),
      dayLimit: learnedLimit,
    });
    logQuota(id, "quota_exhausted", observed);
  });
}

export async function reportFailed(id: string): Promise<void> {
  await withLock(() => {
    const account = getAccount(id);
    if (!account) return;
    updateAccount(id, { failCount: account.failCount + 1 });
    logQuota(id, "failed", null);
  });
}

/** Reset daily counters for accounts whose quota window has rolled over. */
export async function rolloverAccounts(): Promise<number> {
  return withLock(() => {
    const now = Date.now();
    let reset = 0;
    for (const account of listAccounts()) {
      const blocked = account.status === "blocked";
      if ((blocked && account.resetAt == null) || (account.resetAt != null && account.resetAt <= now)) {
        updateAccount(account.id, { status: account.status === "disabled" ? "disabled" : "active", dayUsed: 0, resetAt: null, cooldownUntil: null });
        reset += 1;
      }
    }
    return reset;
  });
}

/** Total images still available across healthy keys right now. */
export function capacity(): number {
  const now = Date.now();
  return listAccounts()
    .filter((account) => account.status === "active" && isCooledDown(account, now))
    .reduce((sum, account) => sum + Math.max(0, account.dayLimit - account.dayUsed), 0);
}

/** Number of keys that could serve a request right now (used to size the worker pool). */
export function healthyKeyCount(): number {
  const now = Date.now();
  return listAccounts().filter(
    (account) =>
      account.status === "active" &&
      isCooledDown(account, now) &&
      (config.providerManagedQuota || account.dayUsed < account.dayLimit) &&
      (inflight.get(account.id) ?? 0) < config.maxInflightPerKey &&
      withinRpm(account.id, now),
  ).length;
}

/** Earliest future moment any key could serve again (quota reset, cooldown expiry, or RPM slot). */
export function nextWakeAt(): number | null {
  const now = Date.now();
  let earliest: number | null = null;
  const consider = (candidate: number | null | undefined): void => {
    if (candidate == null || candidate <= now) return;
    if (earliest == null || candidate < earliest) earliest = candidate;
  };

  for (const account of listAccounts()) {
    if (account.status === "disabled") continue;
    if (account.status === "blocked") {
      consider(account.resetAt);
      continue;
    }
    consider(account.cooldownUntil);
    if ((config.providerManagedQuota || account.dayUsed < account.dayLimit)) consider(rpmUnblockAt(account.id, now));
  }
  return earliest;
}

