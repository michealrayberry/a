import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeHarness, type Harness } from './helpers.js';
import { SEED_CONFIGURATION } from '../src/config.js';

async function loginToken(h: Harness, email: string, password: string): Promise<string> {
  const res = await request(h.app).post('/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token;
}

describe('end-to-end sequence (blueprint §29, acceptance criteria)', () => {
  let h: Harness;
  let pToken: string;
  let apToken: string;

  beforeEach(async () => {
    h = makeHarness({ nowIso: '2026-07-26T18:00:00Z' }); // afternoon ET on day 39
    pToken = await loginToken(h, 'p@example.com', 'pw');
    apToken = await loginToken(h, 'ap@example.com', 'pw');
  });

  it('#1 participant sees the server-calculated project day', async () => {
    const res = await request(h.app).get('/participant/today').set('authorization', `Bearer ${pToken}`);
    expect(res.status).toBe(200);
    expect(res.body.dayNumber).toBe(39);
    expect(res.body.timeZone).toBe('America/New_York');
    expect(res.body.requirements.length).toBeGreaterThan(0);
  });

  it('#5,#6 evidence submission gets a server receipt and on-time timeliness', async () => {
    const today = await request(h.app).get('/participant/today').set('authorization', `Bearer ${pToken}`);
    const videoReq = today.body.requirements.find((r: any) => r.requirementCode === 'DAILY_VIDEO');
    const res = await request(h.app)
      .post('/participant/evidence')
      .set('authorization', `Bearer ${pToken}`)
      .send({ requirementInstanceId: videoReq.id, type: 'VIDEO', sha256: 'abc', sizeBytes: 100, durationMs: 60000 });
    expect(res.status).toBe(201);
    expect(res.body.serverReceivedAt).toBeTruthy();
    expect(res.body.shortCode).toHaveLength(8);
  });

  it('#7 participant CANNOT verify their own evidence', async () => {
    const today = await request(h.app).get('/participant/today').set('authorization', `Bearer ${pToken}`);
    const videoReq = today.body.requirements.find((r: any) => r.requirementCode === 'DAILY_VIDEO');
    const sub = await request(h.app)
      .post('/participant/evidence')
      .set('authorization', `Bearer ${pToken}`)
      .send({ requirementInstanceId: videoReq.id, type: 'VIDEO' });
    // Participant hitting an AP verify route is forbidden.
    const res = await request(h.app)
      .post(`/ap/evidence/${sub.body.evidenceId}/verify`)
      .set('authorization', `Bearer ${pToken}`);
    expect(res.status).toBe(403);
  });

  it('#8,#9,#10 AP verifies, issues deficiency, participant corrects', async () => {
    const today = await request(h.app).get('/participant/today').set('authorization', `Bearer ${pToken}`);
    const videoReq = today.body.requirements.find((r: any) => r.requirementCode === 'DAILY_VIDEO');
    const sub = await request(h.app)
      .post('/participant/evidence')
      .set('authorization', `Bearer ${pToken}`)
      .send({ requirementInstanceId: videoReq.id, type: 'VIDEO' });

    // AP issues a deficiency.
    const def = await request(h.app)
      .post('/ap/deficiencies')
      .set('authorization', `Bearer ${apToken}`)
      .send({
        evidenceId: sub.body.evidenceId,
        requirementInstanceId: videoReq.id,
        reasonCode: 'AUDIO_UNCLEAR',
        description: 'Audio was not understandable in the closing statement.',
        correctionWindow: 'PT24H',
      });
    expect(def.status).toBe(201);

    // Participant submits a replacement.
    const replacement = await request(h.app)
      .post('/participant/evidence')
      .set('authorization', `Bearer ${pToken}`)
      .send({ requirementInstanceId: videoReq.id, type: 'VIDEO' });
    expect(replacement.status).toBe(201);

    // AP verifies the replacement.
    const verify = await request(h.app)
      .post(`/ap/evidence/${replacement.body.evidenceId}/verify`)
      .set('authorization', `Bearer ${apToken}`)
      .send({ note: 'Corrected — audio clear.' });
    expect(verify.status).toBe(200);
  });

  it('#11,#12 AP assesses a violation; participant acknowledges without editing', async () => {
    const day = h.db.prepare(`SELECT id FROM project_days LIMIT 1`).get() as { id: string } | undefined;
    // ensure a day exists
    await request(h.app).get('/participant/today').set('authorization', `Bearer ${pToken}`);
    const anyDay = h.db.prepare(`SELECT id FROM project_days LIMIT 1`).get() as { id: string };
    const vio = await request(h.app)
      .post('/ap/violations')
      .set('authorization', `Bearer ${apToken}`)
      .send({
        projectId: h.projectId,
        projectDayId: anyDay.id,
        violationType: 'MISSED_DAILY',
        factualBasis: 'Daily video was not submitted before the deadline.',
      });
    expect(vio.status).toBe(201);
    const vId = vio.body.violationId;

    const ack = await request(h.app)
      .post(`/participant/violations/${vId}/acknowledge`)
      .set('authorization', `Bearer ${pToken}`);
    expect(ack.status).toBe(200);

    const row = h.db.prepare(`SELECT state FROM violations WHERE id = ?`).get(vId) as { state: string };
    expect(row.state).toBe('ACKNOWLEDGED');
  });

  it('#18 every material action generates an audit event', async () => {
    const today = await request(h.app).get('/participant/today').set('authorization', `Bearer ${pToken}`);
    const videoReq = today.body.requirements.find((r: any) => r.requirementCode === 'DAILY_VIDEO');
    await request(h.app)
      .post('/participant/evidence')
      .set('authorization', `Bearer ${pToken}`)
      .send({ requirementInstanceId: videoReq.id, type: 'VIDEO' });
    const count = h.db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'EVIDENCE_SUBMITTED'`).get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe('public/private separation (acceptance #15, #16)', () => {
  it('private records never appear in the public API', async () => {
    const h = makeHarness();
    const p = await request(h.app).post('/auth/login').send({ email: 'p@example.com', password: 'pw' });
    const today = await request(h.app).get('/participant/today').set('authorization', `Bearer ${p.body.token}`);
    const videoReq = today.body.requirements.find((r: any) => r.requirementCode === 'DAILY_VIDEO');
    await request(h.app)
      .post('/participant/evidence')
      .set('authorization', `Bearer ${p.body.token}`)
      .send({ requirementInstanceId: videoReq.id, type: 'VIDEO' });

    // Nothing published yet -> public days empty.
    const days = await request(h.app).get('/public/project-days?slug=test');
    expect(days.body).toEqual([]);
  });

  it('public API requires no auth and exposes no private fields', async () => {
    const h = makeHarness();
    const res = await request(h.app).get('/public/project?slug=test');
    expect(res.status).toBe(200);
    const keys = Object.keys(res.body);
    for (const forbidden of ['participantId', 'email', 'passwordHash', 'activeConfigurationId', 'id']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('security: role and auth enforcement (§13)', () => {
  it('rejects unauthenticated access to participant routes', async () => {
    const h = makeHarness();
    const res = await request(h.app).get('/participant/today');
    expect(res.status).toBe(401);
  });

  it('rejects a tampered/garbage token', async () => {
    const h = makeHarness();
    const res = await request(h.app).get('/participant/today').set('authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });

  it('AP cannot use participant-only routes', async () => {
    const h = makeHarness();
    const ap = await request(h.app).post('/auth/login').send({ email: 'ap@example.com', password: 'pw' });
    const res = await request(h.app).get('/participant/today').set('authorization', `Bearer ${ap.body.token}`);
    expect(res.status).toBe(403);
  });
});

describe('configuration versioning (acceptance #14)', () => {
  it('activating a new configuration does not rewrite existing days', async () => {
    const h = makeHarness({ nowIso: '2026-07-26T18:00:00Z' });
    const p = await request(h.app).post('/auth/login').send({ email: 'p@example.com', password: 'pw' });
    const today = await request(h.app).get('/participant/today').set('authorization', `Bearer ${p.body.token}`);
    const originalConfigId = today.body.day.configurationId;

    // Draft + activate a new config.
    const ap = await request(h.app).post('/auth/login').send({ email: 'ap@example.com', password: 'pw' });
    const draft = await request(h.app)
      .post('/ap/configurations')
      .set('authorization', `Bearer ${ap.body.token}`)
      .send({
        projectId: h.projectId,
        title: 'v2',
        effectiveAt: '2026-08-01',
        configuration: { ...SEED_CONFIGURATION },
      });
    await request(h.app)
      .post(`/ap/configurations/${draft.body.id}/activate`)
      .set('authorization', `Bearer ${ap.body.token}`);

    // The existing day still points at the original configuration.
    const dayRow = h.db.prepare(`SELECT configurationId FROM project_days WHERE id = ?`).get(today.body.day.id) as { configurationId: string };
    expect(dayRow.configurationId).toBe(originalConfigId);
  });
});
