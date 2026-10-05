import { describe, expect, it } from 'vitest';
import * as integrity from '../src/integrity.js';
import { evaluateComponents, type HeartbeatRow, type Observations } from '../src/integrity.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { AP, HOME, PIXEL, setup } from './helpers.js';

const T = DEFAULT_SETTINGS.thresholds;
const NOW = new Date('2026-10-05T01:00:00.000Z');
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function hb(over: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return {
    id: 'hb_1',
    deviceId: 'dev_1',
    receivedAt: ago(2),
    deviceTime: null,
    network: 'CELLULAR',
    privateDnsActive: 1,
    privateDnsServer: `ray--pixel-${PIXEL}.dns.nextdns.io`,
    nextdnsTestStatus: 'ok',
    nextdnsTestProfile: PIXEL,
    canaryNonce: null,
    canaryStatus: 'SKIPPED',
    canaryCheckedAt: null,
    recordingAssistant: null,
    appVersion: null,
    ...over,
  };
}

function obs(over: Partial<Observations> = {}): Observations {
  return {
    now: NOW,
    api: { configured: true, ok: true, authFailure: false, error: null },
    reconcile: { errors: [] },
    restoreFailures: 0,
    profiles: {
      'RAY-PIXEL': { configured: true, probeOk: true, lastDnsAt: ago(1) },
      'HOME-ROUTER': { configured: true, probeOk: true, lastDnsAt: ago(1) },
    },
    expectedPixelProfileId: PIXEL,
    deviceRegistered: true,
    lastHeartbeat: hb(),
    recentCanaries: [],
    ...over,
  };
}

const pixelQuiet = (o: Partial<Observations> = {}) =>
  obs({ profiles: { 'RAY-PIXEL': { configured: true, probeOk: true, lastDnsAt: ago(90) }, 'HOME-ROUTER': { configured: true, probeOk: true, lastDnsAt: ago(1) } }, ...o });

describe('evaluateComponents — do not overinterpret missing DNS', () => {
  it('all good → ACTIVE everywhere', () => {
    const e = evaluateComponents(obs(), T);
    expect(e.NEXTDNS_API.status).toBe('ACTIVE');
    expect(e.DNS_RAY_PIXEL.status).toBe('ACTIVE');
    expect(e.DNS_HOME_ROUTER.status).toBe('ACTIVE');
    expect(e.PHONE_HEARTBEAT.status).toBe('ACTIVE');
    expect(e.POLICY_ENFORCEMENT.status).toBe('ACTIVE');
  });

  it('a quiet phone with no heartbeat is DEGRADED, never INTERRUPTED', () => {
    const e = evaluateComponents(pixelQuiet({ lastHeartbeat: hb({ receivedAt: ago(300) }) }), T);
    expect(e.DNS_RAY_PIXEL.status).toBe('DEGRADED');
    expect(e.DNS_RAY_PIXEL.detail).toMatch(/Insufficient information/);
    expect(e.PHONE_HEARTBEAT.status).toBe('DEGRADED');
  });

  it('phone reports Private DNS off → INTERRUPTED (positive evidence)', () => {
    const e = evaluateComponents(pixelQuiet({ lastHeartbeat: hb({ privateDnsActive: 0 }) }), T);
    expect(e.DNS_RAY_PIXEL).toMatchObject({ status: 'INTERRUPTED', detail: 'Phone reports Android Private DNS is OFF' });
  });

  it('Private DNS pointed at a different provider/profile → INTERRUPTED', () => {
    const e = evaluateComponents(pixelQuiet({ lastHeartbeat: hb({ privateDnsServer: 'dns.google' }) }), T);
    expect(e.DNS_RAY_PIXEL.status).toBe('INTERRUPTED');
    const e2 = evaluateComponents(pixelQuiet({ lastHeartbeat: hb({ nextdnsTestProfile: 'zzz999' }) }), T);
    expect(e2.DNS_RAY_PIXEL.status).toBe('INTERRUPTED');
  });

  it('two consecutive canaries missing from RAY-PIXEL logs → INTERRUPTED; one is not enough', () => {
    const one = evaluateComponents(pixelQuiet({ recentCanaries: [{ canaryStatus: 'NOT_FOUND', receivedAt: ago(5) }] }), T);
    expect(one.DNS_RAY_PIXEL.status).toBe('DEGRADED');
    const two = evaluateComponents(
      pixelQuiet({ recentCanaries: [{ canaryStatus: 'NOT_FOUND', receivedAt: ago(5) }, { canaryStatus: 'NOT_FOUND', receivedAt: ago(20) }] }),
      T,
    );
    expect(two.DNS_RAY_PIXEL.status).toBe('INTERRUPTED');
  });

  it('a verified canary keeps a quiet phone ACTIVE', () => {
    const e = evaluateComponents(pixelQuiet({ lastHeartbeat: hb({ receivedAt: ago(3) }), recentCanaries: [{ canaryStatus: 'VERIFIED', receivedAt: ago(3) }] }), T);
    expect(e.DNS_RAY_PIXEL.status).toBe('ACTIVE');
  });

  it('a bad report is ignored when DNS was verified after it', () => {
    const e = evaluateComponents(obs({ lastHeartbeat: hb({ receivedAt: ago(10), privateDnsActive: 0 }) }), T);
    expect(e.DNS_RAY_PIXEL.status).toBe('ACTIVE');
  });

  it('offline phone (network NONE) cannot be judged a bypass', () => {
    const e = evaluateComponents(pixelQuiet({ lastHeartbeat: hb({ network: 'NONE', privateDnsActive: 0 }) }), T);
    expect(e.DNS_RAY_PIXEL.status).toBe('DEGRADED');
  });

  it('a rejected API key is an INTERRUPTION of AP administration; other errors DEGRADED', () => {
    expect(evaluateComponents(obs({ api: { configured: true, ok: false, authFailure: true, error: 'x' } }), T).NEXTDNS_API.status).toBe('INTERRUPTED');
    expect(evaluateComponents(obs({ api: { configured: true, ok: false, authFailure: false, error: 'x' } }), T).NEXTDNS_API.status).toBe('DEGRADED');
  });

  it('home router silence is DEGRADED with legitimate causes listed', () => {
    const e = evaluateComponents(obs({ profiles: { 'RAY-PIXEL': { configured: true, probeOk: true, lastDnsAt: ago(1) }, 'HOME-ROUTER': { configured: true, probeOk: true, lastDnsAt: ago(45) } } }), T);
    expect(e.DNS_HOME_ROUTER.status).toBe('DEGRADED');
    expect(e.DNS_HOME_ROUTER.detail).toMatch(/internet outage/);
  });

  it('failed restorations make policy enforcement INTERRUPTED', () => {
    expect(evaluateComponents(obs({ restoreFailures: 1 }), T).POLICY_ENFORCEMENT.status).toBe('INTERRUPTED');
  });
});

describe('heartbeat + canary', () => {
  it('issues a one-time challenge, accepts it once, and verifies it from RAY-PIXEL logs', async () => {
    const env = setup();
    const { token } = await integrity.issueDeviceToken(env.ctx, AP, { label: 'Ray Pixel' });
    const device = (await integrity.authenticateDevice(env.ctx, `Bearer ${token}`))!;
    expect(device).toBeTruthy();
    expect(await integrity.authenticateDevice(env.ctx, 'Bearer mrbd_wrong')).toBeNull();

    const ch = await integrity.issueChallenge(env.ctx, device);
    expect(ch.canaryHost).toBe(`${ch.nonce}.hb.example.test`);
    await integrity.recordHeartbeat(env.ctx, device, { network: 'WIFI', privateDnsActive: true, canaryNonce: ch.nonce });
    await expect(integrity.recordHeartbeat(env.ctx, device, { network: 'WIFI', canaryNonce: ch.nonce })).rejects.toMatchObject({ code: 'invalid_challenge' });

    // The phone's lookup shows up in RAY-PIXEL's NextDNS log.
    env.nextdns.p(PIXEL).logs.push({ timestamp: env.clock.now().toISOString(), domain: ch.canaryHost!, status: 'default' });
    env.clock.advance(2);
    expect(await integrity.verifyCanaries(env.ctx)).toEqual({ verified: 1, notFound: 0 });
  });

  it('marks a canary NOT_FOUND only after the log-latency window', async () => {
    const env = setup();
    const { token } = await integrity.issueDeviceToken(env.ctx, AP, { label: 'Ray Pixel' });
    const device = (await integrity.authenticateDevice(env.ctx, `Bearer ${token}`))!;
    const ch = await integrity.issueChallenge(env.ctx, device);
    await integrity.recordHeartbeat(env.ctx, device, { network: 'CELLULAR', canaryNonce: ch.nonce });
    env.clock.advance(2);
    expect(await integrity.verifyCanaries(env.ctx)).toEqual({ verified: 0, notFound: 0 });
    env.clock.advance(10);
    expect(await integrity.verifyCanaries(env.ctx)).toEqual({ verified: 0, notFound: 1 });
  });

  it('stores only a hash of the device token', async () => {
    const env = setup();
    const { token } = await integrity.issueDeviceToken(env.ctx, AP, { label: 'Ray Pixel' });
    const row = env.raw.prepare(`SELECT tokenHash FROM devices`).get() as { tokenHash: string };
    expect(row.tokenHash).not.toContain(token);
    expect(JSON.stringify(env.auditRows())).not.toContain(token);
  });
});

describe('incident lifecycle (spec example)', () => {
  it('ACTIVE → INTERRUPTED → RESTORED → REVIEWED, preserving the interruption', async () => {
    const env = setup();
    const { ctx, clock, nextdns, raw, auditRows } = env;
    const { token } = await integrity.issueDeviceToken(ctx, AP, { label: 'Ray Pixel' });
    const device = (await integrity.authenticateDevice(ctx, `Bearer ${token}`))!;
    const dns = (pid: string) => nextdns.p(pid).logs.push({ timestamp: clock.now().toISOString(), domain: 'example.com', status: 'default' });

    // 8:41 PM — verified active.
    clock.t = new Date('2026-10-05T00:41:00.000Z');
    dns(PIXEL);
    dns(HOME);
    await integrity.recordHeartbeat(ctx, device, { network: 'WIFI', privateDnsActive: true, privateDnsServer: `${PIXEL}.dns.nextdns.io` });
    await integrity.runIntegrityChecks(ctx, true);
    let status = await integrity.getIntegrityStatus(ctx);
    expect(status.components.find((c) => c.code === 'DNS_RAY_PIXEL')!.status).toBe('ACTIVE');

    // 8:46 PM — phone reports Private DNS turned off.
    clock.t = new Date('2026-10-05T00:46:00.000Z');
    dns(HOME);
    await integrity.recordHeartbeat(ctx, device, { network: 'WIFI', privateDnsActive: false });
    await integrity.runIntegrityChecks(ctx, true);
    const inc = raw.prepare(`SELECT * FROM integrity_incidents WHERE componentCode = 'DNS_RAY_PIXEL'`).get() as Record<string, string>;
    expect(inc).toMatchObject({ kind: 'INTERRUPTION', status: 'OPEN', lastVerifiedActiveAt: '2026-10-05T00:41:00.000Z', detectedAt: '2026-10-05T00:46:00.000Z' });
    status = await integrity.getIntegrityStatus(ctx);
    expect(status.overall).toBe('INTERRUPTED');
    await expect(integrity.reviewIncident(ctx, AP, inc.id!, { disposition: 'ACKNOWLEDGED', note: 'x' })).rejects.toMatchObject({ code: 'still_open' });

    // 9:03 PM — restored.
    clock.t = new Date('2026-10-05T01:03:00.000Z');
    dns(PIXEL);
    dns(HOME);
    await integrity.recordHeartbeat(ctx, device, { network: 'WIFI', privateDnsActive: true, privateDnsServer: `${PIXEL}.dns.nextdns.io` });
    await integrity.runIntegrityChecks(ctx, true);
    const restored = raw.prepare(`SELECT * FROM integrity_incidents WHERE id = ?`).get(inc.id) as Record<string, unknown>;
    expect(restored).toMatchObject({ status: 'RESTORED', restoredAt: '2026-10-05T01:03:00.000Z', interruptionMinutes: 17 });
    status = await integrity.getIntegrityStatus(ctx);
    expect(status.components.find((c) => c.code === 'DNS_RAY_PIXEL')!.status).toBe('RESTORED');
    expect(status.headline).toMatch(/AP REVIEW REQUIRED/);

    // History cannot be rewritten.
    expect(() => raw.prepare(`UPDATE integrity_incidents SET detectedAt = ? WHERE id = ?`).run('2026-10-05T01:00:00.000Z', inc.id)).toThrow(/cannot be rewritten/);
    expect(() => raw.prepare(`DELETE FROM integrity_incidents WHERE id = ?`).run(inc.id)).toThrow(/cannot be deleted/);

    await integrity.reviewIncident(ctx, AP, inc.id!, { disposition: 'REFERRED_FOR_VIOLATION_REVIEW', note: 'Discuss at weekly recap' });
    status = await integrity.getIntegrityStatus(ctx);
    expect(status.components.find((c) => c.code === 'DNS_RAY_PIXEL')!.status).toBe('ACTIVE');
    expect(() => raw.prepare(`UPDATE integrity_incidents SET reviewNote = 'edited' WHERE id = ?`).run(inc.id)).toThrow();
    expect(auditRows().map((r) => r.action)).toEqual(
      expect.arrayContaining(['integrity.incident_opened', 'integrity.restored', 'integrity.reviewed']),
    );
  });

  it('opens a REPORTING_GAP (not an interruption) only after the threshold, and only once armed', async () => {
    const env = setup();
    const { ctx, clock, nextdns, raw } = env;
    // Never verified → no incident however long it is quiet.
    await integrity.runIntegrityChecks(ctx, true);
    clock.advance(200);
    await integrity.runIntegrityChecks(ctx, true);
    expect(raw.prepare(`SELECT COUNT(*) n FROM integrity_incidents WHERE componentCode = 'DNS_HOME_ROUTER'`).get()).toEqual({ n: 0 });

    nextdns.p(HOME).logs.push({ timestamp: clock.now().toISOString(), domain: 'tv.example', status: 'default' });
    await integrity.runIntegrityChecks(ctx, true); // armed
    clock.advance(40);
    await integrity.runIntegrityChecks(ctx, true); // degraded since now
    clock.advance(59);
    await integrity.runIntegrityChecks(ctx, true);
    expect(raw.prepare(`SELECT COUNT(*) n FROM integrity_incidents WHERE componentCode = 'DNS_HOME_ROUTER'`).get()).toEqual({ n: 0 });
    clock.advance(2);
    await integrity.runIntegrityChecks(ctx, true);
    expect(raw.prepare(`SELECT kind, status FROM integrity_incidents WHERE componentCode = 'DNS_HOME_ROUTER'`).get()).toEqual({ kind: 'REPORTING_GAP', status: 'OPEN' });
  });

  it('respects the AP-configured check interval', async () => {
    const env = setup();
    expect(await integrity.runIntegrityChecks(env.ctx)).toEqual({ ran: true });
    env.clock.advance(2);
    expect(await integrity.runIntegrityChecks(env.ctx)).toEqual({ ran: false });
    env.clock.advance(3);
    expect(await integrity.runIntegrityChecks(env.ctx)).toEqual({ ran: true });
  });
});

describe('audit log', () => {
  it('is append-only at the database level', async () => {
    const env = setup();
    await integrity.issueDeviceToken(env.ctx, AP, { label: 'Ray Pixel' });
    expect(() => env.raw.prepare(`UPDATE audit_log SET summary = 'x'`).run()).toThrow(/append-only/);
    expect(() => env.raw.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/);
  });
});
