import { getDb } from "./index.js";
import type { Job, JobState, SchedulableJob, SceneStatus } from "./types.js";

type Row = Record<string, unknown>;

function toJob(row: Row): Job {
  return {
    id: String(row.id),
    sceneId: String(row.sceneId),
    projectId: String(row.projectId),
    state: row.state as JobState,
    attempts: Number(row.attempts),
    leaseUntil: row.leaseUntil == null ? null : Number(row.leaseUntil),
    lastError: row.lastError == null ? null : String(row.lastError),
    updatedAt: Number(row.updatedAt),
  };
}

export function listSchedulableJobs(): SchedulableJob[] {
  const rows = getDb()
    .prepare(
      `SELECT j.id, j.sceneId, j.projectId, j.state, j.attempts, j.leaseUntil, j.lastError, j.updatedAt,
              s.prompt AS scenePrompt, s.idx AS sceneIdx, s.status AS sceneStatus,
              p.refImagePath AS refImagePath, p.stylePrompt AS stylePrompt
       FROM jobs j
       JOIN scenes s ON s.id = j.sceneId
       JOIN projects p ON p.id = j.projectId
       WHERE j.state IN ('pending','deferred')
       ORDER BY j.updatedAt ASC, s.idx ASC`,
    )
    .all() as Row[];

  return rows.map((row) => ({
    job: toJob(row),
    prompt: String(row.scenePrompt),
    idx: Number(row.sceneIdx),
    sceneId: String(row.sceneId),
    projectId: String(row.projectId),
    sceneStatus: row.sceneStatus as SceneStatus,
    refImagePath: row.refImagePath == null ? null : String(row.refImagePath),
    stylePrompt: row.stylePrompt == null ? null : String(row.stylePrompt),
  }));
}

export function countByState(): Record<JobState, number> {
  const rows = getDb().prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as Row[];
  const counts: Record<JobState, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    deferred: 0,
  };
  for (const row of rows) {
    const state = row.state as JobState;
    if (state in counts) counts[state] = Number(row.n);
  }
  return counts;
}

function updateJob(id: string, patch: { state?: JobState; attempts?: number; lastError?: string | null }): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.state !== undefined) {
    sets.push("state = ?");
    values.push(patch.state);
  }
  if (patch.attempts !== undefined) {
    sets.push("attempts = ?");
    values.push(patch.attempts);
  }
  if (patch.lastError !== undefined) {
    sets.push("lastError = ?");
    values.push(patch.lastError);
  }
  sets.push("updatedAt = ?");
  values.push(Date.now());
  getDb().prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
}

export function markDone(id: string): void {
  updateJob(id, { state: "done", lastError: null });
}

export function markFailed(id: string, error: string): void {
  updateJob(id, { state: "failed", lastError: error });
}

export function markDeferred(id: string): void {
  updateJob(id, { state: "deferred" });
}

export function markRunning(id: string, leaseUntil: number): void {
  getDb()
    .prepare("UPDATE jobs SET state = 'running', leaseUntil = ?, updatedAt = ? WHERE id = ?")
    .run(leaseUntil, Date.now(), id);
}

/** Return jobs whose worker died (state='running' but the lease expired) to the queue. */
export function reclaimStale(now = Date.now()): number {
  const info = getDb()
    .prepare(
      "UPDATE jobs SET state = 'pending', updatedAt = ? WHERE state = 'running' AND (leaseUntil IS NULL OR leaseUntil <= ?)",
    )
    .run(now, now);
  return Number(info.changes);
}

export function setAttempts(id: string, attempts: number): void {
  updateJob(id, { attempts });
}

export function setLastError(id: string, error: string): void {
  updateJob(id, { lastError: error });
}

export function deferAllPending(): number {
  const info = getDb().prepare("UPDATE jobs SET state = 'deferred', updatedAt = ? WHERE state = 'pending'").run(Date.now());
  return Number(info.changes);
}

export function resetDeferredToPending(): void {
  getDb().prepare("UPDATE jobs SET state = 'pending', updatedAt = ? WHERE state = 'deferred'").run(Date.now());
}
