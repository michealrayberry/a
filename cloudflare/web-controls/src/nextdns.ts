/**
 * NextDNS API client — server-side only.
 *
 * This is deliberately NOT a generic proxy. It exposes a fixed set of typed
 * operations; no route accepts an arbitrary NextDNS path, method, or body.
 * The API key is read from the Worker secret and attached here only.
 *
 * Endpoints used (NextDNS API v1, https://nextdns.github.io/api/ — re-verify
 * against the live docs before go-live; see docs/NEXTDNS.md "Go-live checks"):
 *   GET    /profiles/:p                                   full profile (lists + parental control)
 *   POST   /profiles/:p/{denylist|allowlist}              { id, active }
 *   PATCH  /profiles/:p/{denylist|allowlist}/:id          { active }
 *   DELETE /profiles/:p/{denylist|allowlist}/:id
 *   POST   /profiles/:p/parentalControl/services          { id, active }
 *   PATCH  /profiles/:p/parentalControl/services/:id      { active }
 *   DELETE /profiles/:p/parentalControl/services/:id
 *   PATCH  /profiles/:p/parentalControl                   { safeSearch, youtubeRestrictedMode, blockBypass }
 *   POST   /profiles/:p/parentalControl/categories        { id, active }
 *   PATCH  /profiles/:p/parentalControl/categories/:id    { active }
 *   GET    /profiles/:p/logs?from&to&limit&status&search&cursor
 */

export type ListName = 'denylist' | 'allowlist';

export interface NextDnsListEntry {
  id: string;
  active: boolean;
}

export interface NextDnsProfile {
  id?: string;
  name?: string;
  denylist?: NextDnsListEntry[];
  allowlist?: NextDnsListEntry[];
  parentalControl?: {
    services?: NextDnsListEntry[];
    categories?: NextDnsListEntry[];
    safeSearch?: boolean;
    youtubeRestrictedMode?: boolean;
    blockBypass?: boolean;
  };
}

export interface NextDnsLogEntry {
  timestamp: string;
  domain: string;
  root?: string;
  status?: string; // "default" | "blocked" | "allowed" | "error" | ...
  reasons?: { id: string; name: string }[];
  device?: { id?: string; name?: string; model?: string };
  protocol?: string;
  encrypted?: boolean;
  clientIp?: string;
}

export interface LogQuery {
  from?: string;
  to?: string;
  limit?: number;
  status?: 'blocked' | 'allowed' | 'default' | 'error';
  search?: string;
  cursor?: string;
}

export class NextDnsError extends Error {
  constructor(
    readonly status: number,
    readonly kind: 'AUTH' | 'NOT_FOUND' | 'RATE_LIMIT' | 'UPSTREAM' | 'NETWORK' | 'NOT_CONFIGURED',
    message: string,
  ) {
    super(message);
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const BASE = 'https://api.nextdns.io';
const TIMEOUT_MS = 10_000;

export class NextDnsClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {}

  get configured(): boolean {
    return !!this.apiKey;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw new NextDnsError(0, 'NOT_CONFIGURED', 'NEXTDNS_API_KEY secret is not set');
    let res: Response;
    try {
      res = await this.fetchFn(`${BASE}${path}`, {
        method,
        headers: {
          'X-Api-Key': this.apiKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new NextDnsError(0, 'NETWORK', `NextDNS unreachable: ${(e as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const kind =
        res.status === 401 || res.status === 403
          ? 'AUTH'
          : res.status === 404
            ? 'NOT_FOUND'
            : res.status === 429
              ? 'RATE_LIMIT'
              : 'UPSTREAM';
      // Never include request headers (the key) in errors.
      const detail = describeErrors(json) ?? `HTTP ${res.status}`;
      throw new NextDnsError(res.status, kind, `NextDNS ${method} ${redactPath(path)} failed: ${detail}`);
    }
    // NextDNS also reports validation errors in a 200 body as { errors: [...] }.
    const errs = describeErrors(json);
    if (errs) throw new NextDnsError(res.status, 'UPSTREAM', `NextDNS ${method} ${redactPath(path)} rejected: ${errs}`);
    return json as T;
  }

  async getProfile(profileId: string): Promise<NextDnsProfile> {
    const r = await this.call<{ data: NextDnsProfile }>('GET', `/profiles/${enc(profileId)}`);
    return r?.data ?? {};
  }

  addListEntry(profileId: string, list: ListName, domain: string, active: boolean) {
    return this.call('POST', `/profiles/${enc(profileId)}/${list}`, { id: domain, active });
  }
  setListEntryActive(profileId: string, list: ListName, domain: string, active: boolean) {
    return this.call('PATCH', `/profiles/${enc(profileId)}/${list}/${enc(domain)}`, { active });
  }
  removeListEntry(profileId: string, list: ListName, domain: string) {
    return this.call('DELETE', `/profiles/${enc(profileId)}/${list}/${enc(domain)}`);
  }

  addService(profileId: string, serviceId: string, active: boolean) {
    return this.call('POST', `/profiles/${enc(profileId)}/parentalControl/services`, { id: serviceId, active });
  }
  setServiceActive(profileId: string, serviceId: string, active: boolean) {
    return this.call('PATCH', `/profiles/${enc(profileId)}/parentalControl/services/${enc(serviceId)}`, { active });
  }
  removeService(profileId: string, serviceId: string) {
    return this.call('DELETE', `/profiles/${enc(profileId)}/parentalControl/services/${enc(serviceId)}`);
  }

  patchParentalControl(
    profileId: string,
    patch: { safeSearch?: boolean; youtubeRestrictedMode?: boolean; blockBypass?: boolean },
  ) {
    return this.call('PATCH', `/profiles/${enc(profileId)}/parentalControl`, patch);
  }
  addCategory(profileId: string, categoryId: string, active: boolean) {
    return this.call('POST', `/profiles/${enc(profileId)}/parentalControl/categories`, { id: categoryId, active });
  }
  setCategoryActive(profileId: string, categoryId: string, active: boolean) {
    return this.call('PATCH', `/profiles/${enc(profileId)}/parentalControl/categories/${enc(categoryId)}`, {
      active,
    });
  }

  async getLogs(
    profileId: string,
    q: LogQuery,
  ): Promise<{ data: NextDnsLogEntry[]; cursor: string | null }> {
    const params = new URLSearchParams();
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    if (q.limit) params.set('limit', String(Math.min(Math.max(q.limit, 10), 1000)));
    if (q.status) params.set('status', q.status);
    if (q.search) params.set('search', q.search);
    if (q.cursor) params.set('cursor', q.cursor);
    const r = await this.call<{ data?: NextDnsLogEntry[]; meta?: { pagination?: { cursor?: string | null } } }>(
      'GET',
      `/profiles/${enc(profileId)}/logs?${params.toString()}`,
    );
    return { data: r?.data ?? [], cursor: r?.meta?.pagination?.cursor ?? null };
  }
}

const enc = encodeURIComponent;
const redactPath = (p: string) => p.split('?')[0];

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeErrors(json: unknown): string | null {
  const errors = (json as { errors?: { code?: string; detail?: string }[] } | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((e) => e.detail ?? e.code ?? 'error').join('; ');
}
