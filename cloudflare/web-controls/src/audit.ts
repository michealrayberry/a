/**
 * Append-only audit trail. The D1 table rejects UPDATE/DELETE via triggers, so
 * history cannot be silently rewritten by this Worker or by a later bug.
 */
import { iso, newId, type Clock } from './util.js';

export type ActorType = 'AP' | 'PARTICIPANT' | 'SYSTEM' | 'DEVICE';

export interface Actor {
  type: ActorType;
  id: string | null;
}
export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: 'scheduler' };

export interface AuditInput {
  actor: Actor;
  automatic: boolean;
  action: string;
  targetType: string;
  targetId?: string | null;
  targetLabel?: string | null;
  profileCode?: string | null;
  previousState?: unknown;
  newState?: unknown;
  summary: string;
  reason?: string | null;
}

/** previous/new state are always stored as JSON so readers can parse them uniformly. */
const enc = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** Build (not run) the insert, so callers can batch it atomically with the state change. */
export function auditStatement(db: D1Database, clock: Clock, a: AuditInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, ts, actorType, actorId, automatic, action, targetType, targetId, targetLabel,
         profileCode, previousState, newState, summary, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('aud'),
      iso(clock.now()),
      a.actor.type,
      a.actor.id,
      a.automatic ? 1 : 0,
      a.action,
      a.targetType,
      a.targetId ?? null,
      a.targetLabel ?? null,
      a.profileCode ?? null,
      enc(a.previousState),
      enc(a.newState),
      a.summary,
      a.reason ?? null,
    );
}

export async function audit(db: D1Database, clock: Clock, a: AuditInput): Promise<void> {
  await auditStatement(db, clock, a).run();
}

export async function listAudit(
  db: D1Database,
  opts: { limit?: number; before?: string; targetType?: string; targetId?: string } = {},
) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.before) (where.push('ts < ?'), args.push(opts.before));
  if (opts.targetType) (where.push('targetType = ?'), args.push(opts.targetType));
  if (opts.targetId) (where.push('targetId = ?'), args.push(opts.targetId));
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, rowid DESC LIMIT ${limit}`;
  const { results } = await db.prepare(sql).bind(...args).all();
  return results.map((r) => ({
    ...r,
    automatic: r.automatic === 1,
    previousState: r.previousState ? JSON.parse(r.previousState as string) : null,
    newState: r.newState ? JSON.parse(r.newState as string) : null,
  }));
}
