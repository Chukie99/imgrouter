export type AccountStatus = "active" | "blocked" | "disabled";

export interface Account {
  id: string;
  label: string;
  apiKey: string;
  status: AccountStatus;
  cooldownUntil: number | null;
  dayUsed: number;
  dayLimit: number;
  okCount: number;
  failCount: number;
  resetAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface Project {
  id: string;
  title: string;
  stylePrompt: string | null;
  refImagePath: string | null;
  createdAt: number;
}

export type SceneStatus = "pending" | "done" | "failed";

export interface Scene {
  id: string;
  projectId: string;
  idx: number;
  prompt: string;
  status: SceneStatus;
  outputPath: string | null;
}

export type JobState = "pending" | "running" | "done" | "failed" | "deferred";

export interface Job {
  id: string;
  sceneId: string;
  projectId: string;
  state: JobState;
  attempts: number;
  leaseUntil: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface SchedulableJob {
  job: Job;
  prompt: string;
  idx: number;
  sceneId: string;
  projectId: string;
  sceneStatus: SceneStatus;
  refImagePath: string | null;
  stylePrompt: string | null;
}

export type QuotaEvent = "success" | "rate_limited" | "quota_exhausted" | "failed";
