/**
 * The permitted AP operations. Routes call these; nothing else reaches the
 * NextDNS client. This is the application-level permission model: specific,
 * named operations instead of a generic NextDNS API console.
 */
import type { Actor } from './audit.js';
import type { Ctx, ProfileCode } from './context.js';
import { PROFILE_CODES } from './context.js';
import {
  controlErrors,
  createControl,
  getControl,
  listControls,
  reconcileProfiles,
  setControlPolicy,
  type ControlView,
} from './controls.js';
import { getIntegrityStatus } from './integrity.js';
import { normalizeDomain } from './util.js';

export { grantTemporaryAccess, restoreRestriction } from './access.js';
export { getDnsActivity, getMonitoredEvents } from './activity.js';
export { getIntegrityStatus } from './integrity.js';

export interface ApplyOutcome {
  control: ControlView;
  /** True when NextDNS confirmed the change on every affected profile. */
  applied: boolean;
  errors: string[];
}

async function applyControl(ctx: Ctx, control: ControlView): Promise<ApplyOutcome> {
  const results = await reconcileProfiles(ctx, control.profiles);
  const errors = controlErrors(control, results).map((e) => e.message);
  // On failure the desired policy stays recorded and the scheduler keeps
  // retrying; POLICY_ENFORCEMENT surfaces it in the integrity dashboard.
  return { control: await getControl(ctx, control.id), applied: errors.length === 0, errors };
}

/** Block a domain: re-block its existing control, or create a new one. */
export async function blockDomain(
  ctx: Ctx,
  actor: Actor,
  input: { domain: string; label?: string; profiles?: string[]; nextdnsServiceId?: string | null; note?: string | null },
): Promise<ApplyOutcome> {
  const domain = normalizeDomain(input.domain);
  const existing = (await listControls(ctx)).find((c) => c.domains.includes(domain));
  const control = existing
    ? await setControlPolicy(ctx, actor, existing.id, 'BLOCKED', input.note)
    : await createControl(ctx, actor, {
        label: input.label?.trim() || domain,
        domains: [domain],
        profiles: input.profiles,
        nextdnsServiceId: input.nextdnsServiceId,
        note: input.note,
        policy: 'BLOCKED',
      });
  return applyControl(ctx, control);
}

/** Lift a control's standing restriction (it stays listed and tracked). */
export async function allowDomain(ctx: Ctx, actor: Actor, controlId: string, reason?: string | null) {
  return applyControl(ctx, await setControlPolicy(ctx, actor, controlId, 'ALLOWED', reason));
}

/** Re-impose a control's standing restriction. */
export async function reblockControl(ctx: Ctx, actor: Actor, controlId: string, reason?: string | null) {
  return applyControl(ctx, await setControlPolicy(ctx, actor, controlId, 'BLOCKED', reason));
}

export async function syncControl(ctx: Ctx, controlId: string) {
  return applyControl(ctx, await getControl(ctx, controlId));
}

export async function getNextDnsStatus(ctx: Ctx) {
  const integrity = await getIntegrityStatus(ctx);
  const byCode = new Map(integrity.components.map((c) => [c.code, c]));
  const { results: profileRows } = await ctx.db
    .prepare(`SELECT * FROM profiles`)
    .all<{ code: ProfileCode; label: string; context: string; attributedToParticipant: number; lastDnsAt: string | null }>();
  const api = byCode.get('NEXTDNS_API');
  return {
    nextdns: {
      configured: ctx.nextdns.configured,
      status: api?.status ?? 'UNKNOWN',
      detail: api?.detail ?? null,
    },
    profiles: PROFILE_CODES.map((code) => {
      const row = profileRows.find((r) => r.code === code)!;
      const comp = byCode.get(code === 'RAY-PIXEL' ? 'DNS_RAY_PIXEL' : 'DNS_HOME_ROUTER');
      return {
        code,
        label: row.label,
        context: row.context,
        attributedToParticipant: row.attributedToParticipant === 1,
        configured: !!ctx.profileId(code),
        status: comp?.status ?? 'UNKNOWN',
        detail: comp?.detail ?? null,
        lastDnsAt: row.lastDnsAt,
      };
    }),
    controls: (await listControls(ctx)).map((c) => ({
      id: c.id,
      label: c.label,
      state: c.state,
      expiresAt: c.activeGrant?.expiresAt ?? null,
    })),
  };
}
