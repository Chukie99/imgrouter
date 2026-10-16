import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  apiKey TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cooldownUntil INTEGER,
  dayUsed INTEGER NOT NULL DEFAULT 0,
  dayLimit INTEGER NOT NULL DEFAULT 5,
  okCount INTEGER NOT NULL DEFAULT 0,
  failCount INTEGER NOT NULL DEFAULT 0,
  resetAt INTEGER,
  lastUsedAt INTEGER,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  stylePrompt TEXT,
  refImagePath TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  idx INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  outputPath TEXT,
  FOREIGN KEY (projectId) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  sceneId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  leaseUntil INTEGER,
  lastError TEXT,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (sceneId) REFERENCES scenes(id)
);

CREATE TABLE IF NOT EXISTS quota_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId TEXT NOT NULL,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  observedLimit INTEGER
);

CREATE TABLE IF NOT EXISTS client_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  lastUsedAt INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(projectId);
`;

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  instance = db;
  return instance;
}
