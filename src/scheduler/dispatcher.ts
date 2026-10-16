import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import * as keyPool from "../pool/keyPool.js";
import * as jobs from "../db/jobs.js";
import { getAnchor, updateScene } from "../db/projects.js";
import { generateImage } from "../worker/generator.js";
import { saveImage } from "../storage/save.js";
import { defaultResetAt, sleep } from "./clock.js";
import type { ReferenceImage } from "../worker/generator.js";
import type { SchedulableJob } from "../db/types.js";

export interface RunSummary {
  dispatched: number;
  done: number;
  failed: number;
  deferred: number;
  capacity: number;
  nextWakeAt: number | null;
}

type JobResult = "done" | "failed" | "deferred";

// Cache decoded reference images so a 50-scene project reads each file once.
const refCache = new Map<string, ReferenceImage>();

function mimeFor(abs: string): string {
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function loadReference(refImagePath: string | null): ReferenceImage | undefined {
  if (!refImagePath) return undefined;
  const abs = path.isAbsolute(refImagePath) ? refImagePath : path.resolve(process.cwd(), refImagePath);
  const cached = refCache.get(abs);
  if (cached) return cached;
  if (!fs.existsSync(abs)) {
    console.warn(`[dispatcher] reference image not found, ignoring: ${abs}`);
    return undefined;
  }
  const ref: ReferenceImage = { mimeType: mimeFor(abs), data: fs.readFileSync(abs).toString("base64") };
  refCache.set(abs, ref);
  return ref;
}

/**
 * Resolve the reference image path for a job.
 * - explicit project refImagePath wins;
 * - scene #0 is the anchor and generates freely (no reference);
 * - siblings wait for the anchor, then reuse its output for character consistency;
 * - "wait" means hold this job until the anchor is ready.
 */
function resolveReference(item: SchedulableJob): string | null | "wait" {
  if (item.refImagePath) return item.refImagePath;
  if (item.idx === 0) return null;

  const anchor = getAnchor(item.projectId);
  if (!anchor) return null; // no anchor scene → don't block
  if (anchor.status === "done") return anchor.outputPath;
  if (anchor.status === "failed") return null; // anchor failed → don't deadlock the project
  return "wait";
}

function anchorWait(item: SchedulableJob): boolean {
  return resolveReference(item) === "wait";
}

function anchorRank(item: SchedulableJob): number {
  return !item.refImagePath && item.idx === 0 ? 0 : 1;
}

async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const size = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;

  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}

async function processJob(item: SchedulableJob): Promise<JobResult> {
  const refPath = resolveReference(item);
  if (refPath === "wait") {
    jobs.markDeferred(item.job.id);
    return "deferred";
  }
  const reference = loadReference(refPath);
  jobs.markRunning(item.job.id, Date.now() + config.leaseTimeoutMs);

  const exclude = new Set<string>();
  let attempts = item.job.attempts;

  while (attempts < config.maxAttempts) {
    const account = await keyPool.acquireKey(exclude);
    if (!account) {
      jobs.markDeferred(item.job.id);
      return "deferred";
    }

    try {
      const prompt = item.stylePrompt ? `${item.stylePrompt}\n\n${item.prompt}` : item.prompt;
      const outcome = await generateImage(account, {
        prompt,
        referenceImages: reference ? [reference] : undefined,
      });

      if (outcome.ok) {
        const outputPath = saveImage(item.projectId, item.idx, outcome.b64);
        updateScene(item.sceneId, { status: "done", outputPath });
        jobs.markDone(item.job.id);
        await keyPool.reportSuccess(account.id);
        return "done";
      }

      attempts += 1;
      exclude.add(account.id);
      jobs.setAttempts(item.job.id, attempts);
      jobs.setLastError(item.job.id, outcome.message);

      if (outcome.kind === "quota_exhausted") {
        await keyPool.reportQuotaExhausted(account.id, outcome.resetAtMs);
      } else if (outcome.kind === "rate_limited") {
        await keyPool.reportRateLimited(account.id, outcome.retryAfterMs);
      } else {
        await keyPool.reportFailed(account.id);
      }

      if (attempts >= config.maxAttempts) {
        updateScene(item.sceneId, { status: "failed" });
        jobs.markFailed(item.job.id, outcome.message);
        return "failed";
      }
    } finally {
      await keyPool.releaseKey(account.id);
    }
  }

  updateScene(item.sceneId, { status: "failed" });
  jobs.markFailed(item.job.id, "max attempts reached");
  return "failed";
}

/** Dispatch one batch of ready jobs (anchors first). Returns how many actually ran. */
async function dispatchWave(summary: RunSummary): Promise<number> {
  const ready = jobs.listSchedulableJobs().filter((item) => !anchorWait(item));
  if (ready.length === 0) return 0;

  const cap = keyPool.capacity();
  if (cap <= 0) return 0;

  ready.sort((a, b) => anchorRank(a) - anchorRank(b));
  const batch = ready.slice(0, Math.min(cap, ready.length));
  const concurrency = Math.max(1, Math.min(batch.length, keyPool.healthyKeyCount() || 1));
  const results = await runPool(batch, concurrency, (item) => processJob(item));

  for (const result of results) {
    summary.dispatched += 1;
    if (result === "done") summary.done += 1;
    else if (result === "failed") summary.failed += 1;
    else summary.deferred += 1;
  }
  return results.length;
}

export async function runOnce(): Promise<RunSummary> {
  await keyPool.rolloverAccounts();
  jobs.reclaimStale();

  const summary: RunSummary = {
    dispatched: 0,
    done: 0,
    failed: 0,
    deferred: 0,
    capacity: keyPool.capacity(),
    nextWakeAt: null,
  };

  // Wave 1: jobs that can run now (including each project's anchor scene).
  await dispatchWave(summary);
  // Wave 2: siblings whose anchor was just produced by wave 1.
  await dispatchWave(summary);

  // Whatever we could not start now waits for the next quota window.
  jobs.deferAllPending();
  const counts = jobs.countByState();
  summary.deferred = counts.deferred;
  summary.nextWakeAt = counts.deferred + counts.pending > 0 ? (keyPool.nextWakeAt() ?? defaultResetAt()) : null;
  return summary;
}

export async function runLoop(stop: { stopped: boolean }): Promise<void> {
  while (!stop.stopped) {
    let wait = config.dispatcherIntervalMs;
    try {
      const summary = await runOnce();
      const now = Date.now();
      if (summary.nextWakeAt && summary.nextWakeAt > now) {
        wait = Math.min(wait, summary.nextWakeAt - now);
      }
      if (summary.dispatched > 0) {
        console.log(
          `[dispatcher] dispatched=${summary.dispatched} done=${summary.done} failed=${summary.failed} deferred=${summary.deferred} capacity=${summary.capacity}`,
        );
      }
    } catch (error) {
      console.error("[dispatcher] run failed:", (error as Error).message);
    }
    await sleep(Math.max(1000, wait));
  }
}
