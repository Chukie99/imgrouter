import { getDb } from '../db/index.js';
let initialized = false;
function db() {
 const db = getDb();
 if (!initialized) {
  db.exec('CREATE TABLE IF NOT EXISTS request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, requestedModel TEXT NOT NULL, actualModel TEXT NOT NULL, status INTEGER NOT NULL, durationMs INTEGER NOT NULL)');
  const fields = new Set((db.prepare('PRAGMA table_info(request_log)').all() as Array<{name:string}>).map(r=>r.name));
  for (const name of ['accountId','accountLabel','error']) if (!fields.has(name)) db.exec(`ALTER TABLE request_log ADD COLUMN ${name} TEXT`);
  initialized = true;
 }
 return db;
}
export function logRequest(requested: string, actual: string, status: number, duration: number, accountId?:string, accountLabel?:string, error?:string): void {
 db().prepare('INSERT INTO request_log (ts,requestedModel,actualModel,status,durationMs,accountId,accountLabel,error) VALUES (?,?,?,?,?,?,?,?)').run(Date.now(), requested, actual, status, duration, accountId??null,accountLabel??null,error??null);
 db().exec('DELETE FROM request_log WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM request_log)');
}
export function recentRequests(): unknown[] { return db().prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 100').all(); }
export function requestStats(): { success:number; failed:number } {
 const row=db().prepare('SELECT SUM(CASE WHEN status=200 THEN 1 ELSE 0 END) AS success, SUM(CASE WHEN status<>200 THEN 1 ELSE 0 END) AS failed FROM request_log').get() as {success:number|null;failed:number|null};
 return {success:row.success??0,failed:row.failed??0};
}
