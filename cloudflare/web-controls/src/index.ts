/**
 * AP-owned Cloudflare Worker — NextDNS Web Controls.
 *
 *   AP Portal (browser, behind Cloudflare Access)
 *     -> this Worker (/api/*)  -> NextDNS API (key is a Worker secret)
 *   Phone heartbeat (/api/device/*, device token)
 *   Cron trigger (every minute): grant expiry + restoration, request lapse,
 *     and every few minutes the integrity checks.
 */
import { lapseRequests, expireGrants, processRestorations } from './access.js';
import { createCtx, type Ctx } from './context.js';
import type { Env } from './env.js';
import { runIntegrityChecks } from './integrity.js';
import { handleApi } from './routes.js';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

/** One scheduler tick. Exported for tests. */
export async function runScheduled(ctx: Ctx): Promise<void> {
  // Order matters: expire first so restoration sees the ended grants.
  await expireGrants(ctx);
  await processRestorations(ctx);
  await lapseRequests(ctx);
  await runIntegrityChecks(ctx);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return withHeaders(await handleApi(request, createCtx(env)));
    if (url.pathname === '/health') return withHeaders(new Response('ok'));
    if (env.ASSETS) return withHeaders(await env.ASSETS.fetch(request));
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduled(createCtx(env)).catch((e) => {
        console.error('scheduled run failed', e);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
