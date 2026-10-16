import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";
import type { Job, Project, Scene, SceneStatus } from "./types.js";

type Row = Record<string, unknown>;

function toProject(row: Row | undefined): Project | null {
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    stylePrompt: row.stylePrompt == null ? null : String(row.stylePrompt),
    refImagePath: row.refImagePath == null ? null : String(row.refImagePath),
    createdAt: Number(row.createdAt),
  };
}

function toScene(row: Row | undefined): Scene | null {
  if (!row) return null;
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    idx: Number(row.idx),
    prompt: String(row.prompt),
    status: row.status as SceneStatus,
    outputPath: row.outputPath == null ? null : String(row.outputPath),
  };
}

export interface CreateProjectInput {
  title: string;
  stylePrompt?: string | null;
  refImagePath?: string | null;
  prompts: string[];
}

export function createProjectWithScenes(input: CreateProjectInput): { project: Project; sceneIds: string[] } {
  const db = getDb();
  const now = Date.now();
  const project: Project = {
    id: randomUUID(),
    title: input.title,
    stylePrompt: input.stylePrompt ?? null,
    refImagePath: input.refImagePath ?? null,
    createdAt: now,
  };

  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO projects (id,title,stylePrompt,refImagePath,createdAt) VALUES (?,?,?,?,?)").run(
      project.id,
      project.title,
      project.stylePrompt,
      project.refImagePath,
      project.createdAt,
    );

    const insertScene = db.prepare(
      "INSERT INTO scenes (id,projectId,idx,prompt,status,outputPath) VALUES (?,?,?,?,?,?)",
    );
    const insertJob = db.prepare(
      "INSERT INTO jobs (id,sceneId,projectId,state,attempts,leaseUntil,lastError,updatedAt) VALUES (?,?,?,?,?,?,?,?)",
    );

    const sceneIds: string[] = [];
    input.prompts.forEach((prompt, idx) => {
      const sceneId = randomUUID();
      insertScene.run(sceneId, project.id, idx, prompt, "pending", null);
      insertJob.run(randomUUID(), sceneId, project.id, "pending", 0, null, null, now);
      sceneIds.push(sceneId);
    });

    db.exec("COMMIT");
    return { project, sceneIds };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listProjects(): Project[] {
  const rows = getDb().prepare("SELECT * FROM projects ORDER BY createdAt DESC").all() as Row[];
  return rows.map((r) => toProject(r)).filter((p): p is Project => p !== null);
}

export function getProject(id: string): Project | null {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  return toProject(row);
}

export interface ProjectProgress {
  total: number;
  done: number;
  failed: number;
  deferred: number;
  running: number;
}

/** Per-project scene/job tallies for the dashboard (done/failed from scenes, deferred/running from jobs). */
export function progressByProject(): Record<string, ProjectProgress> {
  const db = getDb();
  const out: Record<string, ProjectProgress> = {};
  const ensure = (id: string): ProjectProgress => (out[id] ??= { total: 0, done: 0, failed: 0, deferred: 0, running: 0 });

  const sceneRows = db
    .prepare(
      `SELECT projectId,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM scenes GROUP BY projectId`,
    )
    .all() as Row[];
  for (const row of sceneRows) {
    const progress = ensure(String(row.projectId));
    progress.total = Number(row.total);
    progress.done = Number(row.done);
    progress.failed = Number(row.failed);
  }

  const jobRows = db
    .prepare(
      `SELECT projectId,
              SUM(CASE WHEN state = 'deferred' THEN 1 ELSE 0 END) AS deferred,
              SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running
       FROM jobs GROUP BY projectId`,
    )
    .all() as Row[];
  for (const row of jobRows) {
    const progress = ensure(String(row.projectId));
    progress.deferred = Number(row.deferred);
    progress.running = Number(row.running);
  }

  return out;
}

export function getScenes(projectId: string): Scene[] {
  const rows = getDb()
    .prepare("SELECT * FROM scenes WHERE projectId = ? ORDER BY idx ASC")
    .all(projectId) as Row[];
  return rows.map((r) => toScene(r)).filter((s): s is Scene => s !== null);
}

export interface AnchorInfo {
  status: SceneStatus;
  outputPath: string | null;
}

/** Scene #0 of a project acts as the consistency anchor for its siblings. */
export function getAnchor(projectId: string): AnchorInfo | null {
  const row = getDb()
    .prepare("SELECT status, outputPath FROM scenes WHERE projectId = ? AND idx = 0")
    .get(projectId) as Row | undefined;
  if (!row) return null;
  return {
    status: row.status as SceneStatus,
    outputPath: row.outputPath == null ? null : String(row.outputPath),
  };
}

export function getScene(id: string): Scene | null {
  const row = getDb().prepare("SELECT * FROM scenes WHERE id = ?").get(id) as Row | undefined;
  return toScene(row);
}

export function updateScene(id: string, patch: Partial<Pick<Scene, "status" | "outputPath">>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => (value as string | null));
  getDb().prepare(`UPDATE scenes SET ${sets} WHERE id = ?`).run(...values, id);
}

export type { Job };
