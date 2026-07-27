/** Participant-facing routes (blueprint §7). PARTICIPANT role required. */
import { Router } from 'express';
import type { DB } from '../db.js';
import { authenticate, requireRole, type AuthedRequest } from '../auth.js';
import { activeConfig, ensureProjectDay, getProject, projectToday, computeDayStatus } from '../engine.js';
import { submitEvidence, submitWeight, submitExternalLink } from '../services/submission.js';
import { acknowledgeViolation } from '../services/review.js';
import { auditFor } from '../audit.js';
import { dayNumber, resolveDeadline, nowIso } from '../time.js';
import type { Clock } from '../time.js';

export function participantRouter(db: DB, clock: Clock): Router {
  const r = Router();
  r.use(authenticate(db), requireRole('PARTICIPANT'));

  function projectFor(req: AuthedRequest): string {
    const row = db.prepare(`SELECT id FROM projects WHERE participantId = ? LIMIT 1`).get(req.user!.id) as
      | { id: string }
      | undefined;
    if (!row) throw new Error('no project for participant');
    return row.id;
  }

  // Today: server-calculated project day + requirement cards (acceptance #1).
  r.get('/today', (req: AuthedRequest, res) => {
    const projectId = projectFor(req);
    const localDate = projectToday(db, projectId, clock);
    const dayId = ensureProjectDay(db, projectId, localDate, clock);
    const { cfg } = activeConfig(db, projectId);
    const day = db.prepare(`SELECT * FROM project_days WHERE id = ?`).get(dayId);
    const requirements = db.prepare(`SELECT * FROM requirement_instances WHERE projectDayId = ?`).all(dayId);
    res.json({
      serverTime: nowIso(clock),
      timeZone: cfg.identity.timeZone,
      localDate,
      dayNumber: dayNumber(cfg.dates.startDate, localDate, cfg.identity.timeZone),
      dayDeadline: resolveDeadline(localDate, '23:59', cfg.identity.timeZone),
      overallStatus: computeDayStatus(db, dayId),
      day,
      requirements,
      recordingTemplate: cfg.recordingTemplate,
    });
  });

  r.get('/history', (req: AuthedRequest, res) => {
    const projectId = projectFor(req);
    res.json(db.prepare(`SELECT * FROM project_days WHERE projectId = ? ORDER BY localDate DESC`).all(projectId));
  });

  r.get('/project-days/:id', (req: AuthedRequest, res) => {
    const day = db.prepare(`SELECT * FROM project_days WHERE id = ?`).get(req.params.id!);
    if (!day) return res.status(404).json({ error: 'not_found' });
    const requirements = db.prepare(`SELECT * FROM requirement_instances WHERE projectDayId = ?`).all(req.params.id!);
    const audit = auditFor(db, 'project_day', req.params.id!);
    res.json({ day, requirements, audit });
  });

  r.get('/notices', (req: AuthedRequest, res) => {
    const projectId = projectFor(req);
    res.json(db.prepare(`SELECT * FROM notices WHERE projectId = ? ORDER BY issuedAt DESC`).all(projectId));
  });

  r.post('/notices/:id/acknowledge', (req: AuthedRequest, res) => {
    db.prepare(`UPDATE notices SET acknowledgedAt = ? WHERE id = ?`).run(nowIso(clock), req.params.id!);
    res.json({ ok: true });
  });

  // Evidence submission — server stamps the trusted receipt time.
  r.post('/evidence', (req: AuthedRequest, res) => {
    try {
      const out = submitEvidence(db, { ...req.body, actorId: req.user!.id }, clock);
      res.status(201).json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/weights', (req: AuthedRequest, res) => {
    try {
      res.status(201).json(submitWeight(db, { ...req.body, actorId: req.user!.id }, clock));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/external-links', (req: AuthedRequest, res) => {
    try {
      res.status(201).json(submitExternalLink(db, { ...req.body, actorId: req.user!.id }, clock));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Acknowledge (not edit) a violation (acceptance #12).
  r.post('/violations/:id/acknowledge', (req: AuthedRequest, res) => {
    try {
      acknowledgeViolation(db, { violationId: req.params.id!, participantId: req.user!.id }, clock);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return r;
}
