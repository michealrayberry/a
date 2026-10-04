import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import { makeHarness, type Harness } from './helpers.js';
import { createApp } from '../src/app.js';
import { SimulatedNextDnsGateway } from '../src/nextdns/gateway.js';
import { evaluatePrivateDns, privateDnsMatchesProfile, runIntegritySweep } from '../src/services/integrity.js';
import type { Clock } from '../src/time.js';

const START = '2026-10-04T00:41:00Z'; // 8:41 PM EDT

function mutableClock(iso: string) {
  let now = DateTime.fromISO(iso, { zone: 'utc' });
  const clock: Clock = { now: () => now };
  return { clock, advance: (minutes: number) => (now = now.plus({ minutes })), iso: () => now.toISO()! };
}

const OK = { deviceId: 'pixel-8', privateDnsMode: 'hostname', privateDnsHost: 'Ray--Pixel-abc123.dns.nextdns.io', network: 'WIFI', recordingReady: true };

describe('monitoring integrity (Phase 5)', () => {
  let h: Harness;
  let gw: SimulatedNextDnsGateway;
  let t: ReturnType<typeof mutableClock>;
  let app: ReturnType<typeof createApp>;
  let ap: string;
  let p: string;

  const beat = (body: object = OK) => request(app).post('/participant/integrity/heartbeat').set('authorization', p).send(body);
  const status = async () => (await request(app).get('/ap/integrity').set('authorization', ap)).body;
  const sweep = () => runIntegritySweep(h.db, gw, t.clock, { forceNextDnsCheck: true });
  const traffic = () => {
    gw.recordQuery('abc123', t.iso());
    gw.recordQuery('def456', t.iso());
  };

  beforeEach(async () => {
    h = makeHarness();
    t = mutableClock(START);
    gw = new SimulatedNextDnsGateway(() => t.iso(), false, false);
    gw.addProfile('abc123');
    gw.addProfile('def456');
    app = createApp(h.db, t.clock, gw);
    ap = `Bearer ${(await request(app).post('/auth/login').send({ email: 'ap@example.com', password: 'pw' })).body.token}`;
    p = `Bearer ${(await request(app).post('/auth/login').send({ email: 'p@example.com', password: 'pw' })).body.token}`;
    await request(app).put('/ap/web-controls/profiles/RAY-PIXEL').set('authorization', ap).send({ nextdnsProfileId: 'abc123' });
    await request(app).put('/ap/web-controls/profiles/HOME-ROUTER').set('authorization', ap).send({ nextdnsProfileId: 'def456' });
  });

  it('matches NextDNS Private DNS hostnames, including device-name prefixes', () => {
    expect(privateDnsMatchesProfile('abc123.dns.nextdns.io', 'abc123')).toBe(true);
    expect(privateDnsMatchesProfile('Ray--Pixel-abc123.dns.nextdns.io', 'abc123')).toBe(true);
    expect(privateDnsMatchesProfile('xabc123.dns.nextdns.io', 'abc123')).toBe(false);
    expect(privateDnsMatchesProfile('dns.google', 'abc123')).toBe(false);
    expect(evaluatePrivateDns('opportunistic', null, 'abc123')).toBe('DISABLED');
    expect(evaluatePrivateDns('hostname', 'def456.dns.nextdns.io', 'abc123')).toBe('MISCONFIGURED');
    expect(evaluatePrivateDns('unknown', null, 'abc123')).toBe('UNKNOWN');
  });

  it('all systems reporting with a compliant heartbeat and live DNS', async () => {
    traffic();
    const res = await beat();
    expect(res.status).toBe(200);
    expect(res.body.privateDns).toBe('CONFIRMED');
    await sweep();
    const s = await status();
    expect(s.overall).toBe('ACTIVE');
    expect(s.components.find((c: any) => c.component === 'Phone heartbeat').status).toBe('ONLINE');
    expect(s.components.find((c: any) => c.component === 'Pixel Private DNS').status).toBe('CONFIRMED');
    expect(s.components.find((c: any) => c.component === 'Recording Assistant').status).toBe('READY');
  });

  it('Private DNS turned off → INTERRUPTED; restoration keeps the record and requires AP review', async () => {
    traffic();
    await beat(); // 8:41 verified
    t.advance(5); // 8:46
    const off = await beat({ ...OK, privateDnsMode: 'off', privateDnsHost: null });
    expect(off.body.privateDns).toBe('DISABLED');
    let s = await status();
    expect(s.overall).toBe('INTERRUPTED');
    expect(s.summary).toContain('DNS ACCOUNTABILITY INTERRUPTED');

    // Participant gets a notice.
    const notices = (await request(app).get('/participant/notices').set('authorization', p)).body;
    expect(notices.some((n: any) => n.title === 'DNS ACCOUNTABILITY INTERRUPTED')).toBe(true);

    t.advance(17); // 9:03
    traffic();
    await beat();
    s = await status();
    const inc = s.incidents.find((i: any) => i.type === 'PRIVATE_DNS_DISABLED');
    expect(inc).toMatchObject({
      status: 'AP_REVIEW_REQUIRED',
      statusLabel: 'AP REVIEW REQUIRED',
      lastVerifiedAt: '2026-10-04T00:41:00.000Z',
      detectedAt: '2026-10-04T00:46:00.000Z',
      restoredAt: '2026-10-04T01:03:00.000Z',
      interruptionMinutes: 17,
      maxWindowMinutes: 22,
    });
    expect(s.overall).toBe('RESTORED');
    expect(s.reviewRequired).toBe(1);

    const hist = (await request(app).get('/ap/web-controls/history').set('authorization', ap)).body;
    expect(hist).toBeDefined();
    const audit = (await request(app).get('/ap/audit').set('authorization', ap)).body;
    const restored = audit.find((a: any) => a.action === 'INTEGRITY_INCIDENT_RESTORED');
    expect(restored.reason).toContain('Interruption: 17 minutes');
    expect(audit.some((a: any) => a.action === 'INTEGRITY_INCIDENT_OPENED')).toBe(true);
  });

  it('participant explains once; AP reviews with a determination; nothing can be deleted', async () => {
    await beat();
    t.advance(5);
    await beat({ ...OK, privateDnsMode: 'opportunistic' });
    t.advance(10);
    await beat();
    const inc = (await status()).incidents[0];

    const ex = await request(app)
      .post(`/participant/integrity/incidents/${inc.id}/explanation`)
      .set('authorization', p)
      .send({ explanation: 'Hotel captive portal required Private DNS off to sign in.' });
    expect(ex.status).toBe(200);
    const again = await request(app)
      .post(`/participant/integrity/incidents/${inc.id}/explanation`)
      .set('authorization', p)
      .send({ explanation: 'edited' });
    expect(again.status).toBe(409);

    // Participant cannot review their own incident.
    expect((await request(app).post(`/ap/integrity/incidents/${inc.id}/review`).set('authorization', p).send({})).status).toBe(403);

    expect((await request(app).post(`/ap/integrity/incidents/${inc.id}/review`).set('authorization', ap).send({ determination: 'AUTHORIZED_EXCEPTION' })).status).toBe(400);
    const rv = await request(app)
      .post(`/ap/integrity/incidents/${inc.id}/review`)
      .set('authorization', ap)
      .send({ determination: 'AUTHORIZED_EXCEPTION', note: 'Captive portal; restored within 10 minutes.' });
    expect(rv.status).toBe(200);
    expect(rv.body.status).toBe('REVIEWED');
    expect((await status()).overall).toBe('ACTIVE');

    expect(() => h.db.prepare(`DELETE FROM integrity_incidents`).run()).toThrow(/cannot be deleted/);
  });

  it('an open incident cannot be reviewed away', async () => {
    await beat();
    await beat({ ...OK, privateDnsMode: 'off' });
    const inc = (await status()).incidents[0];
    const rv = await request(app).post(`/ap/integrity/incidents/${inc.id}/review`).set('authorization', ap).send({ determination: 'TECHNICAL_FAILURE', note: 'x' });
    expect(rv.status).toBe(409);
  });

  it('pointing Private DNS at a different profile is an interruption', async () => {
    await beat();
    const res = await beat({ ...OK, privateDnsHost: 'def456.dns.nextdns.io' });
    expect(res.body.privateDns).toBe('MISCONFIGURED');
    expect((await status()).overall).toBe('INTERRUPTED');
  });

  it('heartbeat silence is DEGRADED, not INTERRUPTED; short gaps need no review', async () => {
    traffic();
    await beat();
    t.advance(46);
    traffic();
    await sweep();
    let s = await status();
    expect(s.overall).toBe('DEGRADED');
    expect(s.incidents[0]).toMatchObject({ type: 'PHONE_HEARTBEAT_LOST', severity: 'DEGRADED', status: 'OPEN' });
    expect(JSON.stringify(s.incidents)).not.toContain('INTERRUPTED');
    // No participant notice for mere silence.
    const notices = (await request(app).get('/participant/notices').set('authorization', p)).body;
    expect(notices.some((n: any) => n.type === 'INTEGRITY')).toBe(false);

    t.advance(10);
    await beat();
    s = await status();
    expect(s.incidents[0]).toMatchObject({ type: 'PHONE_HEARTBEAT_LOST', status: 'CLOSED' });
  });

  it('long heartbeat loss (≥ 3h) requires AP review', async () => {
    await beat();
    t.advance(46);
    await sweep();
    t.advance(180);
    await beat();
    const s = await status();
    expect(s.incidents.find((i: any) => i.type === 'PHONE_HEARTBEAT_LOST').status).toBe('AP_REVIEW_REQUIRED');
  });

  it('never-seen phone opens no incident', async () => {
    t.advance(500);
    traffic();
    await sweep();
    const s = await status();
    expect(s.incidents).toHaveLength(0);
    expect(s.components.find((c: any) => c.component === 'Phone heartbeat').status).toBe('NEVER_SEEN');
  });

  it('heartbeat claims compliance but NextDNS sees no Pixel traffic → mismatch for review', async () => {
    gw.recordQuery('abc123', t.iso());
    gw.recordQuery('def456', t.iso());
    for (let i = 0; i < 5; i++) {
      t.advance(15);
      gw.recordQuery('def456', t.iso()); // home network busy, Pixel silent
      await beat();
      await sweep();
    }
    const s = await status();
    const mm = s.incidents.find((i: any) => i.type === 'DNS_HEARTBEAT_MISMATCH');
    expect(mm).toMatchObject({ severity: 'DEGRADED', status: 'OPEN' });

    gw.recordQuery('abc123', t.iso());
    await sweep();
    const after = (await status()).incidents.find((i: any) => i.type === 'DNS_HEARTBEAT_MISMATCH');
    expect(after.status).toBe('AP_REVIEW_REQUIRED');
  });

  it('home router silence is recorded, never attributed, and needs no review', async () => {
    gw.recordQuery('abc123', t.iso());
    gw.recordQuery('def456', t.iso());
    t.advance(121);
    gw.recordQuery('abc123', t.iso());
    await sweep();
    let inc = (await status()).incidents.find((i: any) => i.type === 'HOME_ROUTER_SILENT');
    expect(inc.detail).toContain('Not attributable to the participant');
    gw.recordQuery('def456', t.iso());
    await sweep();
    inc = (await status()).incidents.find((i: any) => i.type === 'HOME_ROUTER_SILENT');
    expect(inc.status).toBe('CLOSED');
  });

  it('NextDNS API outage is recorded as DEGRADED and closes on recovery', async () => {
    gw.failing = true;
    await sweep();
    let inc = (await status()).incidents.find((i: any) => i.type === 'NEXTDNS_API_UNREACHABLE');
    expect(inc.status).toBe('OPEN');
    gw.failing = false;
    traffic();
    await sweep();
    inc = (await status()).incidents.find((i: any) => i.type === 'NEXTDNS_API_UNREACHABLE');
    expect(inc.status).toBe('CLOSED');
  });

  it('AP-authorized window: interruption is still recorded but closes without review', async () => {
    await beat();
    const ex = await request(app)
      .post('/ap/integrity/exemptions')
      .set('authorization', ap)
      .send({ component: 'PRIVATE_DNS', minutes: 30, reason: 'Troubleshooting carrier Wi-Fi calling' });
    expect(ex.status).toBe(201);
    await beat({ ...OK, privateDnsMode: 'off' });
    const notices = (await request(app).get('/participant/notices').set('authorization', p)).body;
    expect(notices.some((n: any) => n.type === 'INTEGRITY')).toBe(false);
    t.advance(20);
    await beat();
    const inc = (await status()).incidents[0];
    expect(inc).toMatchObject({ type: 'PRIVATE_DNS_DISABLED', status: 'CLOSED', exemptionId: ex.body.id });
    expect(inc.restoreDetail).toContain('AP-authorized window');
  });

  it('window expiry before restoration still requires review', async () => {
    await beat();
    await request(app).post('/ap/integrity/exemptions').set('authorization', ap).send({ component: 'PRIVATE_DNS', minutes: 10, reason: 'Quick test' });
    await beat({ ...OK, privateDnsMode: 'off' });
    t.advance(30);
    await beat();
    expect((await status()).incidents[0].status).toBe('AP_REVIEW_REQUIRED');
  });

  it('only the AP grants windows; heartbeat input is validated', async () => {
    expect((await request(app).post('/ap/integrity/exemptions').set('authorization', p).send({ component: 'ALL', minutes: 60, reason: 'x' })).status).toBe(403);
    expect((await beat({ ...OK, privateDnsMode: 'disabled-please' })).status).toBe(400);
    expect((await beat({ ...OK, deviceId: '' })).status).toBe(400);
    expect((await request(app).post('/participant/integrity/heartbeat').set('authorization', ap).send(OK)).status).toBe(403);
  });

  it('a phone that cannot observe Private DNS (offline) does not open an incident', async () => {
    await beat();
    const res = await beat({ ...OK, privateDnsMode: 'unknown', network: 'NONE' });
    expect(res.body.privateDns).toBe('UNKNOWN');
    expect((await status()).incidents).toHaveLength(0);
  });
});
