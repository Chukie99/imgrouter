import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./index.js";

type Row = Record<string, unknown>;

export interface ClientKey {
  id: string;
  label: string;
  key: string;
  createdAt: number;
  lastUsedAt: number | null;
  uses: number;
}

function toClientKey(row: Row | undefined): ClientKey | null {
  if (!row) return null;
  return {
    id: String(row.id),
    label: String(row.label),
    key: String(row.key),
    createdAt: Number(row.createdAt),
    lastUsedAt: row.lastUsedAt == null ? null : Number(row.lastUsedAt),
    uses: Number(row.uses),
  };
}

/** Keys issued by imgrouter for clients — `sk-` prefix so they read like a standard API key. */
export function generateKeyValue(): string {
  return `sk-${randomBytes(20).toString("hex")}`;
}

export function createClientKey(label: string): ClientKey {
  const entry: ClientKey = {
    id: randomUUID(),
    label: label.trim() || "client",
    key: generateKeyValue(),
    createdAt: Date.now(),
    lastUsedAt: null,
    uses: 0,
  };
  getDb()
    .prepare("INSERT INTO client_keys (id,label,key,createdAt,lastUsedAt,uses) VALUES (?,?,?,?,?,?)")
    .run(entry.id, entry.label, entry.key, entry.createdAt, entry.lastUsedAt, entry.uses);
  return entry;
}

export function listClientKeys(): ClientKey[] {
  const rows = getDb().prepare("SELECT * FROM client_keys ORDER BY createdAt DESC").all() as Row[];
  return rows.map((r) => toClientKey(r)).filter((k): k is ClientKey => k !== null);
}

export function deleteClientKey(id: string): number {
  return Number(getDb().prepare("DELETE FROM client_keys WHERE id = ?").run(id).changes);
}

/** Resolve a bearer/x-goog-api-key value to a stored client key, or null if unknown. */
export function findClientKey(value: string): ClientKey | null {
  if (!value) return null;
  const row = getDb().prepare("SELECT * FROM client_keys WHERE key = ?").get(value) as Row | undefined;
  return toClientKey(row);
}

export function touchClientKey(id: string): void {
  getDb().prepare("UPDATE client_keys SET lastUsedAt = ?, uses = uses + 1 WHERE id = ?").run(Date.now(), id);
}
