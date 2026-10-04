/**
 * Monitoring-integrity routes (Phase 5).
 *
 *   Participant /participant/integrity/*  heartbeat, own status, explanations
 *   AP          /ap/integrity/*           dashboard, review, authorized windows
 */
import { Router } from 'express';
import type { DB } from '../db.js';
import { authenticate, requireRole, type AuthedRequest } from '../auth.js';
import type { Clock } from '../time.js';
import type { NextDnsGateway } from '../nextdns/gateway.js';
import { WebControlError, resolveProjectId } from '../services/webControls.js';
import {
  explainIncident,
  getIntegrityStatus,
  getParticipantIntegrity,
  grantExemption,
  listIncidents,
  recordHeartbeat,
  revokeExemption,
  reviewIncident,
  runIntegritySweep,
} from '../services/integrity.js';
import { wrap } from './webControls.js';

export function participantIntegrityRouter(db: DB, clock: Clock): Router {
  const r = Router();
  r.use(authenticate(db), requireRole('PARTICIPANT'));
  const projectFor = (req: AuthedRequest): string => {
    const row = db.prepare(`SELECT id FROM projects WHERE participantId = ? LIMIT 1`).get(req.user!.id) as
      | { id: string }
      | undefined;
    if (!row) throw new WebControlError('project_not_found', 404);
    return row.id;
  };

  r.post(
    '/heartbeat',
    wrap((req) => recordHeartbeat(db, { projectId: projectFor(req), participantId: req.user!.id, body: req.body }, clock)),
  );
  r.get('/', wrap((req) => getParticipantIntegrity(db, projectFor(req), clock)));
  r.post(
    '/incidents/:id/explanation',
    wrap((req) =>
      explainIncident(
        db,
        { incidentId: req.params.id!, projectId: projectFor(req), participantId: req.user!.id, explanation: req.body?.explanation },
        clock,
      ),
    ),
  );
  return r;
}

export function apIntegrityRouter(db: DB, clock: Clock, gw: NextDnsGateway | null): Router {
  const r = Router();
  r.use(authenticate(db), requireRole('AP'));
  const pid = (req: AuthedRequest) => resolveProjectId(db, req.query.projectId ?? req.body?.projectId);

  r.get('/', wrap(async (req) => getIntegrityStatus(db, gw, pid(req), clock)));
  r.get('/incidents', wrap((req) => listIncidents(db, pid(req), clock, Number(req.query.limit ?? 100))));
  r.post(
    '/incidents/:id/review',
    wrap((req) =>
      reviewIncident(db, { incidentId: req.params.id!, apId: req.user!.id, determination: req.body?.determination, note: req.body?.note }, clock),
    ),
  );
  r.post(
    '/exemptions',
    wrap((req, res) =>
      res.status(201).json(
        grantExemption(
          db,
          { projectId: pid(req), apId: req.user!.id, component: req.body?.component, minutes: req.body?.minutes, reason: req.body?.reason },
          clock,
        ),
      ),
    ),
  );
  r.post(
    '/exemptions/:id/revoke',
    wrap((req) => {
      revokeExemption(db, { exemptionId: req.params.id!, apId: req.user!.id }, clock);
      return { ok: true };
    }),
  );
  r.post('/sweep', wrap(async () => runIntegritySweep(db, gw, clock, { forceNextDnsCheck: true })));
  return r;
}
