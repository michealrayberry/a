/**
 * AP-controlled settings. Every write is audited with previous and new value.
 */
import { auditStatement, type Actor } from './audit.js';
import type { Ctx, ProfileCode } from './context.js';
import { iso } from './util.js';

export const VISIBILITY_MODES = ['BLOCKED_EVENTS_ONLY', 'MONITORED_DOMAINS', 'ALL_DOMAINS'] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];

/** NextDNS parental-control categories the portal may manage. */
export const MANAGED_CATEGORIES = ['porn', 'gambling', 'dating', 'piracy', 'social-networks'] as const;

export interface FilteringPolicy {
  safeSearch?: boolean;
  youtubeRestrictedMode?: boolean;
  blockBypass?: boolean;
  categories?: Partial<Record<(typeof MANAGED_CATEGORIES)[number], boolean>>;
}

export interface Thresholds {
  heartbeatStaleMinutes: number;
  pixelDnsStaleMinutes: number;
  homeDnsStaleMinutes: number;
  pixelGapIncidentMinutes: number;
  homeGapIncidentMinutes: number;
  integrityIntervalMinutes: number;
}

export interface Settings {
  /**
   * Narrowest mode by default. Wider AP visibility must be a deliberate,
   * audited AP decision — never an accidental side effect.
   */
  visibilityMode: VisibilityMode;
  maxGrantMinutes: number;
  /** Unanswered requests lapse (fail closed) after this long. */
  requestLapseMinutes: number;
  thresholds: Thresholds;
  /** null = the portal does not manage filtering settings on that profile. */
  filtering: Record<ProfileCode, FilteringPolicy | null>;
}

export const DEFAULT_SETTINGS: Settings = {
  visibilityMode: 'BLOCKED_EVENTS_ONLY',
  maxGrantMinutes: 240,
  requestLapseMinutes: 120,
  thresholds: {
    heartbeatStaleMinutes: 45,
    pixelDnsStaleMinutes: 30,
    homeDnsStaleMinutes: 30,
    pixelGapIncidentMinutes: 120,
    homeGapIncidentMinutes: 60,
    integrityIntervalMinutes: 5,
  },
  filtering: { 'RAY-PIXEL': null, 'HOME-ROUTER': null },
};

type Key = keyof Settings;

export async function getSettings(ctx: Ctx): Promise<Settings> {
  const { results } = await ctx.db.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: string }>();
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const r of results) {
    if (!(r.key in s)) continue;
    const v = JSON.parse(r.value);
    if (r.key === 'thresholds') s.thresholds = { ...s.thresholds, ...v };
    else if (r.key === 'filtering') s.filtering = { ...s.filtering, ...v };
    else (s as unknown as Record<string, unknown>)[r.key] = v;
  }
  return s;
}

export async function setSetting<K extends Key>(
  ctx: Ctx,
  actor: Actor,
  key: K,
  value: Settings[K],
  reason?: string | null,
): Promise<void> {
  const prev = (await getSettings(ctx))[key];
  const now = iso(ctx.clock.now());
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO settings (key, value, updatedAt, updatedBy) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
      )
      .bind(key, JSON.stringify(value), now, actor.id ?? actor.type),
    auditStatement(ctx.db, ctx.clock, {
      actor,
      automatic: false,
      action: `settings.${key}.changed`,
      targetType: 'setting',
      targetId: key,
      targetLabel: key,
      previousState: prev,
      newState: value,
      summary: `${actor.type} changed ${key}`,
      reason,
    }),
  ]);
}

/** Internal bookkeeping values (not AP policy, not audited). */
export async function getInternal(ctx: Ctx, key: string): Promise<string | null> {
  const r = await ctx.db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(`internal:${key}`).first<{ value: string }>();
  return r ? (JSON.parse(r.value) as string) : null;
}
export async function setInternal(ctx: Ctx, key: string, value: string): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO settings (key, value, updatedAt, updatedBy) VALUES (?, ?, ?, 'SYSTEM')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    )
    .bind(`internal:${key}`, JSON.stringify(value), iso(ctx.clock.now()))
    .run();
}
