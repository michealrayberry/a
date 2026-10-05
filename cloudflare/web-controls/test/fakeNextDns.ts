/**
 * In-memory fake of the NextDNS API endpoints the Worker uses. Records every
 * call (so tests can assert the key is only sent to api.nextdns.io) and can be
 * told to fail.
 */
type Entry = { id: string; active: boolean };
interface Profile {
  denylist: Entry[];
  allowlist: Entry[];
  parentalControl: {
    services: Entry[];
    categories: Entry[];
    safeSearch: boolean;
    youtubeRestrictedMode: boolean;
    blockBypass: boolean;
  };
  logs: { timestamp: string; domain: string; root?: string; status: string; clientIp?: string; device?: { name?: string }; reasons?: { id: string; name: string }[] }[];
}

export const API_KEY = 'test-nextdns-key-SECRET';

export class FakeNextDns {
  profiles = new Map<string, Profile>();
  calls: { method: string; url: string; apiKey: string | null; body: unknown }[] = [];
  /** Return true to make a call fail with the given status. */
  failWhen: ((method: string, path: string) => number | null) | null = null;

  constructor(ids: string[]) {
    for (const id of ids)
      this.profiles.set(id, {
        denylist: [],
        allowlist: [],
        parentalControl: { services: [], categories: [], safeSearch: false, youtubeRestrictedMode: false, blockBypass: false },
        logs: [],
      });
  }

  p(id: string) {
    return this.profiles.get(id)!;
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, url: input, apiKey: headers.get('X-Api-Key'), body });
    if (url.hostname !== 'api.nextdns.io') return new Response('not found', { status: 404 });
    if (headers.get('X-Api-Key') !== API_KEY)
      return Response.json({ errors: [{ code: 'forbidden' }] }, { status: 403 });
    const fail = this.failWhen?.(method, url.pathname);
    if (fail) return Response.json({ errors: [{ code: 'error', detail: `injected ${fail}` }] }, { status: fail });

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // profiles, :id, ...
    const prof = this.profiles.get(parts[1]!);
    if (parts[0] !== 'profiles' || !prof) return Response.json({ errors: [{ code: 'notFound' }] }, { status: 404 });
    const rest = parts.slice(2);

    if (rest.length === 0 && method === 'GET') return Response.json({ data: { id: parts[1], ...structuredClone(prof) } });

    if (rest[0] === 'logs' && method === 'GET') {
      let logs = [...prof.logs].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const status = url.searchParams.get('status');
      const search = url.searchParams.get('search');
      const from = url.searchParams.get('from');
      if (status) logs = logs.filter((l) => l.status === status);
      if (search) logs = logs.filter((l) => l.domain.includes(search));
      if (from && !from.startsWith('-')) logs = logs.filter((l) => l.timestamp >= new Date(from).toISOString());
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return Response.json({ data: logs.slice(0, limit), meta: { pagination: { cursor: null } } });
    }

    const listFor = (): Entry[] | null => {
      if (rest[0] === 'denylist') return prof.denylist;
      if (rest[0] === 'allowlist') return prof.allowlist;
      if (rest[0] === 'parentalControl' && rest[1] === 'services') return prof.parentalControl.services;
      if (rest[0] === 'parentalControl' && rest[1] === 'categories') return prof.parentalControl.categories;
      return null;
    };
    const list = listFor();
    const itemId = rest[0] === 'parentalControl' ? rest[2] : rest[1];

    if (rest[0] === 'parentalControl' && rest.length === 1 && method === 'PATCH') {
      Object.assign(prof.parentalControl, body);
      return new Response(null, { status: 204 });
    }
    if (list && !itemId && method === 'POST') {
      if (list.some((e) => e.id === body.id)) return Response.json({ errors: [{ code: 'duplicate' }] }, { status: 400 });
      list.push({ id: body.id, active: body.active ?? true });
      return Response.json({ data: body });
    }
    if (list && itemId && method === 'PATCH') {
      const e = list.find((x) => x.id === itemId);
      if (!e) return Response.json({ errors: [{ code: 'notFound' }] }, { status: 404 });
      Object.assign(e, body);
      return new Response(null, { status: 204 });
    }
    if (list && itemId && method === 'DELETE') {
      const i = list.findIndex((x) => x.id === itemId);
      if (i < 0) return Response.json({ errors: [{ code: 'notFound' }] }, { status: 404 });
      list.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    return Response.json({ errors: [{ code: 'unsupported' }] }, { status: 400 });
  };

  /** What the denylist currently says for a domain on a profile. */
  deny(profileId: string, domain: string): boolean | undefined {
    return this.p(profileId).denylist.find((e) => e.id === domain)?.active;
  }
}
