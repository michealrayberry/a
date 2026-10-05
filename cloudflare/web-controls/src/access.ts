/**
 * Temporary access: participant requests, AP decisions, timed grants, and
 * automatic restoration.
 *
 * Fail-closed rules:
 *   - A grant only lifts a restriction while status is APPLYING/ACTIVE *and*
 *     expiresAt is in the future. An overdue grant never counts, even if the
 *     expiry sweep has not run yet.
 *   - If NextDNS refuses the change, the grant is APPLY_FAILED and the
 *     restriction is re-asserted.
 *   - A restriction is only marked RESTORED after NextDNS confirms it. Until
 *     then the grant stays restoreStatus=PENDING/FAILED, is retried every
 *     scheduler tick, and surfaces as an integrity failure.
 */
import { auditStatement, audit, SYSTEM_ACTOR, type Actor } from './audit.js';
import type { Ctx } from './context.js';
import { controlErrors, getControl, getControlRow, reconcileProfiles, type ControlView } from './controls.js';
import { getSettings } from './settings.js';
import { addMinutes, HttpError, iso, minutesBetween, newId } from './util.js';

export interface GrantRow {
  id: string;
  controlId: string;
  requestId: string | null;
  grantedBy: string;
  grantedAt: string;
  minutes: number;
  expiresAt: string;
  status: 'APPLYING' | 'ACTIVE' | 'APPLY_FAILED' | 'EXPIRED' | 'REVOKED';
  appliedAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
  restoreStatus: 'PENDING' | 'RESTORED' | 'FAILED' | null;
  restoredAt: string | null;
  lastError: string | null;
}

export interface RequestRow {
  id: string;
  controlId: string;
  requestedMinutes: number;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'WITHDRAWN' | 'LAPSED';
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvedMinutes: number | null;
  grantId: string | null;
}

const fmtMinutes = (m: number) =>
  m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} minutes`;

async function assertMinutes(ctx: Ctx, minutes: number) {
  const { maxGrantMinutes } = await getSettings(ctx);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxGrantMinutes)
    throw new HttpError(400, 'invalid_duration', `Duration must be 1–${maxGrantMinutes} minutes`);
}

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

export async function requestAccess(
  ctx: Ctx,
  actor: Actor,
  input: { controlId: string; minutes: number; reason: string },
): Promise<RequestRow> {
  const control = await getControl(ctx, input.controlId);
  if (control.state !== 'BLOCKED')
    throw new HttpError(409, 'not_blocked', `${control.label} is currently ${control.state.replace('_', ' ').toLowerCase()}`);
  await assertMinutes(ctx, input.minutes);
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 500) throw new HttpError(400, 'reason_required', 'A reason (3–500 characters) is required');
  const pending = await ctx.db
    .prepare(`SELECT id FROM access_requests WHERE controlId = ? AND status = 'PENDING'`)
    .bind(control.id)
    .first();
  if (pending) throw new HttpError(409, 'request_pending', `A request for ${control.label} is already pending`);

  const id = newId('req');
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO access_requests (id, controlId, requestedMinutes, reason, requestedBy, requestedAt, status)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      )
      .bind(id, control.id, input.minutes, reason, actor.id, now),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'access.requested',
      targetType: 'access_request',
      targetId: id,
      targetLabel: control.label,
      newState: { status: 'PENDING', minutes: input.minutes },
      summary: `Participant requested ${control.label} access for ${fmtMinutes(input.minutes)}`,
      reason,
    }),
  ]);
  await ctx.alert({
    kind: 'access_request',
    title: `ACCESS REQUEST — ${control.label}`,
    text: `Requested duration: ${fmtMinutes(input.minutes)}. Reason: ${reason}`,
  });
  return (await getRequest(ctx, id))!;
}

export async function withdrawRequest(ctx: Ctx, actor: Actor, id: string): Promise<RequestRow> {
  const req = await getRequest(ctx, id);
  if (!req) throw new HttpError(404, 'not_found');
  if (req.status !== 'PENDING') throw new HttpError(409, 'not_pending');
  const now = iso(ctx.clock.now());
  const control = await getControlRow(ctx, req.controlId);
  const [upd] = await ctx.db.batch([
    ctx.db.prepare(`UPDATE access_requests SET status = 'WITHDRAWN', decidedAt = ? WHERE id = ? AND status = 'PENDING'`).bind(now, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'access.withdrawn',
      targetType: 'access_request',
      targetId: id,
      targetLabel: control.label,
      previousState: { status: 'PENDING' },
      newState: { status: 'WITHDRAWN' },
      summary: `Participant withdrew the ${control.label} access request`,
    }),
  ]);
  if (!upd?.meta.changes) throw new HttpError(409, 'not_pending');
  return (await getRequest(ctx, id))!;
}

// ---------------------------------------------------------------------------
// AP
// ---------------------------------------------------------------------------

export async function decideRequest(
  ctx: Ctx,
  actor: Actor,
  id: string,
  input: { decision: 'APPROVE' | 'DENY'; minutes?: number; note?: string | null },
): Promise<{ request: RequestRow; grant: GrantRow | null }> {
  const req = await getRequest(ctx, id);
  if (!req) throw new HttpError(404, 'not_found');
  if (req.status !== 'PENDING') throw new HttpError(409, 'not_pending', `Request is ${req.status}`);
  const control = await getControlRow(ctx, req.controlId);
  const now = iso(ctx.clock.now());

  if (input.decision === 'DENY') {
    const [upd] = await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE access_requests SET status = 'DENIED', decidedBy = ?, decidedAt = ?, decisionNote = ? WHERE id = ? AND status = 'PENDING'`)
        .bind(actor.id, now, input.note ?? null, id),
      auditStatement(ctx.db, ctx.clock, {
        actor,
        automatic: false,
        action: 'access.denied',
        targetType: 'access_request',
        targetId: id,
        targetLabel: control.label,
        previousState: { status: 'PENDING', requestedMinutes: req.requestedMinutes },
        newState: { status: 'DENIED' },
        summary: `AP denied ${control.label} access`,
        reason: input.note ?? null,
      }),
    ]);
    if (!upd?.meta.changes) throw new HttpError(409, 'not_pending');
    return { request: (await getRequest(ctx, id))!, grant: null };
  }

  const minutes = input.minutes ?? req.requestedMinutes;
  await assertMinutes(ctx, minutes);
  // Claim the request first so two AP clicks cannot create two grants.
  const claim = await ctx.db
    .prepare(
      `UPDATE access_requests SET status = 'APPROVED', decidedBy = ?, decidedAt = ?, decisionNote = ?, approvedMinutes = ?
        WHERE id = ? AND status = 'PENDING'`,
    )
    .bind(actor.id, now, input.note ?? null, minutes, id)
    .run();
  if (!claim.meta.changes) throw new HttpError(409, 'not_pending');
  let grant: GrantRow;
  try {
    grant = await grantTemporaryAccess(ctx, actor, {
      controlId: req.controlId,
      minutes,
      requestId: id,
      note: input.note,
      requestedMinutes: req.requestedMinutes,
    });
  } catch (e) {
    const failed = await ctx.db
      .prepare(`SELECT id FROM access_grants WHERE requestId = ? ORDER BY grantedAt DESC LIMIT 1`)
      .bind(id)
      .first<{ id: string }>();
    if (failed) {
      // NextDNS refused: the approval stands on record, the failed grant is linked and audited.
      await ctx.db.prepare(`UPDATE access_requests SET grantId = ? WHERE id = ?`).bind(failed.id, id).run();
    } else {
      // Nothing was granted or audited yet — release the claim so the AP can decide again.
      await ctx.db
        .prepare(
          `UPDATE access_requests SET status = 'PENDING', decidedBy = NULL, decidedAt = NULL, decisionNote = NULL, approvedMinutes = NULL
            WHERE id = ? AND status = 'APPROVED' AND grantId IS NULL`,
        )
        .bind(id)
        .run();
    }
    throw e;
  }
  await ctx.db.prepare(`UPDATE access_requests SET grantId = ? WHERE id = ?`).bind(grant.id, id).run();
  return { request: (await getRequest(ctx, id))!, grant };
}

export async function grantTemporaryAccess(
  ctx: Ctx,
  actor: Actor,
  input: { controlId: string; minutes: number; requestId?: string; note?: string | null; requestedMinutes?: number },
): Promise<GrantRow> {
  await assertMinutes(ctx, input.minutes);
  // Settle any outstanding restoration for this control before lifting it again.
  await processRestorations(ctx, input.controlId);
  const unsettled = await ctx.db
    .prepare(`SELECT id FROM access_grants WHERE controlId = ? AND restoreStatus IN ('PENDING', 'FAILED')`)
    .bind(input.controlId)
    .first();
  if (unsettled)
    throw new HttpError(503, 'restore_pending', 'A previous restriction has not been confirmed restored in NextDNS yet');

  const control = await getControl(ctx, input.controlId);
  if (control.state === 'TEMPORARILY_ALLOWED') throw new HttpError(409, 'already_temporarily_allowed');
  if (control.state !== 'BLOCKED') throw new HttpError(409, 'not_blocked', `${control.label} is ${control.state}`);

  const id = newId('grt');
  const grantedAt = ctx.clock.now();
  const expiresAt = iso(addMinutes(grantedAt, input.minutes));
  const differs = input.requestedMinutes !== undefined && input.requestedMinutes !== input.minutes;
  await ctx.db
    .prepare(
      `INSERT INTO access_grants (id, controlId, requestId, grantedBy, grantedAt, minutes, expiresAt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'APPLYING')`,
    )
    .bind(id, control.id, input.requestId ?? null, actor.id, iso(grantedAt), input.minutes, expiresAt)
    .run();

  const results = await reconcileProfiles(ctx, control.profiles);
  const errors = controlErrors(control, results);
  const now = iso(ctx.clock.now());

  if (errors.length) {
    const message = errors.map((e) => e.message).join('; ');
    await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE access_grants SET status = 'APPLY_FAILED', endedAt = ?, lastError = ? WHERE id = ?`)
        .bind(now, message, id),
      auditStatement(ctx.db, ctx.clock, {
        actor: SYSTEM_ACTOR,
        automatic: true,
        action: 'access.grant_failed',
        targetType: 'access_grant',
        targetId: id,
        targetLabel: control.label,
        previousState: { state: 'BLOCKED' },
        newState: { state: 'BLOCKED', grant: 'APPLY_FAILED' },
        summary: `NextDNS did not accept the ${control.label} access grant; restriction kept`,
        reason: message,
      }),
    ]);
    // Fail closed: re-assert the restriction on every affected profile.
    await reconcileProfiles(ctx, control.profiles);
    throw new HttpError(502, 'nextdns_apply_failed', `Access was not granted: ${message}`);
  }

  await ctx.db.batch([
    ctx.db.prepare(`UPDATE access_grants SET status = 'ACTIVE', appliedAt = ? WHERE id = ? AND status = 'APPLYING'`).bind(now, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'access.granted',
      targetType: 'access_grant',
      targetId: id,
      targetLabel: control.label,
      previousState: { state: 'BLOCKED' },
      newState: { state: 'TEMPORARILY_ALLOWED', minutes: input.minutes, expiresAt, requestId: input.requestId ?? null },
      summary: `AP granted ${control.label} access for ${fmtMinutes(input.minutes)}${
        differs ? ` (requested ${fmtMinutes(input.requestedMinutes!)})` : ''
      }`,
      reason: input.note ?? null,
    }),
  ]);
  return (await getGrant(ctx, id))!;
}

/** AP ends a temporary grant early and the restriction is restored. */
export async function restoreRestriction(
  ctx: Ctx,
  actor: Actor,
  input: { grantId?: string; controlId?: string; reason?: string | null },
): Promise<GrantRow> {
  const grant = input.grantId
    ? await getGrant(ctx, input.grantId)
    : await ctx.db
        .prepare(`SELECT * FROM access_grants WHERE controlId = ? AND status IN ('APPLYING', 'ACTIVE') ORDER BY grantedAt DESC LIMIT 1`)
        .bind(input.controlId ?? '')
        .first<GrantRow>();
  if (!grant) throw new HttpError(404, 'no_active_grant');
  if (grant.status !== 'ACTIVE' && grant.status !== 'APPLYING') throw new HttpError(409, 'grant_not_active', `Grant is ${grant.status}`);
  const control = await getControlRow(ctx, grant.controlId);
  const now = iso(ctx.clock.now());
  const [upd] = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE access_grants SET status = 'REVOKED', endedAt = ?, endedBy = ?, restoreStatus = 'PENDING'
          WHERE id = ? AND status IN ('APPLYING', 'ACTIVE')`,
      )
      .bind(now, actor.id, grant.id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'access.revoked',
      targetType: 'access_grant',
      targetId: grant.id,
      targetLabel: control.label,
      previousState: { state: 'TEMPORARILY_ALLOWED', expiresAt: grant.expiresAt },
      newState: { state: 'BLOCKED' },
      summary: `AP ended ${control.label} temporary access early (${minutesBetween(now, grant.expiresAt)} min remaining)`,
      reason: input.reason ?? null,
    }),
  ]);
  if (!upd?.meta.changes) throw new HttpError(409, 'grant_not_active');
  await processRestorations(ctx, grant.controlId);
  return (await getGrant(ctx, grant.id))!;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Mark overdue grants EXPIRED. Restoration itself happens in processRestorations. */
export async function expireGrants(ctx: Ctx): Promise<number> {
  const now = iso(ctx.clock.now());
  const { results } = await ctx.db
    .prepare(`SELECT * FROM access_grants WHERE status IN ('APPLYING', 'ACTIVE') AND expiresAt <= ?`)
    .bind(now)
    .all<GrantRow>();
  let n = 0;
  for (const g of results) {
    const upd = await ctx.db
      .prepare(
        `UPDATE access_grants SET status = 'EXPIRED', endedAt = expiresAt, endedBy = 'SYSTEM', restoreStatus = 'PENDING'
          WHERE id = ? AND status IN ('APPLYING', 'ACTIVE')`,
      )
      .bind(g.id)
      .run();
    if (upd.meta.changes) n++;
  }
  return n;
}

/**
 * Push restrictions back into NextDNS for ended grants and record the outcome.
 * Safe to call repeatedly; only NextDNS confirmation marks a grant RESTORED.
 */
export async function processRestorations(ctx: Ctx, controlId?: string): Promise<{ restored: number; failed: number }> {
  const { results: pending } = await ctx.db
    .prepare(
      `SELECT * FROM access_grants WHERE restoreStatus IN ('PENDING', 'FAILED') ${controlId ? 'AND controlId = ?' : ''} ORDER BY endedAt`,
    )
    .bind(...(controlId ? [controlId] : []))
    .all<GrantRow>();
  if (!pending.length) return { restored: 0, failed: 0 };

  const controls = new Map<string, ControlView>();
  for (const g of pending) if (!controls.has(g.controlId)) controls.set(g.controlId, await getControl(ctx, g.controlId));
  const profiles = [...new Set([...controls.values()].flatMap((c) => c.profiles))];
  const results = await reconcileProfiles(ctx, profiles);

  let restored = 0;
  let failed = 0;
  for (const g of pending) {
    const control = controls.get(g.controlId)!;
    // A control the AP has since allowed or archived has nothing to restore to.
    const errors = control.state === 'BLOCKED' ? controlErrors(control, results) : [];
    const now = iso(ctx.clock.now());
    const expired = g.status === 'EXPIRED';
    if (!errors.length) {
      await ctx.db.batch([
        ctx.db.prepare(`UPDATE access_grants SET restoreStatus = 'RESTORED', restoredAt = ?, lastError = NULL WHERE id = ?`).bind(now, g.id),
        auditStatement(ctx.db, ctx.clock, {
          actor: SYSTEM_ACTOR,
          automatic: true,
          action: expired ? 'access.expired_restored' : 'access.revoked_restored',
          targetType: 'access_grant',
          targetId: g.id,
          targetLabel: control.label,
          previousState: { state: 'TEMPORARILY_ALLOWED', expiresAt: g.expiresAt },
          newState: { state: control.state, confirmedByNextDns: control.state === 'BLOCKED' },
          summary:
            control.state === 'BLOCKED'
              ? expired
                ? `Temporary access expired. ${control.label} restriction restored.`
                : `${control.label} restriction restored.`
              : `Temporary access ended. ${control.label} is now ${control.state.toLowerCase()} by AP policy.`,
          reason: g.restoreStatus === 'FAILED' ? `Restored after earlier failure: ${g.lastError}` : null,
        }),
      ]);
      restored++;
    } else {
      const message = errors.map((e) => e.message).join('; ');
      await ctx.db.prepare(`UPDATE access_grants SET restoreStatus = 'FAILED', lastError = ? WHERE id = ?`).bind(message, g.id).run();
      if (g.restoreStatus !== 'FAILED') {
        await audit(ctx.db, ctx.clock, {
          actor: SYSTEM_ACTOR,
          automatic: true,
          action: 'access.restore_failed',
          targetType: 'access_grant',
          targetId: g.id,
          targetLabel: control.label,
          previousState: { state: 'TEMPORARILY_ALLOWED' },
          newState: { restoreStatus: 'FAILED' },
          summary: `${control.label} restriction could NOT be restored in NextDNS; retrying every minute`,
          reason: message,
        });
        await ctx.alert({
          kind: 'restore_failed',
          title: `RESTRICTION NOT RESTORED — ${control.label}`,
          text: `NextDNS refused the restore: ${message}. The Worker retries every minute.`,
        });
      }
      failed++;
    }
  }
  return { restored, failed };
}

/** Unanswered requests lapse rather than linger (fail closed). */
export async function lapseRequests(ctx: Ctx): Promise<number> {
  const { requestLapseMinutes } = await getSettings(ctx);
  const cutoff = iso(addMinutes(ctx.clock.now(), -requestLapseMinutes));
  const { results } = await ctx.db
    .prepare(
      `SELECT r.id, r.requestedMinutes, c.label FROM access_requests r JOIN web_controls c ON c.id = r.controlId
        WHERE r.status = 'PENDING' AND r.requestedAt <= ?`,
    )
    .bind(cutoff)
    .all<{ id: string; label: string }>();
  for (const r of results) {
    await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE access_requests SET status = 'LAPSED', decidedAt = ?, decidedBy = 'SYSTEM' WHERE id = ? AND status = 'PENDING'`)
        .bind(iso(ctx.clock.now()), r.id),
      auditStatement(ctx.db, ctx.clock, {
        actor: SYSTEM_ACTOR,
        automatic: true,
        action: 'access.lapsed',
        targetType: 'access_request',
        targetId: r.id,
        targetLabel: r.label,
        previousState: { status: 'PENDING' },
        newState: { status: 'LAPSED' },
        summary: `${r.label} access request lapsed without an AP decision; restriction unchanged`,
      }),
    ]);
  }
  return results.length;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const getRequest = (ctx: Ctx, id: string) =>
  ctx.db.prepare(`SELECT * FROM access_requests WHERE id = ?`).bind(id).first<RequestRow>();

export const getGrant = (ctx: Ctx, id: string) =>
  ctx.db.prepare(`SELECT * FROM access_grants WHERE id = ?`).bind(id).first<GrantRow>();

export async function listRequests(ctx: Ctx, opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await ctx.db
    .prepare(
      `SELECT r.*, c.label AS controlLabel, g.status AS grantStatus, g.expiresAt AS grantExpiresAt, g.lastError AS grantError
         FROM access_requests r
         JOIN web_controls c ON c.id = r.controlId
         LEFT JOIN access_grants g ON g.id = r.grantId
        ${opts.status ? 'WHERE r.status = ?' : ''}
        ORDER BY r.requestedAt DESC LIMIT ${limit}`,
    )
    .bind(...(opts.status ? [opts.status] : []))
    .all();
  return results;
}

export async function listGrants(ctx: Ctx, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await ctx.db
    .prepare(
      `SELECT g.*, c.label AS controlLabel FROM access_grants g JOIN web_controls c ON c.id = g.controlId
        ORDER BY g.grantedAt DESC LIMIT ${limit}`,
    )
    .all();
  return results;
}
