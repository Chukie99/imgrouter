import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";
import { config } from "../config.js";
import type { Account, AccountStatus, QuotaEvent } from "./types.js";

type Row = Record<string, unknown>;

function toAccount(row: Row | undefined): Account | null {
  if (!row) return null;
  return {
    id: String(row.id),
    label: String(row.label),
    apiKey: String(row.apiKey),
    status: row.status as AccountStatus,
    cooldownUntil: row.cooldownUntil == null ? null : Number(row.cooldownUntil),
    dayUsed: Number(row.dayUsed),
    dayLimit: Number(row.dayLimit),
    okCount: Number(row.okCount),
    failCount: Number(row.failCount),
    resetAt: row.resetAt == null ? null : Number(row.resetAt),
    lastUsedAt: row.lastUsedAt == null ? null : Number(row.lastUsedAt),
    createdAt: Number(row.createdAt),
  };
}

const UPDATABLE = [
  "label",
  "apiKey",
  "status",
  "cooldownUntil",
  "dayUsed",
  "dayLimit",
  "okCount",
  "failCount",
  "resetAt",
  "lastUsedAt",
] as const;

export function createAccount(label: string, apiKey: string, dayLimit = config.defaultDayLimit): Account {
  const account: Account = {
    id: randomUUID(),
    label,
    apiKey,
    status: "active",
    cooldownUntil: null,
    dayUsed: 0,
    dayLimit,
    okCount: 0,
    failCount: 0,
    resetAt: null,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO accounts (id,label,apiKey,status,cooldownUntil,dayUsed,dayLimit,okCount,failCount,resetAt,lastUsedAt,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      account.id,
      account.label,
      account.apiKey,
      account.status,
      account.cooldownUntil,
      account.dayUsed,
      account.dayLimit,
      account.okCount,
      account.failCount,
      account.resetAt,
      account.lastUsedAt,
      account.createdAt,
    );
  return account;
}

export interface BulkResult {
  added: number;
  skipped: number;
}

/** Insert many accounts in one transaction, skipping keys that already exist. */
export function createAccounts(items: Array<{ label: string; apiKey: string; dayLimit?: number }>): BulkResult {
  const db = getDb();
  const existing = new Set(listAccounts().map((a) => a.apiKey));
  const insert = db.prepare(
    `INSERT INTO accounts (id,label,apiKey,status,cooldownUntil,dayUsed,dayLimit,okCount,failCount,resetAt,lastUsedAt,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  let added = 0;
  let skipped = 0;
  db.exec("BEGIN");
  try {
    for (const item of items) {
      const apiKey = item.apiKey.trim();
      if (!apiKey || existing.has(apiKey)) {
        skipped += 1;
        continue;
      }
      insert.run(
        randomUUID(),
        item.label?.trim() || apiKey.slice(-6),
        apiKey,
        "active",
        null,
        0,
        item.dayLimit ?? config.defaultDayLimit,
        0,
        0,
        null,
        null,
        Date.now(),
      );
      existing.add(apiKey);
      added += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { added, skipped };
}

export function deleteAccounts(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare("DELETE FROM accounts WHERE id = ?");
  let removed = 0;
  db.exec("BEGIN");
  try {
    for (const id of ids) removed += Number(stmt.run(id).changes);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return removed;
}

export function deleteAccountsByStatus(statuses: AccountStatus[]): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => "?").join(",");
  const info = getDb().prepare(`DELETE FROM accounts WHERE status IN (${placeholders})`).run(...statuses);
  return Number(info.changes);
}

export function listAccounts(): Account[] {
  const rows = getDb().prepare("SELECT * FROM accounts ORDER BY createdAt ASC").all() as Row[];
  return rows.map((r) => toAccount(r)).filter((a): a is Account => a !== null);
}

export function getAccount(id: string): Account | null {
  const row = getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
  return toAccount(row);
}

export function updateAccount(id: string, patch: Partial<Account>): void {
  const entries = Object.entries(patch).filter(([key]) => (UPDATABLE as readonly string[]).includes(key));
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => (value === undefined ? null : (value as string | number | null)));
  getDb()
    .prepare(`UPDATE accounts SET ${sets} WHERE id = ?`)
    .run(...values, id);
}

export function deleteAccount(id: string): void {
  getDb().prepare("DELETE FROM accounts WHERE id = ?").run(id);
}

export function logQuota(accountId: string, event: QuotaEvent, observedLimit: number | null): void {
  getDb()
    .prepare("INSERT INTO quota_log (accountId, ts, event, observedLimit) VALUES (?,?,?,?)")
    .run(accountId, Date.now(), event, observedLimit);
}
