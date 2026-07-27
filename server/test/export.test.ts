import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeHarness } from './helpers.js';
import { buildExport, toCsv } from '../src/services/exporter.js';

describe('official-record export (acceptance #21)', () => {
  it('carries generation metadata and the config version', () => {
    const h = makeHarness();
    const out = buildExport(h.db, h.projectId, 'official-record', h.clock);
    expect(out.meta.generatedAt).toBeTruthy();
    expect(out.meta.configurationVersion).toBe(1);
    expect(out.meta.exportType).toBe('official-record');
  });

  it('CSV export escapes commas and quotes', () => {
    const csv = toCsv([{ a: 'x,y', b: 'he said "hi"' }]);
    expect(csv.split('\n')[0]).toBe('a,b');
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"he said ""hi"""');
  });

  it('is reachable by the AP over HTTP as CSV', async () => {
    const h = makeHarness();
    const ap = await request(h.app).post('/auth/login').send({ email: 'ap@example.com', password: 'pw' });
    const res = await request(h.app)
      .get(`/ap/export?projectId=${h.projectId}&type=compliance&format=csv`)
      .set('authorization', `Bearer ${ap.body.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  it('is not reachable by the participant', async () => {
    const h = makeHarness();
    const p = await request(h.app).post('/auth/login').send({ email: 'p@example.com', password: 'pw' });
    const res = await request(h.app)
      .get(`/ap/export?projectId=${h.projectId}&type=audit`)
      .set('authorization', `Bearer ${p.body.token}`);
    expect(res.status).toBe(403);
  });
});
