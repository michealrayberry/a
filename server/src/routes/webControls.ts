/**
 * Web Controls routes (NextDNS). Each route maps to one named operation; there
 * is intentionally no endpoint that forwards arbitrary NextDNS API paths.
 *
 *   AP          /ap/web-controls/*           (role AP)
 *   Participant /participant/web-controls/*  (role PARTICIPANT: view + request)
 */
import { Router, type Response } from 'express';
import type { DB } from '../db.js';
import { authenticate, requireRole, type AuthedRequest } from '../auth.js';
import type { Clock } from '../time.js';
import type { NextDnsGateway } from '../nextdns/gateway.js';
import { ValidationError } from '../nextdns/model.js';
import {
  WebControlError,
  allowDomain,
  approveAccessRequest,
  bindProfile,
  blockDomain,
  denyAccessRequest,
  getNextDnsStatus,
  getParticipantWebControls,
  getWebControls,
  grantTemporaryAccess,
  monitorDomain,
  removeControl,
  resolveProjectId,
  restoreRestriction,
  runWebControlSweep,
  submitAccessRequest,
  updateFilteringSettings,
  webControlHistory,
  withdrawAccessRequest,
} from '../services/webControls.js';
import { getIntegrityStatus } from '../services/integrity.js';

export function fail(res: Response, e: unknown) {
  if (e instanceof WebControlError) return res.status(e.httpStatus).json({ error: e.message });
  if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
  console.error('web-controls error', e);
  return res.status(500).json({ error: 'internal_error' });
}

type Handler = (req: AuthedRequest, res: Response) => unknown;
export const wrap =
  (fn: Handler) =>
  async (req: AuthedRequest, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (e) {
      fail(res, e);
    }
  };

export function apWebControlsRouter(db: DB, clock: Clock, gw: NextDnsGateway | null): Router {
  const r = Router();
  r.use(authenticate(db), requireRole('AP'));
  const pid = (req: AuthedRequest) => resolveProjectId(db, req.query.projectId ?? req.body?.projectId);
  const ap = (req: AuthedRequest) => req.user!.id;

  r.get('/', wrap((req) => getWebControls(db, pid(req), clock)));
  r.get('/status', wrap(async (req) => getNextDnsStatus(db, gw, pid(req), clock)));
  r.get('/integrity', wrap(async (req) => getIntegrityStatus(db, gw, pid(req), clock)));
  r.get('/history', wrap((req) => webControlHistory(db, pid(req), Number(req.query.limit ?? 200))));

  r.put(
    '/profiles/:label',
    wrap(async (req) =>
      bindProfile(db, gw, { projectId: pid(req), label: req.params.label, nextdnsProfileId: req.body?.nextdnsProfileId, apId: ap(req) }, clock),
    ),
  );
  r.patch(
    '/profiles/:label/filtering',
    wrap(async (req) =>
      updateFilteringSettings(db, gw, { projectId: pid(req), label: req.params.label, settings: req.body?.settings, apId: ap(req) }, clock),
    ),
  );

  const controlInput = (req: AuthedRequest) => ({
    projectId: pid(req),
    targetType: req.body?.targetType,
    target: req.body?.target,
    displayName: req.body?.displayName,
    profiles: req.body?.profiles,
    apId: ap(req),
  });
  r.post('/block', wrap(async (req, res) => res.status(201).json(await blockDomain(db, gw, controlInput(req), clock))));
  r.post('/allow', wrap(async (req, res) => res.status(201).json(await allowDomain(db, gw, controlInput(req), clock))));
  r.post('/monitor', wrap(async (req, res) => res.status(201).json(await monitorDomain(db, controlInput(req), clock))));
  r.post(
    '/controls/:id/remove',
    wrap(async (req) => removeControl(db, gw, { controlId: req.params.id!, apId: ap(req), reason: req.body?.reason }, clock)),
  );
  r.post(
    '/controls/:id/grant',
    wrap(async (req) => grantTemporaryAccess(db, gw, { controlId: req.params.id!, minutes: req.body?.minutes, apId: ap(req) }, clock)),
  );
  r.post(
    '/controls/:id/restore',
    wrap(async (req) => restoreRestriction(db, gw, { controlId: req.params.id!, apId: ap(req), reason: req.body?.reason }, clock)),
  );

  r.post(
    '/requests/:id/approve',
    wrap(async (req) =>
      approveAccessRequest(db, gw, { requestId: req.params.id!, apId: ap(req), minutes: req.body?.minutes, note: req.body?.note }, clock),
    ),
  );
  r.post(
    '/requests/:id/deny',
    wrap((req) => {
      denyAccessRequest(db, { requestId: req.params.id!, apId: ap(req), note: req.body?.note }, clock);
      return { ok: true };
    }),
  );

  // Manual trigger for the expiration/reconcile sweep (also runs on a schedule).
  r.post('/sweep', wrap(async () => runWebControlSweep(db, gw, clock)));

  return r;
}

export function participantWebControlsRouter(db: DB, clock: Clock): Router {
  const r = Router();
  r.use(authenticate(db), requireRole('PARTICIPANT'));
  const projectFor = (req: AuthedRequest): string => {
    const row = db.prepare(`SELECT id FROM projects WHERE participantId = ? LIMIT 1`).get(req.user!.id) as
      | { id: string }
      | undefined;
    if (!row) throw new WebControlError('project_not_found', 404);
    return row.id;
  };

  r.get('/', wrap((req) => getParticipantWebControls(db, projectFor(req), req.user!.id, clock)));
  r.post(
    '/requests',
    wrap((req, res) =>
      res.status(201).json(
        submitAccessRequest(
          db,
          {
            projectId: projectFor(req),
            participantId: req.user!.id,
            controlId: req.body?.controlId,
            minutes: req.body?.minutes,
            reason: req.body?.reason,
          },
          clock,
        ),
      ),
    ),
  );
  r.post(
    '/requests/:id/withdraw',
    wrap((req) => {
      withdrawAccessRequest(db, { requestId: req.params.id!, participantId: req.user!.id }, clock);
      return { ok: true };
    }),
  );
  return r;
}
