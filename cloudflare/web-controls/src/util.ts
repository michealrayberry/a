/** Small shared helpers: clock, ids, hashing, domain validation. */

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export const iso = (d: Date): string => d.toISOString();
export const addMinutes = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000);
export const minutesBetween = (a: string | Date, b: string | Date): number =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyz';
export function randomString(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += ALPHA[b % ALPHA.length];
  return out;
}
export const newId = (prefix: string): string => `${prefix}_${randomString(20)}`;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison for secrets/hashes. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

/** Normalize user input like "https://www.Reddit.com/r/x" -> "www.reddit.com". */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0]!.split('?')[0]!.split('#')[0]!;
  d = d.replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) throw new HttpError(400, 'invalid_domain', `"${input}" is not a valid domain`);
  return d;
}

/** True if `a` equals `b` or is a subdomain of it. NextDNS list entries match subdomains. */
export const domainCovers = (parent: string, child: string): boolean =>
  child === parent || child.endsWith(`.${parent}`);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const parseJsonArray = (s: string | null | undefined): string[] => {
  if (!s) return [];
  const v = JSON.parse(s);
  return Array.isArray(v) ? v.map(String) : [];
};
