/**
 * DNS activity visibility.
 *
 * Privacy rules enforced here (server-side, before anything reaches a browser):
 *   - The AP-selected visibility mode decides what is returned at all:
 *       BLOCKED_EVENTS_ONLY  only queries NextDNS blocked
 *       MONITORED_DOMAINS    blocked queries + monitored/controlled domains
 *       ALL_DOMAINS          every query NextDNS logged
 *   - Client IP addresses are dropped (they reveal location, not behavior).
 *   - Every event is labeled as a *signal*, never as proof of deliberate use.
 *   - HOME-ROUTER activity is labeled as home-network traffic that may come
 *     from other devices or guests and is never attributed to the participant.
 *   - Each AP view is itself audited so visibility is transparent.
 */
import { audit, type Actor } from './audit.js';
import type { Ctx, ProfileCode } from './context.js';
import { listControls, listMonitoredDomains } from './controls.js';
import type { NextDnsLogEntry } from './nextdns.js';
import { getSettings, type VisibilityMode } from './settings.js';
import { domainCovers, HttpError } from './util.js';

export type SignalKind = 'BLOCKED_ATTEMPT' | 'MONITORED_DOMAIN' | 'CONTROLLED_DOMAIN' | 'DNS_QUERY';

export interface ActivityEvent {
  timestamp: string;
  domain: string;
  root: string | null;
  status: string;
  signal: SignalKind;
  matched: string | null; // control label or monitored domain that matched
  reasons: string[];
  deviceName: string | null;
}

export interface ActivityPage {
  profileCode: ProfileCode;
  context: 'DEVICE' | 'NETWORK';
  heading: 'RAY-PIXEL ACTIVITY' | 'HOME NETWORK ACTIVITY';
  attribution: string;
  visibilityMode: VisibilityMode;
  interpretation: string;
  events: ActivityEvent[];
  cursor: string | null;
}

export const INTERPRETATION =
  'DNS events are accountability signals, not proof of deliberate use. Apps and the operating system make background lookups; a lookup does not show that a service was opened, used, or that an order or purchase was attempted. DNS shows domain names only — not page contents, passwords, balances, transactions, card numbers, or message contents.';

const ATTRIBUTION: Record<ProfileCode, string> = {
  'RAY-PIXEL': "Phone-specific: queries from the Pixel's Private DNS profile (Wi-Fi and cellular).",
  'HOME-ROUTER':
    'Home network: queries from any device on the home Wi-Fi (computers, TVs, streaming and smart-home devices, guests). Not attributed to Micheal personally.',
};

export async function getDnsActivity(
  ctx: Ctx,
  actor: Actor,
  input: { profile: ProfileCode; from?: string; cursor?: string; limit?: number },
): Promise<ActivityPage> {
  const settings = await getSettings(ctx);
  const mode = settings.visibilityMode;
  const profileId = ctx.profileId(input.profile);
  if (!profileId) throw new HttpError(409, 'profile_not_configured', `${input.profile} has no NextDNS profile id`);

  const controls = await listControls(ctx);
  const monitored = await listMonitoredDomains(ctx);
  const matchers: { domain: string; label: string; kind: 'CONTROLLED_DOMAIN' | 'MONITORED_DOMAIN' }[] = [
    ...controls.flatMap((c) => c.domains.map((d) => ({ domain: d, label: c.label, kind: 'CONTROLLED_DOMAIN' as const }))),
    ...monitored.map((m) => ({ domain: m.domain, label: m.label ?? m.domain, kind: 'MONITORED_DOMAIN' as const })),
  ];

  const limit = Math.min(Math.max(input.limit ?? 100, 10), 500);
  const page = await ctx.nextdns.getLogs(profileId, {
    from: input.from ?? '-24h',
    cursor: input.cursor,
    // In the narrowest mode, ask NextDNS for blocked events only so other
    // lookups never even enter the Worker.
    status: mode === 'BLOCKED_EVENTS_ONLY' ? 'blocked' : undefined,
    limit: mode === 'MONITORED_DOMAINS' ? 1000 : limit,
  });

  const events: ActivityEvent[] = [];
  for (const e of page.data) {
    const ev = classify(e, matchers);
    if (mode === 'BLOCKED_EVENTS_ONLY' && ev.signal !== 'BLOCKED_ATTEMPT') continue;
    if (mode === 'MONITORED_DOMAINS' && ev.signal === 'DNS_QUERY') continue;
    events.push(ev);
    if (events.length >= limit) break;
  }

  await audit(ctx.db, ctx.clock, {
    actor,
    automatic: false,
    action: 'activity.viewed',
    targetType: 'dns_activity',
    targetId: input.profile,
    targetLabel: input.profile === 'RAY-PIXEL' ? 'RAY-PIXEL ACTIVITY' : 'HOME NETWORK ACTIVITY',
    profileCode: input.profile,
    newState: { visibilityMode: mode, from: input.from ?? '-24h', returned: events.length },
    summary: `${actor.type} viewed ${input.profile} DNS activity (${mode.replace(/_/g, ' ').toLowerCase()})`,
  });

  return {
    profileCode: input.profile,
    context: input.profile === 'RAY-PIXEL' ? 'DEVICE' : 'NETWORK',
    heading: input.profile === 'RAY-PIXEL' ? 'RAY-PIXEL ACTIVITY' : 'HOME NETWORK ACTIVITY',
    attribution: ATTRIBUTION[input.profile],
    visibilityMode: mode,
    interpretation: INTERPRETATION,
    events,
    cursor: page.cursor,
  };
}

/** Monitored + blocked events only, regardless of a wider visibility mode. */
export async function getMonitoredEvents(
  ctx: Ctx,
  actor: Actor,
  input: { profile: ProfileCode; from?: string; cursor?: string },
): Promise<ActivityPage> {
  const page = await getDnsActivity(ctx, actor, { ...input, limit: 500 });
  return { ...page, events: page.events.filter((e) => e.signal !== 'DNS_QUERY') };
}

function classify(
  e: NextDnsLogEntry,
  matchers: { domain: string; label: string; kind: 'CONTROLLED_DOMAIN' | 'MONITORED_DOMAIN' }[],
): ActivityEvent {
  const domain = (e.domain ?? '').toLowerCase();
  const match = matchers.find((m) => domainCovers(m.domain, domain));
  const blocked = e.status === 'blocked';
  return {
    timestamp: e.timestamp,
    domain,
    root: e.root ?? null,
    status: e.status ?? 'default',
    signal: blocked ? 'BLOCKED_ATTEMPT' : match ? match.kind : 'DNS_QUERY',
    matched: match?.label ?? null,
    reasons: (e.reasons ?? []).map((r) => r.name ?? r.id),
    // Device names only (set in NextDNS / Private DNS hostname). No client IPs.
    deviceName: e.device?.name ?? null,
  };
}
