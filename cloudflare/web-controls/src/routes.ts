/**
 * HTTP routes. Every route maps to one named operation with a validated body.
 * There is intentionally no route that forwards arbitrary NextDNS paths.
 */
import { z } from 'zod';
import * as access from './access.js';
import { listAudit } from './audit.js';
import { authenticatePerson, type Principal } from './auth.js';
import { PROFILE_CODES, type Ctx } from './context.js';
import * as controls from './controls.js';
import * as integrity from './integrity.js';
import * as ops from './operations.js';
import { getSettings, MANAGED_CATEGORIES, setSetting, VISIBILITY_MODES } from './settings.js';
import { HttpError } from './util.js';

type Handler = (args: { req: Request; ctx: Ctx; params: Record<string, string>; url: URL; who: Principal }) => Promise<unknown>;
type DeviceHandler = (args: { req: Request; ctx: Ctx; device: integrity.DeviceRow }) => Promise<unknown>;

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  pattern: RegExp;
  keys: string[];
  role: 'ANY' | 'AP' | 'PARTICIPANT';
  handler: Handler;
}

const routes: Route[] = [];
function route(method: Route['method'], path: string, role: Route['role'], handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([A-Za-z0-9_-]+)')) + '$',
  );
  routes.push({ method, pattern, keys, role, handler });
}

async function body<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, 'invalid_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

const profileCode = z.enum(PROFILE_CODES);
const reason = z.string().trim().max(500).optional().nullable();
const minutes = z.number().int().positive();

// ---------------------------------------------------------------------------
// Shared (AP + participant). Participant visibility: controls, own requests,
// integrity, incidents, and the audit trail — never DNS activity.
// ---------------------------------------------------------------------------

route('GET', '/api/me', 'ANY', async ({ who }) => ({ email: who.email, role: who.role }));
route('GET', '/api/status', 'ANY', async ({ ctx }) => ops.getNextDnsStatus(ctx));
route('GET', '/api/controls', 'ANY', async ({ ctx, url }) =>
  controls.listControls(ctx, { includeArchived: url.searchParams.get('archived') === '1' }),
);
route('GET', '/api/requests', 'ANY', async ({ ctx, url }) =>
  access.listRequests(ctx, { status: url.searchParams.get('status') ?? undefined }),
);
route('GET', '/api/integrity', 'ANY', async ({ ctx }) => ops.getIntegrityStatus(ctx));
route('GET', '/api/incidents', 'ANY', async ({ ctx, url }) =>
  integrity.listIncidents(ctx, { status: url.searchParams.get('status') ?? undefined }),
);
route('GET', '/api/audit', 'ANY', async ({ ctx, url }) =>
  listAudit(ctx.db, {
    limit: Number(url.searchParams.get('limit') ?? 200),
    before: url.searchParams.get('before') ?? undefined,
  }),
);

// Participant
route('POST', '/api/requests', 'PARTICIPANT', async ({ req, ctx, who }) => {
  const b = await body(req, z.object({ controlId: z.string(), minutes, reason: z.string() }));
  return access.requestAccess(ctx, who.actor, b);
});
route('POST', '/api/requests/:id/withdraw', 'PARTICIPANT', async ({ ctx, who, params }) =>
  access.withdrawRequest(ctx, who.actor, params.id!),
);

// ---------------------------------------------------------------------------
// AP — WEB CONTROLS
// ---------------------------------------------------------------------------

route('POST', '/api/ap/controls/block', 'AP', async ({ req, ctx, who }) => {
  const b = await body(
    req,
    z.object({
      domain: z.string(),
      label: z.string().max(80).optional(),
      profiles: z.array(profileCode).optional(),
      nextdnsServiceId: z.string().max(63).optional().nullable(),
      note: reason,
    }),
  );
  return ops.blockDomain(ctx, who.actor, b);
});
route('POST', '/api/ap/controls', 'AP', async ({ req, ctx, who }) => {
  const b = await body(
    req,
    z.object({
      label: z.string(),
      domains: z.array(z.string()).max(50),
      nextdnsServiceId: z.string().max(63).optional().nullable(),
      profiles: z.array(profileCode).optional(),
      policy: z.enum(['BLOCKED', 'ALLOWED']).optional(),
      note: reason,
    }),
  );
  const c = await controls.createControl(ctx, who.actor, b);
  return ops.syncControl(ctx, c.id);
});
route('PUT', '/api/ap/controls/:id', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(
    req,
    z.object({
      domains: z.array(z.string()).max(50).optional(),
      profiles: z.array(profileCode).optional(),
      nextdnsServiceId: z.string().max(63).optional().nullable(),
      note: reason,
      reason,
    }),
  );
  await controls.updateControl(ctx, who.actor, params.id!, b, b.reason);
  return ops.syncControl(ctx, params.id!);
});
route('POST', '/api/ap/controls/:id/allow', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ reason }));
  return ops.allowDomain(ctx, who.actor, params.id!, b.reason);
});
route('POST', '/api/ap/controls/:id/block', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ reason }));
  return ops.reblockControl(ctx, who.actor, params.id!, b.reason);
});
route('POST', '/api/ap/controls/:id/archive', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ reason: z.string().trim().min(1).max(500) }));
  await controls.archiveControl(ctx, who.actor, params.id!, b.reason);
  const results = await controls.reconcileProfiles(ctx);
  return { archived: true, errors: results.flatMap((r) => r.errors.map((e) => e.message)) };
});
route('POST', '/api/ap/controls/:id/grant', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ minutes, note: reason }));
  return ops.grantTemporaryAccess(ctx, who.actor, { controlId: params.id!, minutes: b.minutes, note: b.note });
});
route('POST', '/api/ap/controls/:id/restore', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ reason }));
  return ops.restoreRestriction(ctx, who.actor, { controlId: params.id!, reason: b.reason });
});
route('POST', '/api/ap/controls/:id/sync', 'AP', async ({ ctx, params }) => ops.syncControl(ctx, params.id!));

route('POST', '/api/ap/requests/:id/decision', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(
    req,
    z.object({ decision: z.enum(['APPROVE', 'DENY']), minutes: minutes.optional(), note: reason }),
  );
  return access.decideRequest(ctx, who.actor, params.id!, b);
});
route('GET', '/api/ap/grants', 'AP', async ({ ctx }) => access.listGrants(ctx));

// Allowlist + monitored domains
route('GET', '/api/ap/allowlist', 'AP', async ({ ctx }) => controls.listAllowlist(ctx));
route('POST', '/api/ap/allowlist', 'AP', async ({ req, ctx, who }) => {
  const b = await body(req, z.object({ domain: z.string(), profiles: z.array(profileCode).optional(), note: reason }));
  const entry = await controls.addAllowlistEntry(ctx, who.actor, b);
  const results = await controls.reconcileProfiles(ctx, entry.profiles);
  return { entry, errors: results.flatMap((r) => r.errors.map((e) => e.message)) };
});
route('POST', '/api/ap/allowlist/:id/remove', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ reason }));
  await controls.removeAllowlistEntry(ctx, who.actor, params.id!, b.reason);
  const results = await controls.reconcileProfiles(ctx);
  return { removed: true, errors: results.flatMap((r) => r.errors.map((e) => e.message)) };
});
route('GET', '/api/ap/monitored', 'AP', async ({ ctx }) => controls.listMonitoredDomains(ctx));
route('POST', '/api/ap/monitored', 'AP', async ({ req, ctx, who }) => {
  const b = await body(req, z.object({ domain: z.string(), label: z.string().max(80).optional().nullable() }));
  return controls.addMonitoredDomain(ctx, who.actor, b);
});
route('POST', '/api/ap/monitored/:id/remove', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ reason }));
  await controls.removeMonitoredDomain(ctx, who.actor, params.id!, b.reason);
  return { removed: true };
});

// Settings
route('GET', '/api/ap/settings', 'AP', async ({ ctx }) => ({
  settings: await getSettings(ctx),
  options: { visibilityModes: VISIBILITY_MODES, categories: MANAGED_CATEGORIES },
}));
route('PUT', '/api/ap/settings/visibility', 'AP', async ({ req, ctx, who }) => {
  const b = await body(req, z.object({ mode: z.enum(VISIBILITY_MODES), reason: z.string().trim().min(1).max(500) }));
  await setSetting(ctx, who.actor, 'visibilityMode', b.mode, b.reason);
  return getSettings(ctx);
});
route('PUT', '/api/ap/settings/filtering', 'AP', async ({ req, ctx, who }) => {
  const policy = z
    .object({
      safeSearch: z.boolean().optional(),
      youtubeRestrictedMode: z.boolean().optional(),
      blockBypass: z.boolean().optional(),
      categories: z.record(z.enum(MANAGED_CATEGORIES), z.boolean()).optional(),
    })
    .strict()
    .nullable();
  const b = await body(req, z.object({ profile: profileCode, policy, reason }));
  const current = (await getSettings(ctx)).filtering;
  await setSetting(ctx, who.actor, 'filtering', { ...current, [b.profile]: b.policy }, b.reason);
  const results = await controls.reconcileProfiles(ctx, [b.profile]);
  return { settings: await getSettings(ctx), errors: results.flatMap((r) => r.errors.map((e) => e.message)) };
});
route('PUT', '/api/ap/settings/limits', 'AP', async ({ req, ctx, who }) => {
  const b = await body(
    req,
    z.object({
      maxGrantMinutes: z.number().int().min(1).max(1440).optional(),
      requestLapseMinutes: z.number().int().min(5).max(1440).optional(),
      reason,
    }),
  );
  if (b.maxGrantMinutes !== undefined) await setSetting(ctx, who.actor, 'maxGrantMinutes', b.maxGrantMinutes, b.reason);
  if (b.requestLapseMinutes !== undefined)
    await setSetting(ctx, who.actor, 'requestLapseMinutes', b.requestLapseMinutes, b.reason);
  return getSettings(ctx);
});
route('PUT', '/api/ap/settings/thresholds', 'AP', async ({ req, ctx, who }) => {
  const n = z.number().int().min(1).max(24 * 60).optional();
  const b = await body(
    req,
    z.object({
      heartbeatStaleMinutes: n,
      pixelDnsStaleMinutes: n,
      homeDnsStaleMinutes: n,
      pixelGapIncidentMinutes: n,
      homeGapIncidentMinutes: n,
      integrityIntervalMinutes: z.number().int().min(1).max(60).optional(),
      reason,
    }),
  );
  const { reason: r, ...patch } = b;
  const current = (await getSettings(ctx)).thresholds;
  await setSetting(ctx, who.actor, 'thresholds', { ...current, ...patch }, r);
  return getSettings(ctx);
});

// Activity (AP only; shaped by the visibility mode)
route('GET', '/api/ap/activity', 'AP', async ({ ctx, who, url }) =>
  ops.getDnsActivity(ctx, who.actor, {
    profile: profileCode.parse(url.searchParams.get('profile') ?? 'RAY-PIXEL'),
    from: url.searchParams.get('from') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  }),
);
route('GET', '/api/ap/activity/monitored', 'AP', async ({ ctx, who, url }) =>
  ops.getMonitoredEvents(ctx, who.actor, {
    profile: profileCode.parse(url.searchParams.get('profile') ?? 'RAY-PIXEL'),
    from: url.searchParams.get('from') ?? undefined,
  }),
);

// Integrity
route('POST', '/api/ap/integrity/run', 'AP', async ({ ctx }) => {
  await integrity.runIntegrityChecks(ctx, true);
  return ops.getIntegrityStatus(ctx);
});
route('POST', '/api/ap/incidents/:id/review', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ disposition: z.enum(integrity.REVIEW_DISPOSITIONS), note: z.string().trim().min(1).max(1000) }));
  await integrity.reviewIncident(ctx, who.actor, params.id!, b);
  return { reviewed: true };
});
route('GET', '/api/ap/devices', 'AP', async ({ ctx }) => integrity.listDevices(ctx));
route('POST', '/api/ap/devices', 'AP', async ({ req, ctx, who }) => {
  const b = await body(req, z.object({ label: z.string().min(1).max(60), profileCode: profileCode.optional() }));
  return integrity.issueDeviceToken(ctx, who.actor, b);
});
route('POST', '/api/ap/devices/:id/revoke', 'AP', async ({ req, ctx, who, params }) => {
  const b = await body(req, z.object({ reason }));
  await integrity.revokeDevice(ctx, who.actor, params.id!, b.reason);
  return { revoked: true };
});
route('POST', '/api/ap/sync', 'AP', async ({ ctx }) => {
  const results = await controls.reconcileProfiles(ctx);
  return results.map((r) => ({ profile: r.profileCode, ok: r.ok, skipped: r.skipped ?? null, changes: r.changes.length, errors: r.errors.map((e) => e.message) }));
});

// ---------------------------------------------------------------------------
// Device (phone heartbeat). Bearer device token; Access bypassed for /api/device/*.
// ---------------------------------------------------------------------------

const deviceRoutes: Record<string, DeviceHandler> = {
  '/api/device/challenge': async ({ ctx, device }) => integrity.issueChallenge(ctx, device),
  '/api/device/heartbeat': async ({ req, ctx, device }) => {
    const b = await body(
      req,
      z.object({
        deviceTime: z.string().max(40).optional(),
        network: z.enum(['WIFI', 'CELLULAR', 'OTHER', 'NONE']),
        privateDnsActive: z.boolean().nullable().optional(),
        privateDnsServer: z.string().max(253).nullable().optional(),
        nextdnsTest: z
          .object({ status: z.string().max(40).nullable().optional(), profile: z.string().max(40).nullable().optional() })
          .nullable()
          .optional(),
        canaryNonce: z.string().max(64).nullable().optional(),
        recordingAssistant: z.string().max(40).nullable().optional(),
        appVersion: z.string().max(40).nullable().optional(),
      }),
    );
    return integrity.recordHeartbeat(ctx, device, b);
  },
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleApi(req: Request, ctx: Ctx, fetchFn: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname.startsWith('/api/device/')) {
      const h = deviceRoutes[url.pathname];
      if (!h || req.method !== 'POST') throw new HttpError(404, 'not_found');
      const device = await integrity.authenticateDevice(ctx, req.headers.get('Authorization'));
      if (!device) throw new HttpError(401, 'unauthenticated');
      return json(await h({ req, ctx, device }));
    }

    const who = await authenticatePerson(req, ctx.env, ctx.clock.now().getTime(), fetchFn);
    if (req.method !== 'GET') assertSameOriginJson(req, url);

    const pathMatches = routes.filter((r) => r.pattern.test(url.pathname));
    if (!pathMatches.length) throw new HttpError(404, 'not_found');
    const r = pathMatches.find((x) => x.method === req.method);
    if (!r) throw new HttpError(405, 'method_not_allowed');
    if (r.role !== 'ANY' && r.role !== who.role) throw new HttpError(403, 'forbidden');
    const m = url.pathname.match(r.pattern)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]!]));
    return json(await r.handler({ req, ctx, params, url, who }));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    if (e instanceof z.ZodError) return json({ error: 'invalid_request', message: e.issues[0]?.message }, 400);
    console.error('unhandled', e);
    return json({ error: 'internal_error' }, 500);
  }
}

/** CSRF defense for cookie-authenticated (Access) mutations. */
function assertSameOriginJson(req: Request, url: URL) {
  const ct = req.headers.get('Content-Type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json_required');
  const origin = req.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'cross_origin');
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
