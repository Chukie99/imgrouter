import { getDb } from '../db/index.js';
function db() {
 const db = getDb();
 db.exec('CREATE TABLE IF NOT EXISTS request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, requestedModel TEXT NOT NULL, actualModel TEXT NOT NULL, status INTEGER NOT NULL, durationMs INTEGER NOT NULL)');
 return db;
}
export function logRequest(requested: string, actual: string, status: number, duration: number): void {
 db().prepare('INSERT INTO request_log (ts,requestedModel,actualModel,status,durationMs) VALUES (?,?,?,?,?)').run(Date.now(), requested, actual, status, duration);
 db().exec('DELETE FROM request_log WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM request_log)');
}
export function recentRequests(): unknown[] { return db().prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 100').all(); }
