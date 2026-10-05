/**
 * Minimal D1Database implementation over better-sqlite3 for Node tests.
 * Runs the real migration SQL (including triggers), so schema-level
 * protections are exercised exactly as in D1.
 */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class Stmt {
  constructor(
    private readonly db: Database.Database,
    readonly sql: string,
    readonly args: unknown[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args);
  }
  private conv() {
    return this.args.map((a) => (typeof a === 'boolean' ? (a ? 1 : 0) : a === undefined ? null : a));
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.conv()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T>() {
    const s = this.db.prepare(this.sql);
    const results = (s.reader ? s.all(...this.conv()) : (s.run(...this.conv()), [])) as T[];
    return { results, success: true, meta: {} };
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    const s = this.db.prepare(this.sql);
    if (s.reader) {
      s.all(...this.conv());
      return { success: true, meta: { changes: 0 }, results: [] };
    }
    const r = s.run(...this.conv());
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }
}

export function createD1(): { d1: D1Database; raw: Database.Database } {
  const raw = new Database(':memory:');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  for (const f of readdirSync(dir).sort()) raw.exec(readFileSync(path.join(dir, f), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (stmts: Stmt[]) => raw.transaction(() => stmts.map((s) => s.runSync()))(),
    exec: async (sql: string) => (raw.exec(sql), { count: 0, duration: 0 }),
  };
  return { d1: d1 as unknown as D1Database, raw };
}
