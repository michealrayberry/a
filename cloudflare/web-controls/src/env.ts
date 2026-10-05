/**
 * Worker bindings. Everything here is configured in the Accountability
 * Partner's Cloudflare account (wrangler.toml vars + `wrangler secret put`).
 *
 * NEXTDNS_API_KEY is a Worker *secret*: it exists only server-side, is never
 * returned by any route, and is never sent to the browser.
 */
export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  /** Secret. NextDNS API key from the AP-owned NextDNS account. */
  NEXTDNS_API_KEY?: string;
  /** NextDNS profile id used by the Pixel's Android Private DNS hostname. */
  NEXTDNS_PROFILE_RAY_PIXEL?: string;
  /** NextDNS profile id configured as the Google Nest Wifi DNS. */
  NEXTDNS_PROFILE_HOME_ROUTER?: string;

  /** Cloudflare Access team domain, e.g. "mrb-ap.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag. */
  ACCESS_AUD?: string;
  /** Comma-separated emails with the AP role. */
  AP_EMAILS?: string;
  /** Comma-separated emails with the PARTICIPANT role. */
  PARTICIPANT_EMAILS?: string;

  /** Hostname suffix the phone resolves for server-verified canary checks. */
  CANARY_SUFFIX?: string;
  /** Secret, optional. POST target for AP alerts (ntfy, Slack, Discord, ...). */
  ALERT_WEBHOOK_URL?: string;

  /** "production" (default) or "development". */
  ENVIRONMENT?: string;
  /** "access" (default). "dev" is honored only when ENVIRONMENT=development on localhost. */
  AUTH_MODE?: string;
}
