import { beforeEach, describe, expect, it } from 'vitest';
import { resetJwksCache, verifyAccessJwt } from '../src/auth.js';
import { handleApi } from '../src/routes.js';
import * as ops from '../src/operations.js';
import { setSetting } from '../src/settings.js';
import * as controls from '../src/controls.js';
import { AP, HOME, PIXEL, setup } from './helpers.js';
import { API_KEY } from './fakeNextDns.js';

const TEAM = 'mrb-ap.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

beforeEach(async () => {
  resetJwksCache();
  keyPair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: 'k1' };
});

async function jwt(claims: Record<string, unknown>, nowMs: number, signWith = keyPair.privateKey) {
  const h = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const p = enc({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(nowMs / 1000) + 3600, iat: Math.floor(nowMs / 1000), ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signWith, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}

function harness() {
  const env = setup({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
  const fetchFn = (async (i: string | URL | Request, init?: RequestInit) => {
    const url = String(i);
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return env.fetchFn(url, init);
  }) as typeof fetch;
  const call = async (method: string, path: string, opts: { as?: string; body?: unknown; headers?: Record<string, string>; token?: string } = {}) => {
    const now = env.clock.now().getTime();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.as) headers['Cf-Access-Jwt-Assertion'] = await jwt({ email: opts.as }, now);
    if (opts.token) headers['Cf-Access-Jwt-Assertion'] = opts.token;
    if (opts.body !== undefined) headers['Content-Type'] ??= 'application/json';
    const req = new Request(`https://ap.example.test${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const res = await handleApi(req, env.ctx, fetchFn);
    return { status: res.status, body: (await res.json()) as any, text: '' };
  };
  return { ...env, call };
}

const APE = 'ap@example.test';
const PE = 'participant@example.test';

describe('authentication (Cloudflare Access JWT)', () => {
  it('accepts a valid token and maps the role from AP-controlled config', async () => {
    const h = harness();
    expect((await h.call('GET', '/api/me', { as: APE })).body).toEqual({ email: APE, role: 'AP' });
    expect((await h.call('GET', '/api/me', { as: PE })).body).toEqual({ email: PE, role: 'PARTICIPANT' });
  });

  it('rejects missing, forged, expired, wrong-audience, and unknown identities', async () => {
    const h = harness();
    const now = h.clock.now().getTime();
    expect((await h.call('GET', '/api/me')).status).toBe(401);
    const other = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    expect((await h.call('GET', '/api/me', { token: await jwt({ email: APE }, now, other.privateKey) })).status).toBe(401);
    expect((await h.call('GET', '/api/me', { token: await jwt({ email: APE, exp: Math.floor(now / 1000) - 600 }, now) })).status).toBe(401);
    expect((await h.call('GET', '/api/me', { token: await jwt({ email: APE, aud: ['other'] }, now) })).status).toBe(401);
    expect((await h.call('GET', '/api/me', { as: 'stranger@example.test' })).status).toBe(403);
  });

  it('refuses an identity listed as both AP and participant', async () => {
    const h = harness();
    h.env.PARTICIPANT_EMAILS = `${PE},${APE}`;
    expect((await h.call('GET', '/api/me', { as: APE })).body.error).toBe('role_conflict');
  });

  it('dev auth refuses to run outside development on localhost', async () => {
    const h = setup({ AUTH_MODE: 'dev', ENVIRONMENT: 'production' });
    const res = await handleApi(new Request('https://ap.example.test/api/me', { headers: { 'X-Dev-User': APE } }), h.ctx);
    expect(res.status).toBe(500);
    const local = setup({ AUTH_MODE: 'dev', ENVIRONMENT: 'development' });
    const ok = await handleApi(new Request('http://localhost:8787/api/me', { headers: { 'X-Dev-User': APE } }), local.ctx);
    expect(await ok.json()).toEqual({ email: APE, role: 'AP' });
  });

  it('verifyAccessJwt checks the issuer', async () => {
    const now = Date.now();
    const token = await jwt({ email: APE, iss: 'https://evil.cloudflareaccess.com' }, now);
    const fetchFn = (async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch;
    await expect(verifyAccessJwt(token, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, now, fetchFn)).rejects.toMatchObject({ status: 401 });
  });
});

describe('authorization boundaries', () => {
  it('the participant cannot use any AP operation', async () => {
    const h = harness();
    const c = await ops.blockDomain(h.ctx, AP, { domain: 'reddit.com', label: 'Reddit' });
    for (const [m, p, b] of [
      ['POST', '/api/ap/controls/block', { domain: 'x.com' }],
      ['POST', `/api/ap/controls/${c.control.id}/allow`, {}],
      ['POST', `/api/ap/controls/${c.control.id}/grant`, { minutes: 30 }],
      ['GET', '/api/ap/activity?profile=RAY-PIXEL', undefined],
      ['PUT', '/api/ap/settings/visibility', { mode: 'ALL_DOMAINS', reason: 'x' }],
      ['POST', '/api/ap/devices', { label: 'fake' }],
      ['POST', '/api/ap/sync', {}],
    ] as const) {
      expect((await h.call(m, p, { as: PE, body: b })).status, `${m} ${p}`).toBe(403);
    }
    expect(h.nextdns.deny(PIXEL, 'reddit.com')).toBe(true);
  });

  it('the AP cannot file access requests as the participant', async () => {
    const h = harness();
    const c = await ops.blockDomain(h.ctx, AP, { domain: 'reddit.com' });
    expect((await h.call('POST', '/api/requests', { as: APE, body: { controlId: c.control.id, minutes: 5, reason: 'abc' } })).status).toBe(403);
  });

  it('there is no generic NextDNS passthrough', async () => {
    const h = harness();
    for (const p of ['/api/ap/nextdns/profiles', '/api/nextdns/profiles/pix123', '/api/ap/proxy?path=/profiles'])
      expect((await h.call('GET', p, { as: APE })).status).toBe(404);
  });

  it('mutations require JSON and same origin (CSRF)', async () => {
    const h = harness();
    expect((await h.call('POST', '/api/ap/controls/block', { as: APE, body: { domain: 'x.com' }, headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await h.call('POST', '/api/ap/controls/block', { as: APE, body: { domain: 'x.com' }, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('the NextDNS key never appears in any response and is only sent to api.nextdns.io', async () => {
    const h = harness();
    const c = (await h.call('POST', '/api/ap/controls/block', { as: APE, body: { domain: 'reddit.com', label: 'Reddit' } })).body;
    const outputs = [
      c,
      (await h.call('GET', '/api/status', { as: APE })).body,
      (await h.call('GET', '/api/ap/settings', { as: APE })).body,
      (await h.call('GET', '/api/integrity', { as: APE })).body,
      (await h.call('GET', '/api/audit', { as: APE })).body,
      (await h.call('POST', '/api/ap/sync', { as: APE, body: {} })).body,
    ];
    for (const o of outputs) expect(JSON.stringify(o)).not.toContain(API_KEY);
    for (const call of h.nextdns.calls) expect(new URL(call.url).hostname).toBe('api.nextdns.io');
  });
});

describe('end-to-end over HTTP: request → approve → expire', () => {
  it('runs the full temporary-access loop', async () => {
    const h = harness();
    const ctl = (await h.call('POST', '/api/ap/controls/block', { as: APE, body: { domain: 'reddit.com', label: 'Reddit' } })).body;
    expect(ctl.applied).toBe(true);
    const req = (await h.call('POST', '/api/requests', { as: PE, body: { controlId: ctl.control.id, minutes: 30, reason: 'Vendor research' } })).body;
    expect(req.status).toBe('PENDING');
    const dec = (await h.call('POST', `/api/ap/requests/${req.id}/decision`, { as: APE, body: { decision: 'APPROVE' } })).body;
    expect(dec.grant.status).toBe('ACTIVE');
    const list = (await h.call('GET', '/api/controls', { as: PE })).body;
    expect(list[0]).toMatchObject({ label: 'Reddit', state: 'TEMPORARILY_ALLOWED' });
    expect(h.nextdns.deny(PIXEL, 'reddit.com')).toBe(false);
  });
});

describe('Phase 4 — activity visibility', () => {
  async function withLogs() {
    const h = harness();
    await ops.blockDomain(h.ctx, AP, { domain: 'doordash.com', label: 'DoorDash' });
    await controls.addMonitoredDomain(h.ctx, AP, { domain: 'ubereats.com', label: 'Uber Eats' });
    const t = h.clock.now().toISOString();
    h.nextdns.p(PIXEL).logs.push(
      { timestamp: t, domain: 'api.doordash.com', status: 'blocked', clientIp: '203.0.113.9', device: { name: 'RAY-PIXEL' }, reasons: [{ id: 'denylist', name: 'Denylist' }] },
      { timestamp: t, domain: 'www.ubereats.com', status: 'default', clientIp: '203.0.113.9' },
      { timestamp: t, domain: 'wellsfargo.com', status: 'default', clientIp: '203.0.113.9' },
    );
    h.nextdns.p(HOME).logs.push({ timestamp: t, domain: 'netflix.com', status: 'default' });
    return h;
  }

  it('defaults to BLOCKED EVENTS ONLY and strips client IPs', async () => {
    const h = await withLogs();
    const page = (await h.call('GET', '/api/ap/activity?profile=RAY-PIXEL', { as: APE })).body;
    expect(page.visibilityMode).toBe('BLOCKED_EVENTS_ONLY');
    expect(page.events.map((e: { domain: string }) => e.domain)).toEqual(['api.doordash.com']);
    expect(page.events[0].signal).toBe('BLOCKED_ATTEMPT');
    expect(JSON.stringify(page)).not.toContain('203.0.113.9');
    expect(page.interpretation).toMatch(/not proof of deliberate use/);
    // NextDNS was asked for blocked events only — the rest never entered the Worker.
    expect(h.nextdns.calls.at(-1)!.url).toContain('status=blocked');
  });

  it('MONITORED_DOMAINS adds monitored/controlled lookups but not unrelated ones', async () => {
    const h = await withLogs();
    await setSetting(h.ctx, AP, 'visibilityMode', 'MONITORED_DOMAINS', 'Agreed at weekly review');
    const page = (await h.call('GET', '/api/ap/activity?profile=RAY-PIXEL', { as: APE })).body;
    expect(page.events.map((e: { domain: string }) => e.domain).sort()).toEqual(['api.doordash.com', 'www.ubereats.com']);
    expect(page.events.find((e: { domain: string }) => e.domain === 'www.ubereats.com').matched).toBe('Uber Eats');
  });

  it('ALL_DOMAINS returns everything; the mode change itself is audited', async () => {
    const h = await withLogs();
    await h.call('PUT', '/api/ap/settings/visibility', { as: APE, body: { mode: 'ALL_DOMAINS', reason: 'Participant consented in writing' } });
    const page = (await h.call('GET', '/api/ap/activity?profile=RAY-PIXEL', { as: APE })).body;
    expect(page.events).toHaveLength(3);
    const audits = h.auditRows();
    const change = audits.find((a) => a.action === 'settings.visibilityMode.changed')!;
    expect(JSON.parse(change.previousState!)).toBe('BLOCKED_EVENTS_ONLY');
    expect(audits.at(-1)!.action).toBe('activity.viewed');
  });

  it('labels home-network activity as not attributable to the participant', async () => {
    const h = await withLogs();
    await setSetting(h.ctx, AP, 'visibilityMode', 'ALL_DOMAINS', 'x');
    const page = (await h.call('GET', '/api/ap/activity?profile=HOME-ROUTER', { as: APE })).body;
    expect(page.heading).toBe('HOME NETWORK ACTIVITY');
    expect(page.attribution).toMatch(/Not attributed to Micheal personally/);
    expect(page.events.map((e: { domain: string }) => e.domain)).toEqual(['netflix.com']);
  });

  it('the participant cannot read DNS activity', async () => {
    const h = await withLogs();
    expect((await h.call('GET', '/api/ap/activity?profile=RAY-PIXEL', { as: PE })).status).toBe(403);
  });
});

describe('device endpoints', () => {
  it('challenge + heartbeat with a device token; person credentials are not accepted', async () => {
    const h = harness();
    const dev = (await h.call('POST', '/api/ap/devices', { as: APE, body: { label: 'Ray Pixel' } })).body;
    expect(dev.token).toMatch(/^mrbd_/);
    const devCall = (path: string, body: unknown, token = dev.token) =>
      handleApi(
        new Request(`https://ap.example.test${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        h.ctx,
      );
    const ch = (await (await devCall("/api/device/challenge", {})).json()) as { nonce: string };
    const hb = await devCall('/api/device/heartbeat', { network: 'WIFI', privateDnsActive: true, canaryNonce: ch.nonce });
    expect(hb.status).toBe(200);
    expect((await devCall('/api/device/heartbeat', { network: 'WIFI' }, 'mrbd_nope')).status).toBe(401);
    // Device tokens cannot reach person routes.
    const res = await handleApi(new Request('https://ap.example.test/api/me', { headers: { Authorization: `Bearer ${dev.token}` } }), h.ctx);
    expect(res.status).toBe(401);
  });
});
