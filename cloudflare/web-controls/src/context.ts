import type { Env } from './env.js';
import { NextDnsClient } from './nextdns.js';
import { systemClock, type Clock } from './util.js';

export const PROFILE_CODES = ['RAY-PIXEL', 'HOME-ROUTER'] as const;
export type ProfileCode = (typeof PROFILE_CODES)[number];

/** Everything a service needs; built once per request / scheduled run. */
export interface Ctx {
  db: D1Database;
  clock: Clock;
  nextdns: NextDnsClient;
  env: Env;
  profileId(code: ProfileCode): string | null;
  alert(event: AlertEvent): Promise<void>;
}

export interface AlertEvent {
  kind: string;
  title: string;
  text: string;
}

export function createCtx(
  env: Env,
  opts: { clock?: Clock; fetchFn?: (i: string, init?: RequestInit) => Promise<Response> } = {},
): Ctx {
  const fetchFn = opts.fetchFn ?? ((i, init) => fetch(i, init));
  return {
    db: env.DB,
    clock: opts.clock ?? systemClock,
    env,
    nextdns: new NextDnsClient(env.NEXTDNS_API_KEY, fetchFn),
    profileId: (code) =>
      (code === 'RAY-PIXEL' ? env.NEXTDNS_PROFILE_RAY_PIXEL : env.NEXTDNS_PROFILE_HOME_ROUTER)?.trim() || null,
    alert: async (event) => {
      if (!env.ALERT_WEBHOOK_URL) return;
      try {
        // Alerts carry summaries only — never DNS activity or credentials.
        await fetchFn(env.ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'mrb-web-controls', ...event }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Alert delivery is best-effort; the portal and audit log are the record.
      }
    },
  };
}
