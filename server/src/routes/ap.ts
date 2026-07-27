/** Accountability Partner portal routes (blueprint §8). AP role required. */
import { Router } from 'express';
import type { DB } from '../db.js';
import { authenticate, requireRole, type AuthedRequest } from '../auth.js';
import { verifyEvidence, issueDeficiency, assessViolation, setPublicStatus } from '../services/review.js';
import { runDeadlineSweep } from '../engine.js';
import { activateConfiguration, draftConfiguration } from '../services/projects.js';
import { auditFor } from '../audit.js';
import { buildExport, toCsv, type ExportType } from '../services/exporter.js';
import type { Clock } from '../time.js';

export function apRouter(db: DB, clock: Clock): Router {
  const r = Router();
  r.use(authenticate(db), requireRole('AP'));

  // Dashboard counts (blueprint §8.1).
  r.get('/dashboard', (_req, res) => {
    const q = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;
    res.json({
      awaitingReview: q(`SELECT COUNT(*) c FROM evidence WHERE state = 'READY_FOR_REVIEW'`),
      openDeficiencies: q(`SELECT COUNT(*) c FROM deficiencies WHERE status = 'OPEN'`),
      openViolations: q(`SELECT COUNT(*) c FROM violations WHERE state IN ('ASSESSED','OVERDUE','ESCALATED')`),
      lateSubmissions: q(`SELECT COUNT(*) c FROM requirement_instances WHERE status = 'LATE'`),
      missed: q(`SELECT COUNT(*) c FROM requirement_instances WHERE status = 'MISSED'`),
    });
  });

  // Review queue (blueprint §8.2).
  r.get('/review-queue', (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT e.id AS evidenceId, e.type, e.state, e.serverReceivedAt, e.sha256, e.durationMs,
                  ri.id AS requirementInstanceId, ri.name AS requirement, ri.timeliness, ri.deadlineAt,
                  d.localDate, d.projectId
             FROM evidence e
             JOIN requirement_instances ri ON ri.id = e.requirementInstanceId
             JOIN project_days d ON d.id = e.projectDayId
            WHERE e.state IN ('READY_FOR_REVIEW','REPLACEMENT_SUBMITTED')
            ORDER BY ri.deadlineAt ASC`,
        )
        .all(),
    );
  });

  r.get('/evidence/:id', (req, res) => {
    const ev = db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(req.params.id!);
    if (!ev) return res.status(404).json({ error: 'not_found' });
    res.json({ evidence: ev, audit: auditFor(db, 'evidence', req.params.id!) });
  });

  r.post('/evidence/:id/verify', (req: AuthedRequest, res) => {
    try {
      verifyEvidence(db, { evidenceId: req.params.id!, apId: req.user!.id, note: req.body?.note }, clock);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/deficiencies', (req: AuthedRequest, res) => {
    try {
      res.status(201).json(issueDeficiency(db, { ...req.body, apId: req.user!.id }, clock));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/violations', (req: AuthedRequest, res) => {
    try {
      res.status(201).json(assessViolation(db, { ...req.body, apId: req.user!.id }, clock));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/publish', (req: AuthedRequest, res) => {
    try {
      setPublicStatus(db, { ...req.body, apId: req.user!.id }, clock);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Manually trigger the deadline sweep (also runs on a schedule).
  r.post('/deadline-sweep', (req: AuthedRequest, res) => {
    const projectId = String(req.body?.projectId ?? '');
    res.json(runDeadlineSweep(db, projectId, clock));
  });

  // Configuration administration (blueprint §8.7).
  r.post('/configurations', (req: AuthedRequest, res) => {
    try {
      res.status(201).json({ id: draftConfiguration(db, { ...req.body, createdBy: req.user!.id }, clock) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/configurations/:id/activate', (req: AuthedRequest, res) => {
    try {
      activateConfiguration(db, req.params.id!, req.user!.id, clock);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Official-record exports (blueprint §19, acceptance #21).
  r.get('/export', (req, res) => {
    try {
      const projectId = String(req.query.projectId ?? '');
      const type = (String(req.query.type ?? 'official-record')) as ExportType;
      const format = String(req.query.format ?? 'json');
      const out = buildExport(db, projectId, type, clock);
      if (format === 'csv') {
        res.setHeader('content-type', 'text/csv');
        res.setHeader('content-disposition', `attachment; filename="${type}.csv"`);
        return res.send(toCsv(out.rows));
      }
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.get('/audit', (req, res) => {
    const { entityType, entityId } = req.query;
    if (entityType && entityId) return res.json(auditFor(db, String(entityType), String(entityId)));
    res.json(db.prepare(`SELECT * FROM audit_events ORDER BY serverTimestamp DESC LIMIT 500`).all());
  });

  return r;
}
