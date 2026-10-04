import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import { makeHarness, type Harness } from './helpers.js';
import { createApp } from '../src/app.js';
import { HttpNextDnsGateway, SimulatedNextDnsGateway, nextDnsFromEnv } from '../src/nextdns/gateway.js';
import { normalizeDomain } from '../src/nextdns/model.js';
import { runWebControlSweep } from '../src/services/webControls.js';
import type { Clock } from '../src/time.js';

const START = '2026-10-04T00:42:00Z'; // 8:42 PM ET

function mutableClock(iso: string) {
  let now = DateTime.fromISO(iso, { zone: 'utc' });
  const clock: Clock = { now: () => now };
  return { clock, advance: (minutes: number) => (now = now.plus({ minutes })) };
}

async function token(app: ReturnType<typeof createApp>, email: string) {
  const res = await request(app).post('/auth/login').send({ email, password: 'pw' });
  return `Bearer ${res.body.token}`;
}

describe('NextDNS web controls', () => {
  let h: Harness;
  let gw: SimulatedNextDnsGateway;
  let t: ReturnType<typeof mutableClock>;
  let app: ReturnType<typeof createApp>;
  let ap: string;
  let p: string;

  beforeEach(async () => {
    h = makeHarness();
    t = mutableClock(START);
    gw = new SimulatedNextDnsGateway(() => t.clock.now().toISO()!, false);
    gw.addProfile('abc123'); // RAY-PIXEL
    gw.addProfile('def456'); // HOME-ROUTER
    app = createApp(h.db, t.clock, gw);
    ap = await token(app, 'ap@example.com');
    p = await token(app, 'p@example.com');
    for (const [label, id] of [['RAY-PIXEL', 'abc123'], ['HOME-ROUTER', 'def456']]) {
      const res = await request(app).put(`/ap/web-controls/profiles/${label}`).set('authorization', ap).send({ nextdnsProfileId: id });
      expect(res.status).toBe(200);
    }
  });

  const block = (target: string, displayName: string, extra: object = {}) =>
    request(app).post('/ap/web-controls/block').set('authorization', ap).send({ target, displayName, ...extra });

  it('blocks a domain on both profiles and audits the action', async () => {
    const res = await block('doordash.com', 'DoorDash');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'BLOCK', state: 'ACTIVE', syncStatus: 'IN_SYNC', target: 'doordash.com' });
    expect(gw.rule('abc123', { collection: 'denylist', id: 'doordash.com' })).toBe(true);
    expect(gw.rule('def456', { collection: 'denylist', id: 'doordash.com' })).toBe(true);

    const hist = await request(app).get('/ap/web-controls/history').set('authorization', ap);
    const entry = hist.body.find((e: any) => e.action === 'WEB_CONTROL_BLOCK_ADDED');
    expect(entry).toMatchObject({ actorRole: 'AP', mode: 'MANUAL', target: 'doordash.com', newState: 'BLOCK:ACTIVE' });
    expect(entry.reason).toContain('AP blocked doordash.com');
  });

  it('blocks a NextDNS service id via parental control services', async () => {
    const res = await block('reddit', 'Reddit', { targetType: 'SERVICE', profiles: ['RAY-PIXEL'] });
    expect(res.status).toBe(201);
    expect(gw.rule('abc123', { collection: 'services', id: 'reddit' })).toBe(true);
    expect(gw.rule('def456', { collection: 'services', id: 'reddit' })).toBeUndefined();
  });

  it('rejects malformed targets (no URLs, paths, or injection into API paths)', async () => {
    for (const bad of ['https://reddit.com', 'reddit.com/r/all', '../profiles', 'reddit.com:443', '*.reddit.com', '1.2.3.4', '']) {
      const res = await block(bad, 'x');
      expect(res.status, bad).toBe(400);
    }
    expect(normalizeDomain(' Reddit.COM. ')).toBe('reddit.com');
  });

  it('temporary access: approve → TEMPORARILY ALLOWED → automatic expiry restores the restriction', async () => {
    const c = (await block('reddit.com', 'Reddit')).body;

    const reqRes = await request(app)
      .post('/participant/web-controls/requests')
      .set('authorization', p)
      .send({ controlId: c.id, minutes: 30, reason: 'Looking up a repair thread for the dryer.' });
    expect(reqRes.status).toBe(201);

    const approve = await request(app)
      .post(`/ap/web-controls/requests/${reqRes.body.id}/approve`)
      .set('authorization', ap)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.control.state).toBe('TEMPORARILY_ALLOWED');
    expect(approve.body.grant.expiresAt).toBe('2026-10-04T01:12:00.000Z'); // 9:12 PM ET
    expect(gw.rule('abc123', { collection: 'denylist', id: 'reddit.com' })).toBe(false);

    // Participant sees the expiry.
    const view = await request(app).get('/participant/web-controls').set('authorization', p);
    expect(view.body.restrictions[0]).toMatchObject({ state: 'TEMPORARILY_ALLOWED', expiresAt: '2026-10-04T01:12:00.000Z' });

    t.advance(29);
    expect((await runWebControlSweep(h.db, gw, t.clock)).expired).toBe(0);
    t.advance(1);
    expect((await runWebControlSweep(h.db, gw, t.clock)).expired).toBe(1);
    expect(gw.rule('abc123', { collection: 'denylist', id: 'reddit.com' })).toBe(true);
    expect(gw.rule('def456', { collection: 'denylist', id: 'reddit.com' })).toBe(true);

    const hist = (await request(app).get('/ap/web-controls/history').set('authorization', ap)).body;
    const restored = hist.find((e: any) => e.action === 'RESTRICTION_RESTORED');
    expect(restored).toMatchObject({ actorRole: 'SYSTEM', mode: 'AUTOMATIC' });
    expect(restored.reason).toBe('Temporary access expired. Reddit restriction restored.');
    expect(hist.find((e: any) => e.action === 'TEMP_ACCESS_GRANTED').reason).toBe('AP granted Reddit access for 30 minutes. Expires 9:12 PM EDT.');
  });

  it('approve with a different duration, and deny', async () => {
    const c = (await block('reddit.com', 'Reddit')).body;
    const r1 = await request(app).post('/participant/web-controls/requests').set('authorization', p).send({ controlId: c.id, minutes: 60, reason: 'r' });
    const ok = await request(app).post(`/ap/web-controls/requests/${r1.body.id}/approve`).set('authorization', ap).send({ minutes: 15 });
    expect(ok.body.grant.durationMinutes).toBe(15);

    const c2 = (await block('doordash.com', 'DoorDash')).body;
    const r2 = await request(app).post('/participant/web-controls/requests').set('authorization', p).send({ controlId: c2.id, minutes: 30, reason: 'hungry' });
    const deny = await request(app).post(`/ap/web-controls/requests/${r2.body.id}/deny`).set('authorization', ap).send({ note: 'Cook at home.' });
    expect(deny.status).toBe(200);
    expect(gw.rule('abc123', { collection: 'denylist', id: 'doordash.com' })).toBe(true);
    const again = await request(app).post(`/ap/web-controls/requests/${r2.body.id}/approve`).set('authorization', ap).send({});
    expect(again.status).toBe(409);
  });

  it('participant cannot administer web controls or self-grant access', async () => {
    const c = (await block('reddit.com', 'Reddit')).body;
    for (const [path, body] of [
      ['/ap/web-controls/block', { target: 'x.com' }],
      [`/ap/web-controls/controls/${c.id}/grant`, { minutes: 30 }],
      [`/ap/web-controls/controls/${c.id}/remove`, { reason: 'no' }],
      ['/ap/web-controls/profiles/RAY-PIXEL', { nextdnsProfileId: 'zzz999' }],
    ] as const) {
      const res = await request(app).post(path).set('authorization', p).send(body);
      expect(res.status, path).toBe(403);
    }
    const put = await request(app).put('/ap/web-controls/profiles/RAY-PIXEL').set('authorization', p).send({ nextdnsProfileId: 'zzz999' });
    expect(put.status).toBe(403);
    expect(gw.rule('abc123', { collection: 'denylist', id: 'reddit.com' })).toBe(true);
  });

  it('a failed restore is never silently dropped: SYNC_FAILED, retried, and recovered', async () => {
    const c = (await block('reddit.com', 'Reddit')).body;
    await request(app).post(`/ap/web-controls/controls/${c.id}/grant`).set('authorization', ap).send({ minutes: 10 });
    t.advance(10);
    gw.failing = true;
    await runWebControlSweep(h.db, gw, t.clock);
    let list = (await request(app).get('/ap/web-controls').set('authorization', ap)).body;
    expect(list.controls[0]).toMatchObject({ state: 'ACTIVE', syncStatus: 'SYNC_FAILED' }); // policy says restricted
    const integrity = (await request(app).get('/ap/web-controls/integrity').set('authorization', ap)).body;
    expect(integrity.overall).not.toBe('ACTIVE');

    // Repeated failures audit once, not once per retry.
    await runWebControlSweep(h.db, gw, t.clock);
    let hist = (await request(app).get('/ap/web-controls/history').set('authorization', ap)).body;
    expect(hist.filter((e: any) => e.action === 'NEXTDNS_SYNC_FAILED')).toHaveLength(1);

    gw.failing = false;
    await runWebControlSweep(h.db, gw, t.clock);
    list = (await request(app).get('/ap/web-controls').set('authorization', ap)).body;
    expect(list.controls[0].syncStatus).toBe('IN_SYNC');
    expect(gw.rule('abc123', { collection: 'denylist', id: 'reddit.com' })).toBe(true);
    hist = (await request(app).get('/ap/web-controls/history').set('authorization', ap)).body;
    expect(hist.some((e: any) => e.action === 'NEXTDNS_SYNC_RECOVERED')).toBe(true);
  });

  it('AP can end temporary access early; removal requires a reason', async () => {
    const c = (await block('reddit.com', 'Reddit')).body;
    await request(app).post(`/ap/web-controls/controls/${c.id}/grant`).set('authorization', ap).send({ minutes: 60 });
    const restore = await request(app).post(`/ap/web-controls/controls/${c.id}/restore`).set('authorization', ap).send({});
    expect(restore.body.control.state).toBe('ACTIVE');
    expect(gw.rule('abc123', { collection: 'denylist', id: 'reddit.com' })).toBe(true);

    expect((await request(app).post(`/ap/web-controls/controls/${c.id}/remove`).set('authorization', ap).send({})).status).toBe(400);
    const rm = await request(app).post(`/ap/web-controls/controls/${c.id}/remove`).set('authorization', ap).send({ reason: 'Goal met' });
    expect(rm.body.state).toBe('REMOVED');
    expect(gw.rule('abc123', { collection: 'denylist', id: 'reddit.com' })).toBeUndefined();
  });

  it('status separates RAY-PIXEL from HOME-ROUTER and does not overinterpret silence', async () => {
    let s = (await request(app).get('/ap/web-controls/status').set('authorization', ap)).body;
    expect(s.integration).toBe('SIMULATED');
    expect(s.overall).toBe('ACTIVE');
    const pixel = s.profiles.find((x: any) => x.label === 'RAY-PIXEL');
    const home = s.profiles.find((x: any) => x.label === 'HOME-ROUTER');
    expect(pixel.attribution).toBe('PARTICIPANT_DEVICE');
    expect(home.attribution).toBe('SHARED_NETWORK');

    t.advance(120); // nobody queried anything for two hours
    s = (await request(app).get('/ap/web-controls/status').set('authorization', ap)).body;
    expect(s.overall).toBe('DEGRADED');
    expect(s.profiles.every((x: any) => x.status === 'NO_RECENT_ACTIVITY')).toBe(true);
    expect(JSON.stringify(s)).not.toContain('INTERRUPTED');
  });

  it('filtering settings: only permitted keys, audited with before/after', async () => {
    const bad = await request(app).patch('/ap/web-controls/profiles/RAY-PIXEL/filtering').set('authorization', ap).send({ settings: { logsRetention: 1 } });
    expect(bad.status).toBe(400);
    const ok = await request(app).patch('/ap/web-controls/profiles/RAY-PIXEL/filtering').set('authorization', ap).send({ settings: { blockBypass: true } });
    expect(ok.body.blockBypass).toBe(true);
    const hist = (await request(app).get('/ap/web-controls/history').set('authorization', ap)).body;
    const e = hist.find((x: any) => x.action === 'FILTERING_SETTINGS_CHANGED');
    expect(JSON.parse(e.previousState).blockBypass).toBe(false);
    expect(JSON.parse(e.newState).blockBypass).toBe(true);
  });

  it('audit trail is append-only at the database layer', () => {
    expect(() => h.db.prepare(`UPDATE audit_events SET reason = 'rewritten'`).run()).toThrow(/append-only/);
    expect(() => h.db.prepare(`DELETE FROM audit_events`).run()).toThrow(/append-only/);
  });

  it('never exposes the API key and refuses writes when NextDNS is not configured', async () => {
    const unconfigured = createApp(h.db, t.clock, null);
    const res = await request(unconfigured).post('/ap/web-controls/block').set('authorization', ap).send({ target: 'x.com' });
    expect(res.status).toBe(503);
    const s = await request(unconfigured).get('/ap/web-controls/status').set('authorization', ap);
    expect(s.body.integration).toBe('NOT_CONFIGURED');

    const secret = 'sk-super-secret-nextdns-key';
    const live = nextDnsFromEnv({ NEXTDNS_API_KEY: secret });
    expect(live).toBeInstanceOf(HttpNextDnsGateway);
    expect(JSON.stringify(live)).not.toContain(secret);
    const failingFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const g = new HttpNextDnsGateway(secret, failingFetch);
    await expect(g.getProfile('abc123')).rejects.toThrow(/HTTP 401/);
    await g.getProfile('abc123').catch((e) => expect(String(e.message)).not.toContain(secret));
  });

  it('HTTP gateway sends the key only in the X-Api-Key header and upserts via PATCH then POST', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, ...init });
      if (init.method === 'PATCH') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    };
    const g = new HttpNextDnsGateway('k', fakeFetch);
    await g.upsertRule('abc123', { collection: 'denylist', id: 'reddit.com' }, true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PATCH https://api.nextdns.io/profiles/abc123/denylist/reddit.com',
      'POST https://api.nextdns.io/profiles/abc123/denylist',
    ]);
    expect(calls[0]!.headers['X-Api-Key']).toBe('k');
    expect(calls[0]!.url).not.toContain('k=');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ id: 'reddit.com', active: true });
  });
});
