/**
 * Web controls + reconciliation.
 *
 * The D1 database holds the AP's *desired* policy. `reconcileProfile` makes the
 * live NextDNS profile match it. Because every mutation funnels through this
 * one idempotent step:
 *   - temporary access and its automatic restoration are just policy changes;
 *   - a failed NextDNS write never leaves the database claiming success;
 *   - edits made outside the portal to entries the portal manages are detected
 *     as configuration drift, corrected, and preserved as integrity incidents.
 *
 * Entries created by hand in the NextDNS dashboard (not in managed_entries)
 * are never modified or removed.
 */
import { auditStatement, type Actor } from './audit.js';
import { PROFILE_CODES, type Ctx, type ProfileCode } from './context.js';
import { NextDnsError, type ListName, type NextDnsListEntry } from './nextdns.js';
import { getInternal, getSettings, setInternal, type FilteringPolicy } from './settings.js';
import { domainCovers, HttpError, iso, newId, normalizeDomain, parseJsonArray } from './util.js';

export type ControlPolicy = 'BLOCKED' | 'ALLOWED';
export type EffectiveState = 'BLOCKED' | 'TEMPORARILY_ALLOWED' | 'ALLOWED' | 'ARCHIVED';

export interface ControlRow {
  id: string;
  label: string;
  domains: string;
  nextdnsServiceId: string | null;
  profiles: string;
  policy: ControlPolicy;
  note: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: string | null;
}

export interface ControlView {
  id: string;
  label: string;
  domains: string[];
  nextdnsServiceId: string | null;
  profiles: ProfileCode[];
  policy: ControlPolicy;
  state: EffectiveState;
  activeGrant: { id: string; expiresAt: string; grantedBy: string; status: string } | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

const SERVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getControlRow(ctx: Ctx, id: string): Promise<ControlRow> {
  const row = await ctx.db.prepare(`SELECT * FROM web_controls WHERE id = ?`).bind(id).first<ControlRow>();
  if (!row) throw new HttpError(404, 'control_not_found');
  return row;
}

interface GrantLite {
  id: string;
  controlId: string;
  expiresAt: string;
  grantedBy: string;
  status: string;
}

/** Grants that currently lift a restriction. An overdue grant never counts (fail closed). */
async function liveGrants(ctx: Ctx): Promise<Map<string, GrantLite>> {
  const { results } = await ctx.db
    .prepare(
      `SELECT id, controlId, expiresAt, grantedBy, status FROM access_grants
        WHERE status IN ('APPLYING', 'ACTIVE') AND expiresAt > ?
        ORDER BY expiresAt DESC`,
    )
    .bind(iso(ctx.clock.now()))
    .all<GrantLite>();
  const m = new Map<string, GrantLite>();
  for (const g of results) if (!m.has(g.controlId)) m.set(g.controlId, g);
  return m;
}

export function toView(row: ControlRow, grant: GrantLite | undefined): ControlView {
  const state: EffectiveState = row.archivedAt
    ? 'ARCHIVED'
    : row.policy === 'ALLOWED'
      ? 'ALLOWED'
      : grant
        ? 'TEMPORARILY_ALLOWED'
        : 'BLOCKED';
  return {
    id: row.id,
    label: row.label,
    domains: parseJsonArray(row.domains),
    nextdnsServiceId: row.nextdnsServiceId,
    profiles: parseJsonArray(row.profiles) as ProfileCode[],
    policy: row.policy,
    state,
    activeGrant:
      grant && state === 'TEMPORARILY_ALLOWED'
        ? { id: grant.id, expiresAt: grant.expiresAt, grantedBy: grant.grantedBy, status: grant.status }
        : null,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

export async function listControls(ctx: Ctx, opts: { includeArchived?: boolean } = {}): Promise<ControlView[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT * FROM web_controls ${opts.includeArchived ? '' : 'WHERE archivedAt IS NULL'} ORDER BY label COLLATE NOCASE`,
    )
    .all<ControlRow>();
  const grants = await liveGrants(ctx);
  return results.map((r) => toView(r, grants.get(r.id)));
}

export async function getControl(ctx: Ctx, id: string): Promise<ControlView> {
  const row = await getControlRow(ctx, id);
  const grants = await liveGrants(ctx);
  return toView(row, grants.get(id));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateProfiles(input: string[] | undefined): ProfileCode[] {
  const list = (input && input.length ? input : [...PROFILE_CODES]) as string[];
  for (const p of list)
    if (!(PROFILE_CODES as readonly string[]).includes(p)) throw new HttpError(400, 'invalid_profile', p);
  return [...new Set(list)] as ProfileCode[];
}

async function activeAllowlistDomains(ctx: Ctx): Promise<string[]> {
  const { results } = await ctx.db
    .prepare(`SELECT domain FROM allowlist_entries WHERE archivedAt IS NULL`)
    .all<{ domain: string }>();
  return results.map((r) => r.domain);
}

/** Reject domains that would make block/allow semantics ambiguous. */
async function assertNoConflicts(ctx: Ctx, domains: string[], exceptControlId?: string): Promise<void> {
  const allow = await activeAllowlistDomains(ctx);
  for (const d of domains)
    for (const a of allow)
      if (domainCovers(d, a) || domainCovers(a, d))
        throw new HttpError(
          409,
          'allowlist_conflict',
          `${d} overlaps allowlisted ${a}; NextDNS allowlist entries override the denylist. Remove the allowlist entry first.`,
        );
  const controls = await listControls(ctx);
  for (const c of controls) {
    if (c.id === exceptControlId) continue;
    for (const d of domains)
      if (c.domains.includes(d))
        throw new HttpError(409, 'domain_in_other_control', `${d} is already part of the "${c.label}" control`);
  }
}

// ---------------------------------------------------------------------------
// Mutations (AP only — enforced at the route layer)
// ---------------------------------------------------------------------------

export interface CreateControlInput {
  label: string;
  domains: string[];
  nextdnsServiceId?: string | null;
  profiles?: string[];
  policy?: ControlPolicy;
  note?: string | null;
}

export async function createControl(ctx: Ctx, actor: Actor, input: CreateControlInput): Promise<ControlView> {
  const label = input.label.trim();
  if (!label || label.length > 80) throw new HttpError(400, 'invalid_label');
  const domains = [...new Set(input.domains.map(normalizeDomain))];
  if (domains.length === 0 && !input.nextdnsServiceId) throw new HttpError(400, 'no_domains');
  if (domains.length > 50) throw new HttpError(400, 'too_many_domains');
  const serviceId = input.nextdnsServiceId?.trim().toLowerCase() || null;
  if (serviceId && !SERVICE_ID_RE.test(serviceId)) throw new HttpError(400, 'invalid_service_id');
  const profiles = validateProfiles(input.profiles);
  const policy = input.policy ?? 'BLOCKED';
  await assertNoConflicts(ctx, domains);
  const existing = await ctx.db
    .prepare(`SELECT id FROM web_controls WHERE archivedAt IS NULL AND label = ? COLLATE NOCASE`)
    .bind(label)
    .first();
  if (existing) throw new HttpError(409, 'label_exists', `A control named "${label}" already exists`);

  const id = newId('ctl');
  const now = iso(ctx.clock.now());
  const state = { domains, nextdnsServiceId: serviceId, profiles, policy };
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO web_controls (id, label, domains, nextdnsServiceId, profiles, policy, note, createdAt, createdBy, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, label, JSON.stringify(domains), serviceId, JSON.stringify(profiles), policy, input.note ?? null, now, actor.id, now),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: policy === 'BLOCKED' ? 'control.blocked' : 'control.created',
      targetType: 'web_control',
      targetId: id,
      targetLabel: label,
      previousState: null,
      newState: state,
      summary:
        policy === 'BLOCKED'
          ? `${actor.type} blocked ${label}${domains.length ? ` (${domains.join(', ')})` : ''}`
          : `${actor.type} added ${label} as an allowed, tracked service`,
      reason: input.note ?? null,
    }),
  ]);
  return getControl(ctx, id);
}

export async function setControlPolicy(
  ctx: Ctx,
  actor: Actor,
  id: string,
  policy: ControlPolicy,
  reason?: string | null,
): Promise<ControlView> {
  const row = await getControlRow(ctx, id);
  if (row.archivedAt) throw new HttpError(409, 'control_archived');
  if (row.policy === policy) return getControl(ctx, id);
  if (policy === 'BLOCKED') await assertNoConflicts(ctx, parseJsonArray(row.domains), id);
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE web_controls SET policy = ?, updatedAt = ? WHERE id = ?`).bind(policy, now, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: policy === 'BLOCKED' ? 'control.blocked' : 'control.allowed',
      targetType: 'web_control',
      targetId: id,
      targetLabel: row.label,
      previousState: { policy: row.policy },
      newState: { policy },
      summary: `${actor.type} ${policy === 'BLOCKED' ? 'blocked' : 'allowed'} ${row.label}`,
      reason,
    }),
  ]);
  return getControl(ctx, id);
}

export async function updateControl(
  ctx: Ctx,
  actor: Actor,
  id: string,
  input: { domains?: string[]; profiles?: string[]; nextdnsServiceId?: string | null; note?: string | null },
  reason?: string | null,
): Promise<ControlView> {
  const row = await getControlRow(ctx, id);
  if (row.archivedAt) throw new HttpError(409, 'control_archived');
  const domains = input.domains ? [...new Set(input.domains.map(normalizeDomain))] : parseJsonArray(row.domains);
  const profiles = input.profiles ? validateProfiles(input.profiles) : (parseJsonArray(row.profiles) as ProfileCode[]);
  const serviceId =
    input.nextdnsServiceId === undefined ? row.nextdnsServiceId : input.nextdnsServiceId?.trim().toLowerCase() || null;
  if (serviceId && !SERVICE_ID_RE.test(serviceId)) throw new HttpError(400, 'invalid_service_id');
  if (domains.length === 0 && !serviceId) throw new HttpError(400, 'no_domains');
  await assertNoConflicts(ctx, domains, id);
  const prev = { domains: parseJsonArray(row.domains), profiles: parseJsonArray(row.profiles), nextdnsServiceId: row.nextdnsServiceId };
  const next = { domains, profiles, nextdnsServiceId: serviceId };
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE web_controls SET domains = ?, profiles = ?, nextdnsServiceId = ?, note = ?, updatedAt = ? WHERE id = ?`)
      .bind(JSON.stringify(domains), JSON.stringify(profiles), serviceId, input.note === undefined ? row.note : input.note, now, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'control.updated',
      targetType: 'web_control',
      targetId: id,
      targetLabel: row.label,
      previousState: prev,
      newState: next,
      summary: `${actor.type} changed the scope of ${row.label}`,
      reason,
    }),
  ]);
  return getControl(ctx, id);
}

/**
 * Archiving removes the control's NextDNS entries on the next reconcile. It is
 * a deliberate, audited AP action and never deletes the row or its history.
 */
export async function archiveControl(ctx: Ctx, actor: Actor, id: string, reason: string): Promise<ControlView> {
  const row = await getControlRow(ctx, id);
  if (row.archivedAt) return getControl(ctx, id);
  if (!reason?.trim()) throw new HttpError(400, 'reason_required');
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE web_controls SET archivedAt = ?, archivedBy = ?, updatedAt = ? WHERE id = ?`).bind(now, actor.id, now, id),
    ctx.db
      .prepare(
        `UPDATE access_grants SET status = 'REVOKED', endedAt = ?, endedBy = ?
          WHERE controlId = ? AND status IN ('APPLYING', 'ACTIVE')`,
      )
      .bind(now, actor.id, id),
    ctx.db
      .prepare(`UPDATE access_requests SET status = 'DENIED', decidedBy = ?, decidedAt = ?, decisionNote = 'Control archived' WHERE controlId = ? AND status = 'PENDING'`)
      .bind(actor.id, now, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'control.archived',
      targetType: 'web_control',
      targetId: id,
      targetLabel: row.label,
      previousState: { policy: row.policy, archived: false },
      newState: { archived: true },
      summary: `${actor.type} removed the ${row.label} control (its NextDNS entries will be removed)`,
      reason,
    }),
  ]);
  return getControl(ctx, id);
}

// ---------------------------------------------------------------------------
// Allowlist + monitored domains
// ---------------------------------------------------------------------------

export async function listAllowlist(ctx: Ctx) {
  const { results } = await ctx.db
    .prepare(`SELECT * FROM allowlist_entries WHERE archivedAt IS NULL ORDER BY domain`)
    .all<{ id: string; domain: string; profiles: string; note: string | null; createdAt: string; createdBy: string }>();
  return results.map((r) => ({ ...r, profiles: parseJsonArray(r.profiles) }));
}

export async function addAllowlistEntry(
  ctx: Ctx,
  actor: Actor,
  input: { domain: string; profiles?: string[]; note?: string | null },
) {
  const domain = normalizeDomain(input.domain);
  const profiles = validateProfiles(input.profiles);
  for (const c of await listControls(ctx))
    for (const d of c.domains)
      if (domainCovers(d, domain) || domainCovers(domain, d))
        throw new HttpError(
          409,
          'control_conflict',
          `${domain} overlaps ${d} in the "${c.label}" control. Use temporary access or change that control instead.`,
        );
  const dup = await ctx.db.prepare(`SELECT id FROM allowlist_entries WHERE archivedAt IS NULL AND domain = ?`).bind(domain).first();
  if (dup) throw new HttpError(409, 'already_allowlisted');
  const id = newId('alw');
  await ctx.db.batch([
    ctx.db
      .prepare(`INSERT INTO allowlist_entries (id, domain, profiles, note, createdAt, createdBy) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, domain, JSON.stringify(profiles), input.note ?? null, iso(ctx.clock.now()), actor.id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'allowlist.added',
      targetType: 'allowlist',
      targetId: id,
      targetLabel: domain,
      newState: { domain, profiles },
      summary: `${actor.type} allowlisted ${domain}`,
      reason: input.note ?? null,
    }),
  ]);
  return { id, domain, profiles };
}

export async function removeAllowlistEntry(ctx: Ctx, actor: Actor, id: string, reason?: string | null) {
  const row = await ctx.db
    .prepare(`SELECT * FROM allowlist_entries WHERE id = ? AND archivedAt IS NULL`)
    .bind(id)
    .first<{ domain: string; profiles: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE allowlist_entries SET archivedAt = ?, archivedBy = ? WHERE id = ?`).bind(now, actor.id, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'allowlist.removed',
      targetType: 'allowlist',
      targetId: id,
      targetLabel: row.domain,
      previousState: { domain: row.domain, profiles: parseJsonArray(row.profiles) },
      newState: null,
      summary: `${actor.type} removed ${row.domain} from the allowlist`,
      reason,
    }),
  ]);
}

export async function listMonitoredDomains(ctx: Ctx) {
  const { results } = await ctx.db
    .prepare(`SELECT id, domain, label, createdAt, createdBy FROM monitored_domains WHERE archivedAt IS NULL ORDER BY domain`)
    .all<{ id: string; domain: string; label: string | null; createdAt: string; createdBy: string }>();
  return results;
}

export async function addMonitoredDomain(ctx: Ctx, actor: Actor, input: { domain: string; label?: string | null }) {
  const domain = normalizeDomain(input.domain);
  const dup = await ctx.db.prepare(`SELECT id FROM monitored_domains WHERE archivedAt IS NULL AND domain = ?`).bind(domain).first();
  if (dup) throw new HttpError(409, 'already_monitored');
  const id = newId('mon');
  await ctx.db.batch([
    ctx.db
      .prepare(`INSERT INTO monitored_domains (id, domain, label, createdAt, createdBy) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, domain, input.label?.trim() || null, iso(ctx.clock.now()), actor.id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'monitored.added',
      targetType: 'monitored_domain',
      targetId: id,
      targetLabel: domain,
      newState: { domain, label: input.label ?? null },
      summary: `${actor.type} added ${domain} to monitored domains`,
    }),
  ]);
  return { id, domain };
}

export async function removeMonitoredDomain(ctx: Ctx, actor: Actor, id: string, reason?: string | null) {
  const row = await ctx.db
    .prepare(`SELECT domain FROM monitored_domains WHERE id = ? AND archivedAt IS NULL`)
    .bind(id)
    .first<{ domain: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE monitored_domains SET archivedAt = ?, archivedBy = ? WHERE id = ?`).bind(now, actor.id, id),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: 'monitored.removed',
      targetType: 'monitored_domain',
      targetId: id,
      targetLabel: row.domain,
      previousState: { domain: row.domain },
      summary: `${actor.type} removed ${row.domain} from monitored domains`,
      reason,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

type ManagedList = ListName | 'services';

interface DesiredState {
  denylist: Map<string, boolean>;
  allowlist: Map<string, boolean>;
  services: Map<string, boolean>;
}

export interface EntryChange {
  list: ManagedList | 'parentalControl' | 'categories';
  id: string;
  op: 'add' | 'activate' | 'deactivate' | 'remove' | 'set';
  from: unknown;
  to: unknown;
}

export interface ReconcileResult {
  profileCode: ProfileCode;
  ok: boolean;
  skipped?: string;
  changes: EntryChange[];
  /** Managed entries changed outside the portal (then corrected). */
  drift: EntryChange[];
  errors: { list: string; id: string; message: string; authFailure: boolean }[];
}

async function desiredFor(ctx: Ctx, profile: ProfileCode): Promise<DesiredState> {
  const desired: DesiredState = { denylist: new Map(), allowlist: new Map(), services: new Map() };
  for (const c of await listControls(ctx)) {
    if (!c.profiles.includes(profile)) continue;
    const blocked = c.state === 'BLOCKED';
    for (const d of c.domains) desired.denylist.set(d, (desired.denylist.get(d) ?? false) || blocked);
    if (c.nextdnsServiceId)
      desired.services.set(c.nextdnsServiceId, (desired.services.get(c.nextdnsServiceId) ?? false) || blocked);
  }
  for (const a of await listAllowlist(ctx)) if (a.profiles.includes(profile)) desired.allowlist.set(a.domain, true);
  return desired;
}

/** Make one NextDNS profile match the desired policy. Never throws for NextDNS failures. */
export async function reconcileProfile(ctx: Ctx, profile: ProfileCode): Promise<ReconcileResult> {
  const result: ReconcileResult = { profileCode: profile, ok: true, changes: [], drift: [], errors: [] };
  const profileId = ctx.profileId(profile);
  if (!profileId) return { ...result, ok: false, skipped: 'profile id not configured' };
  if (!ctx.nextdns.configured) return { ...result, ok: false, skipped: 'NEXTDNS_API_KEY not configured' };

  let live;
  try {
    live = await ctx.nextdns.getProfile(profileId);
  } catch (e) {
    const err = e as NextDnsError;
    result.ok = false;
    result.errors.push({ list: 'profile', id: profileId, message: err.message, authFailure: err.kind === 'AUTH' });
    return result;
  }

  const desired = await desiredFor(ctx, profile);
  const { results: managedRows } = await ctx.db
    .prepare(`SELECT list, entryId, appliedActive FROM managed_entries WHERE profileCode = ?`)
    .bind(profile)
    .all<{ list: ManagedList; entryId: string; appliedActive: number | null }>();
  const managed = new Map(managedRows.map((r) => [`${r.list}:${r.entryId}`, r]));
  const now = iso(ctx.clock.now());

  const liveLists: Record<ManagedList, NextDnsListEntry[]> = {
    denylist: live.denylist ?? [],
    allowlist: live.allowlist ?? [],
    services: live.parentalControl?.services ?? [],
  };

  for (const list of ['denylist', 'allowlist', 'services'] as const) {
    const liveMap = new Map(liveLists[list].map((e) => [e.id, e.active !== false]));
    const want = desired[list];

    for (const [id, active] of want) {
      const key = `${list}:${id}`;
      const m = managed.get(key);
      const actual = liveMap.get(id);
      if (m && m.appliedActive !== null) {
        const applied = m.appliedActive === 1;
        if (actual === undefined) result.drift.push({ list, id, op: 'add', from: 'removed outside portal', to: active });
        else if (actual !== applied) result.drift.push({ list, id, op: 'set', from: actual, to: applied });
      }
      if (actual === active) {
        if (!m || m.appliedActive !== (active ? 1 : 0)) await markManaged(ctx, profile, list, id, active, now);
        continue;
      }
      try {
        if (actual === undefined) {
          await addEntry(ctx, profileId, list, id, active);
          result.changes.push({ list, id, op: 'add', from: null, to: active });
        } else {
          await setEntry(ctx, profileId, list, id, active);
          result.changes.push({ list, id, op: active ? 'activate' : 'deactivate', from: actual, to: active });
        }
        await markManaged(ctx, profile, list, id, active, now);
      } catch (e) {
        const err = e as NextDnsError;
        result.ok = false;
        result.errors.push({ list, id, message: err.message, authFailure: err.kind === 'AUTH' });
      }
    }

    // Entries this portal created that are no longer wanted -> remove.
    for (const m of managedRows.filter((r) => r.list === list && !want.has(r.entryId))) {
      try {
        if (liveMap.has(m.entryId)) {
          await removeEntry(ctx, profileId, list, m.entryId);
          result.changes.push({ list, id: m.entryId, op: 'remove', from: liveMap.get(m.entryId), to: null });
        }
        await ctx.db
          .prepare(`DELETE FROM managed_entries WHERE profileCode = ? AND list = ? AND entryId = ?`)
          .bind(profile, list, m.entryId)
          .run();
      } catch (e) {
        const err = e as NextDnsError;
        result.ok = false;
        result.errors.push({ list, id: m.entryId, message: err.message, authFailure: err.kind === 'AUTH' });
      }
    }
  }

  await reconcileFiltering(ctx, profile, profileId, live.parentalControl ?? {}, result);
  return result;
}

async function reconcileFiltering(
  ctx: Ctx,
  profile: ProfileCode,
  profileId: string,
  live: NonNullable<Awaited<ReturnType<Ctx['nextdns']['getProfile']>>['parentalControl']>,
  result: ReconcileResult,
): Promise<void> {
  const policy: FilteringPolicy | null = (await getSettings(ctx)).filtering[profile];
  if (!policy) return;
  const appliedRaw = await getInternal(ctx, `filteringApplied:${profile}`);
  const applied: FilteringPolicy = appliedRaw ? JSON.parse(appliedRaw) : {};

  const patch: Record<string, boolean> = {};
  for (const k of ['safeSearch', 'youtubeRestrictedMode', 'blockBypass'] as const) {
    const want = policy[k];
    if (want === undefined) continue;
    const actual = live[k] ?? false;
    if (applied[k] === want && actual !== want)
      result.drift.push({ list: 'parentalControl', id: k, op: 'set', from: actual, to: want });
    if (actual !== want) patch[k] = want;
  }
  try {
    if (Object.keys(patch).length) {
      await ctx.nextdns.patchParentalControl(profileId, patch);
      for (const [k, v] of Object.entries(patch))
        result.changes.push({ list: 'parentalControl', id: k, op: 'set', from: !v, to: v });
    }
    const liveCats = new Map((live.categories ?? []).map((c) => [c.id, c.active !== false]));
    for (const [cat, want] of Object.entries(policy.categories ?? {})) {
      if (want === undefined) continue;
      const actual = liveCats.get(cat);
      if (applied.categories?.[cat as keyof FilteringPolicy['categories']] === want && actual !== want)
        result.drift.push({ list: 'categories', id: cat, op: 'set', from: actual ?? 'absent', to: want });
      if (actual === want) continue;
      if (actual === undefined) await ctx.nextdns.addCategory(profileId, cat, want);
      else await ctx.nextdns.setCategoryActive(profileId, cat, want);
      result.changes.push({ list: 'categories', id: cat, op: actual === undefined ? 'add' : 'set', from: actual ?? null, to: want });
    }
    await setInternal(ctx, `filteringApplied:${profile}`, JSON.stringify(policy));
  } catch (e) {
    const err = e as NextDnsError;
    result.ok = false;
    result.errors.push({ list: 'parentalControl', id: 'settings', message: err.message, authFailure: err.kind === 'AUTH' });
  }
}

async function markManaged(ctx: Ctx, profile: ProfileCode, list: ManagedList, id: string, active: boolean, now: string) {
  await ctx.db
    .prepare(
      `INSERT INTO managed_entries (profileCode, list, entryId, appliedActive, firstManagedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profileCode, list, entryId) DO UPDATE SET appliedActive = excluded.appliedActive`,
    )
    .bind(profile, list, id, active ? 1 : 0, now)
    .run();
}

async function addEntry(ctx: Ctx, profileId: string, list: ManagedList, id: string, active: boolean) {
  try {
    if (list === 'services') await ctx.nextdns.addService(profileId, id, active);
    else await ctx.nextdns.addListEntry(profileId, list, id, active);
  } catch (e) {
    // A concurrent reconcile may have just added it; fall back to setting state.
    if ((e as NextDnsError).kind === 'AUTH') throw e;
    await setEntry(ctx, profileId, list, id, active);
  }
}

function setEntry(ctx: Ctx, profileId: string, list: ManagedList, id: string, active: boolean) {
  return list === 'services'
    ? ctx.nextdns.setServiceActive(profileId, id, active)
    : ctx.nextdns.setListEntryActive(profileId, list, id, active);
}

function removeEntry(ctx: Ctx, profileId: string, list: ManagedList, id: string) {
  return list === 'services' ? ctx.nextdns.removeService(profileId, id) : ctx.nextdns.removeListEntry(profileId, list, id);
}

export async function reconcileProfiles(ctx: Ctx, profiles: readonly ProfileCode[] = PROFILE_CODES) {
  const out: ReconcileResult[] = [];
  for (const p of profiles) out.push(await reconcileProfile(ctx, p));
  return out;
}

/** Did the reconcile fail on any NextDNS entry belonging to this control? */
export function controlErrors(control: ControlView, results: ReconcileResult[]) {
  const ids = new Set([...control.domains, ...(control.nextdnsServiceId ? [control.nextdnsServiceId] : [])]);
  return results
    .filter((r) => control.profiles.includes(r.profileCode))
    .flatMap((r) => [
      ...(r.skipped ? [{ list: 'profile', id: r.profileCode, message: r.skipped, authFailure: false }] : []),
      ...r.errors.filter((e) => e.list === 'profile' || ids.has(e.id)),
    ]);
}

export type { Actor };
