import { describe, expect, it } from 'vitest';
import * as access from '../src/access.js';
import * as controls from '../src/controls.js';
import { runScheduled } from '../src/index.js';
import * as ops from '../src/operations.js';
import { AP, HOME, PARTICIPANT, PIXEL, setup } from './helpers.js';

async function blockReddit(env = setup()) {
  const out = await ops.blockDomain(env.ctx, AP, { domain: 'https://www.Reddit.com/r/all', label: 'Reddit' });
  return { ...env, control: out.control, out };
}

describe('Phase 1/2 — block, allow, audit', () => {
  it('blocks a domain on both profiles and records an audit entry', async () => {
    const { nextdns, out, auditRows } = await blockReddit();
    expect(out.applied).toBe(true);
    expect(out.control.domains).toEqual(['www.reddit.com']);
    expect(out.control.state).toBe('BLOCKED');
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
    expect(nextdns.deny(HOME, 'www.reddit.com')).toBe(true);
    const a = auditRows().find((r) => r.action === 'control.blocked')!;
    expect(a.actorType).toBe('AP');
    expect(a.automatic).toBe(0);
    expect(a.summary).toContain('blocked Reddit');
  });

  it('allowDomain deactivates (does not delete) the entry; re-block re-activates it', async () => {
    const { ctx, nextdns, control, auditRows } = await blockReddit();
    const allowed = await ops.allowDomain(ctx, AP, control.id, 'Weekend');
    expect(allowed.control.state).toBe('ALLOWED');
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(false);
    await ops.reblockControl(ctx, AP, control.id);
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
    const rows = auditRows().filter((r) => r.action === 'control.allowed');
    expect(JSON.parse(rows[0]!.previousState!)).toEqual({ policy: 'BLOCKED' });
    expect(JSON.parse(rows[0]!.newState!)).toEqual({ policy: 'ALLOWED' });
  });

  it('scopes a control to one profile', async () => {
    const env = setup();
    await ops.blockDomain(env.ctx, AP, { domain: 'doordash.com', label: 'DoorDash', profiles: ['RAY-PIXEL'] });
    expect(env.nextdns.deny(PIXEL, 'doordash.com')).toBe(true);
    expect(env.nextdns.deny(HOME, 'doordash.com')).toBeUndefined();
  });

  it('manages a NextDNS parental-control service id alongside domains', async () => {
    const env = setup();
    await ops.blockDomain(env.ctx, AP, { domain: 'reddit.com', label: 'Reddit', nextdnsServiceId: 'reddit' });
    expect(env.nextdns.p(PIXEL).parentalControl.services).toEqual([{ id: 'reddit', active: true }]);
  });

  it('rejects allowlist/denylist overlaps in both directions', async () => {
    const { ctx } = await blockReddit();
    await expect(controls.addAllowlistEntry(ctx, AP, { domain: 'old.www.reddit.com' })).rejects.toMatchObject({ status: 409 });
    await controls.addAllowlistEntry(ctx, AP, { domain: 'wellsfargo.com' });
    await expect(ops.blockDomain(ctx, AP, { domain: 'online.wellsfargo.com' })).rejects.toMatchObject({ code: 'allowlist_conflict' });
  });

  it('never touches entries created by hand in the NextDNS dashboard', async () => {
    const env = setup();
    env.nextdns.p(PIXEL).denylist.push({ id: 'manual.example', active: true });
    await ops.blockDomain(env.ctx, AP, { domain: 'reddit.com' });
    await controls.reconcileProfiles(env.ctx);
    expect(env.nextdns.deny(PIXEL, 'manual.example')).toBe(true);
  });

  it('archiving removes the managed entries but keeps the row and history', async () => {
    const { ctx, nextdns, control, raw } = await blockReddit();
    await controls.archiveControl(ctx, AP, control.id, 'No longer needed');
    await controls.reconcileProfiles(ctx);
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBeUndefined();
    expect(raw.prepare(`SELECT archivedAt FROM web_controls WHERE id = ?`).get(control.id)).toMatchObject({ archivedAt: expect.any(String) });
  });
});

describe('Phase 3 — temporary access', () => {
  it('grants 30 minutes, then restores automatically at expiry (example from the spec)', async () => {
    const { ctx, nextdns, control, clock, auditRows } = await blockReddit();
    const grant = await ops.grantTemporaryAccess(ctx, AP, { controlId: control.id, minutes: 30 });
    expect(grant.status).toBe('ACTIVE');
    expect(grant.expiresAt).toBe('2026-10-05T01:12:00.000Z'); // 9:12 PM ET
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(false);
    expect((await controls.getControl(ctx, control.id)).state).toBe('TEMPORARILY_ALLOWED');
    expect(auditRows().at(-1)!.summary).toBe('AP granted Reddit access for 30 minutes');

    clock.advance(29);
    await runScheduled(ctx);
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(false);

    clock.advance(1);
    await runScheduled(ctx);
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
    expect(nextdns.deny(HOME, 'www.reddit.com')).toBe(true);
    const restored = auditRows().find((r) => r.action === 'access.expired_restored')!;
    expect(restored.summary).toBe('Temporary access expired. Reddit restriction restored.');
    expect(restored.actorType).toBe('SYSTEM');
    expect(restored.automatic).toBe(1);
    expect((await access.getGrant(ctx, grant.id))).toMatchObject({ status: 'EXPIRED', restoreStatus: 'RESTORED' });
  });

  it('an overdue grant never lifts a restriction, even before the sweep runs', async () => {
    const { ctx, control, clock } = await blockReddit();
    await ops.grantTemporaryAccess(ctx, AP, { controlId: control.id, minutes: 10 });
    clock.advance(11);
    expect((await controls.getControl(ctx, control.id)).state).toBe('BLOCKED');
  });

  it('participant request → AP approves with a different duration', async () => {
    const { ctx, control, auditRows } = await blockReddit();
    const req = await access.requestAccess(ctx, PARTICIPANT, { controlId: control.id, minutes: 30, reason: 'Research for a work vendor issue' });
    expect(req.status).toBe('PENDING');
    await expect(access.requestAccess(ctx, PARTICIPANT, { controlId: control.id, minutes: 5, reason: 'again' })).rejects.toMatchObject({ code: 'request_pending' });
    const { request, grant } = await access.decideRequest(ctx, AP, req.id, { decision: 'APPROVE', minutes: 15 });
    expect(request).toMatchObject({ status: 'APPROVED', approvedMinutes: 15, grantId: grant!.id });
    expect(auditRows().at(-1)!.summary).toBe('AP granted Reddit access for 15 minutes (requested 30 minutes)');
  });

  it('denies and lapses requests without changing the restriction', async () => {
    const { ctx, control, clock, nextdns } = await blockReddit();
    const r1 = await access.requestAccess(ctx, PARTICIPANT, { controlId: control.id, minutes: 30, reason: 'bored' });
    await access.decideRequest(ctx, AP, r1.id, { decision: 'DENY', note: 'Not tonight' });
    const r2 = await access.requestAccess(ctx, PARTICIPANT, { controlId: control.id, minutes: 30, reason: 'please' });
    clock.advance(121);
    await runScheduled(ctx);
    expect((await access.getRequest(ctx, r2.id))!.status).toBe('LAPSED');
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
  });

  it('rejects durations above the AP maximum and requests for unblocked services', async () => {
    const { ctx, control } = await blockReddit();
    await expect(access.requestAccess(ctx, PARTICIPANT, { controlId: control.id, minutes: 600, reason: 'long' })).rejects.toMatchObject({ code: 'invalid_duration' });
    await ops.allowDomain(ctx, AP, control.id);
    await expect(access.requestAccess(ctx, PARTICIPANT, { controlId: control.id, minutes: 10, reason: 'x y z' })).rejects.toMatchObject({ code: 'not_blocked' });
  });

  it('fails closed when NextDNS refuses the grant', async () => {
    const { ctx, control, nextdns } = await blockReddit();
    nextdns.failWhen = (m, p) => (m === 'PATCH' && p.endsWith('/denylist/www.reddit.com') ? 500 : null);
    await expect(ops.grantTemporaryAccess(ctx, AP, { controlId: control.id, minutes: 30 })).rejects.toMatchObject({ status: 502 });
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
    expect((await controls.getControl(ctx, control.id)).state).toBe('BLOCKED');
  });

  it('a failed approval releases the claim only when nothing was granted', async () => {
    const { ctx, control, nextdns } = await blockReddit();
    const req = await access.requestAccess(ctx, PARTICIPANT, { controlId: control.id, minutes: 30, reason: 'need it' });
    nextdns.failWhen = (m) => (m === 'PATCH' ? 500 : null);
    await expect(access.decideRequest(ctx, AP, req.id, { decision: 'APPROVE' })).rejects.toMatchObject({ status: 502 });
    const after = (await access.getRequest(ctx, req.id))!;
    expect(after.status).toBe('APPROVED'); // the decision is on record...
    expect((await access.getGrant(ctx, after.grantId!))!.status).toBe('APPLY_FAILED'); // ...with the failed grant linked
  });

  it('retries a failed restoration every tick and surfaces it until NextDNS confirms', async () => {
    const { ctx, control, nextdns, clock, auditRows, alerts } = await blockReddit();
    const grant = await ops.grantTemporaryAccess(ctx, AP, { controlId: control.id, minutes: 5 });
    nextdns.failWhen = (m) => (m === 'PATCH' ? 503 : null);
    clock.advance(5);
    await runScheduled(ctx);
    expect((await access.getGrant(ctx, grant.id))!.restoreStatus).toBe('FAILED');
    expect(auditRows().some((r) => r.action === 'access.restore_failed')).toBe(true);
    expect(alerts.some((a) => (a as { kind: string }).kind === 'restore_failed')).toBe(true);
    // A new grant cannot be stacked on an unconfirmed restore.
    await expect(ops.grantTemporaryAccess(ctx, AP, { controlId: control.id, minutes: 5 })).rejects.toMatchObject({ status: 503 });

    nextdns.failWhen = null;
    clock.advance(1);
    await runScheduled(ctx);
    expect((await access.getGrant(ctx, grant.id))!.restoreStatus).toBe('RESTORED');
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
  });

  it('AP can end access early (restoreRestriction)', async () => {
    const { ctx, control, nextdns, auditRows } = await blockReddit();
    await ops.grantTemporaryAccess(ctx, AP, { controlId: control.id, minutes: 30 });
    const g = await ops.restoreRestriction(ctx, AP, { controlId: control.id, reason: 'Time is up' });
    expect(g).toMatchObject({ status: 'REVOKED', restoreStatus: 'RESTORED' });
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
    expect(auditRows().map((r) => r.action)).toEqual(expect.arrayContaining(['access.revoked', 'access.revoked_restored']));
  });
});

describe('Filtering settings + drift', () => {
  it('applies managed filtering settings and categories', async () => {
    const env = setup();
    const { setSetting } = await import('../src/settings.js');
    await setSetting(env.ctx, AP, 'filtering', {
      'RAY-PIXEL': { safeSearch: true, youtubeRestrictedMode: true, blockBypass: true, categories: { gambling: true } },
      'HOME-ROUTER': null,
    });
    await controls.reconcileProfiles(env.ctx);
    expect(env.nextdns.p(PIXEL).parentalControl).toMatchObject({ safeSearch: true, youtubeRestrictedMode: true, blockBypass: true });
    expect(env.nextdns.p(PIXEL).parentalControl.categories).toEqual([{ id: 'gambling', active: true }]);
    expect(env.nextdns.p(HOME).parentalControl.safeSearch).toBe(false);
  });

  it('detects and corrects managed entries changed outside the portal', async () => {
    const { ctx, nextdns, raw } = await blockReddit();
    nextdns.p(PIXEL).denylist.find((e) => e.id === 'www.reddit.com')!.active = false; // someone used the dashboard
    const { runIntegrityChecks } = await import('../src/integrity.js');
    await runIntegrityChecks(ctx, true);
    expect(nextdns.deny(PIXEL, 'www.reddit.com')).toBe(true);
    const inc = raw.prepare(`SELECT * FROM integrity_incidents WHERE kind = 'CONFIGURATION_DRIFT'`).get() as { status: string; evidence: string };
    expect(inc.status).toBe('RESTORED'); // corrected, but kept for AP review
    expect(JSON.parse(inc.evidence)[0].drift[0]).toMatchObject({ id: 'www.reddit.com', from: false, to: true });
  });
});
