import { getDb } from "./index.js";

type Row = Record<string, unknown>;

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  return row ? String(row.value) : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

/** Whether incoming API requests must carry a valid imgrouter key. Default: on. */
export function requireApiKey(): boolean {
  return getSetting("requireApiKey") !== "false";
}

export function setRequireApiKey(value: boolean): void {
  setSetting("requireApiKey", value ? "true" : "false");
}
