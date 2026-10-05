/**
 * Authentication for the AP-owned Worker.
 *
 * People: Cloudflare Access (in the AP's Cloudflare Zero Trust account) sits in
 * front of the Worker and forwards a signed JWT in `Cf-Access-Jwt-Assertion`.
 * The Worker independently verifies that JWT (signature, audience, issuer,
 * expiry) — it never trusts an email header on its own. The role comes from
 * the AP-controlled AP_EMAILS / PARTICIPANT_EMAILS vars, never from the client.
 *
 * Devices: the phone heartbeat uses a per-device bearer token (hash stored in
 * D1, raw token shown to the AP once). See integrity.authenticateDevice.
 */
import type { Env } from './env.js';
import type { Actor } from './audit.js';
import { HttpError } from './util.js';

export type Role = 'AP' | 'PARTICIPANT';

export interface Principal {
  email: string;
  role: Role;
  actor: Actor;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

let jwksCache: { domain: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60_000;

async function getKeys(teamDomain: string, fetchFn: typeof fetch, forceRefresh = false): Promise<Jwk[]> {
  if (!forceRefresh && jwksCache && jwksCache.domain === teamDomain && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS)
    return jwksCache.keys;
  const res = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, 'access_keys_unavailable');
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { domain: teamDomain, keys: body.keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

/** Test hook. */
export function resetJwksCache() {
  jwksCache = null;
}

const b64urlDecode = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

export async function verifyAccessJwt(
  token: string,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'>,
  nowMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ email: string }> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) throw new HttpError(503, 'access_not_configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'invalid_token');
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'invalid_token');

  let keys = await getKeys(team, fetchFn);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(team, fetchFn, true); // key rotation
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new HttpError(401, 'invalid_token');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new HttpError(401, 'invalid_token');

  const now = Math.floor(nowMs / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new HttpError(401, 'invalid_token');
  if (payload.iss !== `https://${team}`) throw new HttpError(401, 'invalid_token');
  if (!payload.exp || payload.exp < now - 30) throw new HttpError(401, 'token_expired');
  if (payload.nbf && payload.nbf > now + 30) throw new HttpError(401, 'invalid_token');
  if (!payload.email) throw new HttpError(403, 'no_identity');
  return { email: payload.email.toLowerCase() };
}

const emailList = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function roleFor(env: Env, email: string): Role {
  const ap = emailList(env.AP_EMAILS).includes(email);
  const participant = emailList(env.PARTICIPANT_EMAILS).includes(email);
  // One identity, one role. An email in both lists is a misconfiguration and
  // must never silently grant the participant AP authority.
  if (ap && participant) throw new HttpError(403, 'role_conflict');
  if (ap) return 'AP';
  if (participant) return 'PARTICIPANT';
  throw new HttpError(403, 'not_authorized');
}

export async function authenticatePerson(
  request: Request,
  env: Env,
  nowMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<Principal> {
  const url = new URL(request.url);
  if (env.AUTH_MODE === 'dev') {
    // Local development only: refuses to run unless explicitly in development
    // AND served from localhost, so a misconfigured deploy cannot use it.
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (env.ENVIRONMENT !== 'development' || !local) throw new HttpError(500, 'dev_auth_refused');
    const email = (request.headers.get('X-Dev-User') ?? url.searchParams.get('as') ?? '').toLowerCase();
    const role = roleFor(env, email);
    return { email, role, actor: { type: role, id: email } };
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'unauthenticated');
  const { email } = await verifyAccessJwt(token, env, nowMs, fetchFn);
  const role = roleFor(env, email);
  return { email, role, actor: { type: role, id: email } };
}
