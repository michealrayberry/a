import { createCtx, type Ctx } from '../src/context.js';
import type { Env } from '../src/env.js';
import type { Actor } from '../src/audit.js';
import { createD1 } from './d1shim.js';
import { API_KEY, FakeNextDns } from './fakeNextDns.js';

export const PIXEL = 'pix123';
export const HOME = 'home456';
export const AP: Actor = { type: 'AP', id: 'ap@example.test' };
export const PARTICIPANT: Actor = { type: 'PARTICIPANT', id: 'participant@example.test' };

export class TestClock {
  constructor(public t = new Date('2026-10-05T00:42:00.000Z')) {} // 8:42 PM ET
  now = () => new Date(this.t);
  advance(minutes: number) {
    this.t = new Date(this.t.getTime() + minutes * 60_000);
  }
}

export function setup(envOverrides: Partial<Env> = {}) {
  const { d1, raw } = createD1();
  const nextdns = new FakeNextDns([PIXEL, HOME]);
  const clock = new TestClock();
  const alerts: unknown[] = [];
  const env: Env = {
    DB: d1,
    NEXTDNS_API_KEY: API_KEY,
    NEXTDNS_PROFILE_RAY_PIXEL: PIXEL,
    NEXTDNS_PROFILE_HOME_ROUTER: HOME,
    AP_EMAILS: 'ap@example.test',
    PARTICIPANT_EMAILS: 'participant@example.test',
    CANARY_SUFFIX: 'hb.example.test',
    ENVIRONMENT: 'production',
    AUTH_MODE: 'access',
    ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook',
    ...envOverrides,
  };
  const fetchFn = async (i: string, init?: RequestInit) => {
    if (i.startsWith('https://alerts.example.test')) {
      alerts.push(JSON.parse(String(init?.body)));
      return new Response('ok');
    }
    return nextdns.fetch(i, init);
  };
  const ctx: Ctx = createCtx(env, { clock, fetchFn });
  const auditRows = () =>
    raw.prepare(`SELECT * FROM audit_log ORDER BY rowid`).all() as {
      action: string;
      summary: string;
      actorType: string;
      automatic: number;
      previousState: string | null;
      newState: string | null;
    }[];
  return { ctx, env, raw, nextdns, clock, alerts, auditRows, fetchFn };
}
