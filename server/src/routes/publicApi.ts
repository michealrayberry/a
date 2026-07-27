/** Read-only public API (blueprint §5.4). No authentication required. */
import { Router } from 'express';
import type { DB } from '../db.js';
import * as pub from '../services/publicRecord.js';

export function publicRouter(db: DB): Router {
  const r = Router();
  r.get('/project', (req, res) => {
    const data = pub.publicProject(db, String(req.query.slug ?? defaultSlug(db)));
    return data ? res.json(data) : res.status(404).json({ error: 'not_found' });
  });
  r.get('/status', (req, res) => {
    const data = pub.publicStatus(db, String(req.query.slug ?? defaultSlug(db)));
    return data ? res.json(data) : res.status(404).json({ error: 'not_found' });
  });
  r.get('/project-days', (req, res) => res.json(pub.publicProjectDays(db, String(req.query.slug ?? defaultSlug(db)))));
  r.get('/project-days/:date', (req, res) => {
    const data = pub.publicProjectDay(db, String(req.query.slug ?? defaultSlug(db)), req.params.date!);
    return data ? res.json(data) : res.status(404).json({ error: 'not_found' });
  });
  r.get('/weights', (req, res) => res.json(pub.publicWeights(db, String(req.query.slug ?? defaultSlug(db)))));
  r.get('/violations', (req, res) => res.json(pub.publicViolations(db, String(req.query.slug ?? defaultSlug(db)))));
  r.get('/feed', (req, res) => res.json(pub.publicFeed(db, String(req.query.slug ?? defaultSlug(db)))));
  return r;
}

function defaultSlug(db: DB): string {
  const row = db.prepare(`SELECT publicSlug FROM projects ORDER BY createdAt ASC LIMIT 1`).get() as
    | { publicSlug: string }
    | undefined;
  return row?.publicSlug ?? '';
}
