/**
 * NextDNS gateway — the ONLY module that talks to the NextDNS API and the ONLY
 * module that ever sees the API credential.
 *
 * Security boundary (NextDNS direction §1, §12, §13, §14):
 *  - The API key is read from server-side configuration (env var locally,
 *    `wrangler secret` on the Cloudflare Worker target). It is never returned
 *    by any route, never logged, and never included in an error message.
 *  - The gateway exposes a fixed set of typed operations. There is deliberately
 *    no "call arbitrary path" method, so no portal feature can become a generic
 *    NextDNS API console.
 *  - Implemented with `fetch` only (no Node-specific APIs) so it runs unchanged
 *    inside a Cloudflare Worker.
 *
 * API shape: base https://api.nextdns.io, `X-Api-Key` header, `{ data: … }`
 * response envelope. Verify the paths below against the live API when the AP
 * binds the first real profile (see docs/NEXTDNS.md, "First live connection").
 */

/** Where a rule lives in a NextDNS profile. */
export type RuleCollection = 'denylist' | 'allowlist' | 'services';

export interface RuleRef {
  collection: RuleCollection;
  /** Normalized domain (denylist/allowlist) or NextDNS service id (services). */
  id: string;
}

/** The filtering settings the portal is permitted to change (Phase 2). */
export interface FilteringSettings {
  safeSearch: boolean;
  youtubeRestrictedMode: boolean;
  /** Blocks known bypass methods (VPNs, proxies, alternate DoH resolvers). */
  blockBypass: boolean;
}
export const FILTERING_SETTING_KEYS: (keyof FilteringSettings)[] = [
  'safeSearch',
  'youtubeRestrictedMode',
  'blockBypass',
];

export interface ProfileInfo {
  id: string;
  name: string;
  filtering: FilteringSettings;
}

export type GatewayMode = 'LIVE' | 'SIMULATED';

export interface NextDnsGateway {
  readonly mode: GatewayMode;
  getProfile(profileId: string): Promise<ProfileInfo>;
  /** Create the rule or, if it already exists, set its active flag. */
  upsertRule(profileId: string, rule: RuleRef, active: boolean): Promise<void>;
  /** Delete the rule. Deleting a rule that does not exist is not an error. */
  removeRule(profileId: string, rule: RuleRef): Promise<void>;
  updateFilteringSettings(profileId: string, settings: Partial<FilteringSettings>): Promise<void>;
  /** Timestamp of the most recent DNS query NextDNS logged for the profile, if any. */
  getLastQueryAt(profileId: string): Promise<string | null>;
}

/** Error safe to surface to the portal: status + operation, never the key. */
export class NextDnsError extends Error {
  constructor(
    public readonly status: number,
    operation: string,
  ) {
    super(`NextDNS ${operation} failed (HTTP ${status})`);
    this.name = 'NextDnsError';
  }
}

const COLLECTION_PATH: Record<RuleCollection, string> = {
  denylist: 'denylist',
  allowlist: 'allowlist',
  services: 'parentalControl/services',
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class HttpNextDnsGateway implements NextDnsGateway {
  readonly mode = 'LIVE' as const;
  readonly #apiKey: string;

  constructor(
    apiKey: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly baseUrl = 'https://api.nextdns.io',
  ) {
    if (!apiKey) throw new Error('NextDNS API key is required');
    this.#apiKey = apiKey;
  }

  private async call(method: string, path: string, operation: string, body?: unknown): Promise<unknown> {
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { 'X-Api-Key': this.#apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NextDnsError(0, operation); // network failure; never echo request details
    }
    if (!res.ok) throw new NextDnsError(res.status, operation);
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  private static p(profileId: string): string {
    return `/profiles/${encodeURIComponent(profileId)}`;
  }

  async getProfile(profileId: string): Promise<ProfileInfo> {
    const body = (await this.call('GET', HttpNextDnsGateway.p(profileId), 'getProfile')) as {
      data?: { id?: string; name?: string; parentalControl?: Partial<FilteringSettings> };
    } | null;
    const pc = body?.data?.parentalControl ?? {};
    return {
      id: body?.data?.id ?? profileId,
      name: body?.data?.name ?? '',
      filtering: {
        safeSearch: !!pc.safeSearch,
        youtubeRestrictedMode: !!pc.youtubeRestrictedMode,
        blockBypass: !!pc.blockBypass,
      },
    };
  }

  async upsertRule(profileId: string, rule: RuleRef, active: boolean): Promise<void> {
    const base = `${HttpNextDnsGateway.p(profileId)}/${COLLECTION_PATH[rule.collection]}`;
    try {
      await this.call('PATCH', `${base}/${encodeURIComponent(rule.id)}`, `update ${rule.collection}`, { active });
    } catch (e) {
      if (!(e instanceof NextDnsError) || e.status !== 404) throw e;
      await this.call('POST', base, `add ${rule.collection}`, { id: rule.id, active });
    }
  }

  async removeRule(profileId: string, rule: RuleRef): Promise<void> {
    const path = `${HttpNextDnsGateway.p(profileId)}/${COLLECTION_PATH[rule.collection]}/${encodeURIComponent(rule.id)}`;
    try {
      await this.call('DELETE', path, `remove ${rule.collection}`);
    } catch (e) {
      if (!(e instanceof NextDnsError) || e.status !== 404) throw e;
    }
  }

  async updateFilteringSettings(profileId: string, settings: Partial<FilteringSettings>): Promise<void> {
    const patch: Partial<FilteringSettings> = {};
    for (const k of FILTERING_SETTING_KEYS) if (settings[k] !== undefined) patch[k] = settings[k];
    await this.call('PATCH', `${HttpNextDnsGateway.p(profileId)}/parentalControl`, 'updateFilteringSettings', patch);
  }

  async getLastQueryAt(profileId: string): Promise<string | null> {
    const body = (await this.call('GET', `${HttpNextDnsGateway.p(profileId)}/logs?limit=1`, 'getLogs')) as {
      data?: { timestamp?: string }[];
    } | null;
    return body?.data?.[0]?.timestamp ?? null;
  }
}

/**
 * In-memory stand-in used by tests and by local development when
 * NEXTDNS_MODE=simulated. Every status response carries mode=SIMULATED so it
 * can never be mistaken for real enforcement.
 */
export class SimulatedNextDnsGateway implements NextDnsGateway {
  readonly mode = 'SIMULATED' as const;
  /** Set true to make every call fail (tests: outage / restore-failure paths). */
  failing = false;
  readonly profiles = new Map<
    string,
    { rules: Map<string, boolean>; filtering: FilteringSettings; lastQueryAt: string | null }
  >();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    /** Development convenience: any profile id "exists" on first use. */
    private readonly autoCreate = true,
    /** Development convenience: every profile appears to have just seen a query. */
    private readonly continuousTraffic = autoCreate,
  ) {}

  /** Test helper: pretend NextDNS logged a query for the profile at `at`. */
  recordQuery(profileId: string, at: string | null): void {
    const p = this.profiles.get(profileId);
    if (p) p.lastQueryAt = at;
  }

  addProfile(profileId: string): void {
    this.profiles.set(profileId, {
      rules: new Map(),
      filtering: { safeSearch: false, youtubeRestrictedMode: false, blockBypass: false },
      lastQueryAt: this.now(),
    });
  }

  private get(profileId: string, operation: string) {
    if (this.failing) throw new NextDnsError(503, operation);
    if (!this.profiles.has(profileId) && this.autoCreate) this.addProfile(profileId);
    const p = this.profiles.get(profileId);
    if (!p) throw new NextDnsError(404, operation);
    return p;
  }

  /** Test helper: current rule state, `undefined` if absent. */
  rule(profileId: string, rule: RuleRef): boolean | undefined {
    return this.profiles.get(profileId)?.rules.get(`${rule.collection}:${rule.id}`);
  }

  async getProfile(profileId: string): Promise<ProfileInfo> {
    const p = this.get(profileId, 'getProfile');
    return { id: profileId, name: `Simulated ${profileId}`, filtering: { ...p.filtering } };
  }
  async upsertRule(profileId: string, rule: RuleRef, active: boolean): Promise<void> {
    this.get(profileId, 'upsertRule').rules.set(`${rule.collection}:${rule.id}`, active);
  }
  async removeRule(profileId: string, rule: RuleRef): Promise<void> {
    this.get(profileId, 'removeRule').rules.delete(`${rule.collection}:${rule.id}`);
  }
  async updateFilteringSettings(profileId: string, settings: Partial<FilteringSettings>): Promise<void> {
    const p = this.get(profileId, 'updateFilteringSettings');
    for (const k of FILTERING_SETTING_KEYS) if (settings[k] !== undefined) p.filtering[k] = settings[k]!;
  }
  async getLastQueryAt(profileId: string): Promise<string | null> {
    const p = this.get(profileId, 'getLogs');
    return this.continuousTraffic ? this.now() : p.lastQueryAt;
  }
}

/**
 * Build the gateway from server-side configuration.
 *  - NEXTDNS_API_KEY set           → live gateway
 *  - NEXTDNS_MODE=simulated        → simulated gateway (development only)
 *  - neither                       → null: the module reports NOT_CONFIGURED and
 *                                    refuses policy writes rather than pretending.
 */
export function nextDnsFromEnv(env: Record<string, string | undefined> = process.env): NextDnsGateway | null {
  if (env.NEXTDNS_API_KEY) return new HttpNextDnsGateway(env.NEXTDNS_API_KEY);
  if (env.NEXTDNS_MODE === 'simulated') return new SimulatedNextDnsGateway();
  return null;
}
