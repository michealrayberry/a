# NextDNS Web Controls — Architecture, Setup & Operating Rules

NextDNS is a **core** component of the accountability system, not an add-on.
This document covers the authority model, the architecture, what is built, how
the Accountability Partner (AP) deploys it, and the limits of what it can prove.

Code: [`cloudflare/web-controls/`](../cloudflare/web-controls) (Worker, D1 schema,
portal page, tests) and
[`android/.../integrity/`](../android/app/src/main/java/com/michealrayberry/console/integrity)
(phone heartbeat).

---

## 1. Authority model

| Asset | Owner | Participant access |
|---|---|---|
| Cloudflare account (Worker, D1, Access, secrets) | **AP** | None |
| NextDNS account + both profiles | **AP** (AP email, AP password, AP 2FA) | None — no password, no API key |
| NextDNS API key | **AP**, stored only as a Worker secret | Never. Not in the browser, not in git, not in any API response |
| Pixel phone | Participant (physical + emergency control) | Full |
| Google Nest Wifi | Participant (household router) | Full |

**What this produces:** the AP controls the rules. The participant cannot use
retained credentials to quietly remove restrictions, because there are none to
retain. The participant keeps physical control of the phone and router (safety,
emergency access, device recovery), so the design goal is that any interruption
or bypass **becomes a visible, preserved accountability event**. It is not
designed to make bypass technically impossible.

The participant **must not** hold NextDNS dashboard credentials, a NextDNS API
key, or Cloudflare access. If the participant ever had them (e.g. created the
account originally), the AP must change the password, enable 2FA on the AP's own
device, and regenerate the API key. See §7.

## 2. Architecture

```
RAY-PIXEL  Android Private DNS  ──DoT──▶  NextDNS profile "RAY-PIXEL"
Nest Wifi  custom DNS servers   ──DNS──▶  NextDNS profile "HOME-ROUTER"

AP browser ─▶ Cloudflare Access (AP's Zero Trust) ─▶ Worker /api/*  ─▶ NextDNS API
Phone app  ─▶ Worker /api/device/* (device token)                    (X-Api-Key = Worker secret)
Cron (every minute) ─▶ Worker: expire grants · restore restrictions · lapse requests
                               · integrity checks every N minutes (default 5)
Worker ─▶ D1: desired policy, grants, requests, heartbeats, incidents, audit log
```

### Desired-state reconciliation

D1 holds the AP's **desired** policy. One idempotent function
(`reconcileProfile`) makes each live NextDNS profile match it. Every mutation
goes through that one step: block, allow, grant, expiry, archive and filtering.
Consequences:

- **Temporary access and its restoration are just policy changes.** Nothing
  depends on the AP remembering to undo anything.
- **Fail closed.** A grant only counts while `ACTIVE` *and* before `expiresAt`.
  An overdue grant lifts nothing, even if the scheduler is late. If NextDNS
  refuses a grant, it is recorded `APPLY_FAILED` and the restriction is
  re-asserted.
- **Restoration is confirmed, not assumed.** A grant is marked `RESTORED` only
  after NextDNS accepts the change. Otherwise it is retried every minute,
  flagged as an `ENFORCEMENT_FAILURE`, and the AP is alerted.
- **Drift detection.** The Worker records the last state it confirmed for every
  entry it manages. If a managed entry is changed or removed outside the portal
  (for example in the NextDNS dashboard), the next integrity run re-applies AP
  policy and records a `CONFIGURATION_DRIFT` incident for AP review. Entries
  created by hand in the dashboard are never touched.

### Permitted operations (no generic API console)

Routes map one-to-one to named operations:
`blockDomain`, `allowDomain`, `grantTemporaryAccess`, `restoreRestriction`,
`getNextDnsStatus`, `getDnsActivity`, `getMonitoredEvents` and
`getIntegrityStatus`, plus allowlist, monitored-domain, filtering, visibility,
device and incident-review operations. No route accepts a NextDNS path, method
or body, and the test suite asserts that passthrough paths return 404.

### How a "web control" maps to NextDNS

A web control (for example *Reddit*) is a named set of domains, plus an optional
NextDNS parental-control **service id** (for example `reddit`), scoped to one or
both profiles.

| Effective state | NextDNS denylist entries | Parental-control service |
|---|---|---|
| BLOCKED | present, `active: true` | `active: true` |
| TEMPORARILY ALLOWED | present, `active: false` | `active: false` |
| ALLOWED (standing AP policy) | present, `active: false` | `active: false` |
| Removed (archived) | deleted | deleted |

NextDNS denylist entries also match subdomains. NextDNS **allowlist** entries
override everything, so the portal refuses any allowlist entry that overlaps a
controlled domain, in either direction. Time-limited access goes through
temporary access instead.

## 3. Implementation status

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Server-side NextDNS client, Worker secret, HOME-ROUTER/RAY-PIXEL records, status, portal module, audit trail | **Built + tested** |
| 2 Policy controls | Denylist (web controls), allowlist, monitored domains, SafeSearch / YouTube Restricted Mode / block-bypass / 5 categories | **Built + tested** |
| 3 Temporary access | Requests, approve / approve-different-duration / deny, timed grants, automatic restoration, early end, lapse | **Built + tested** |
| 4 Activity | Three visibility modes, blocked/monitored events, Pixel vs home separation, IP stripping, view auditing | **Built + tested** against a fake NextDNS. Response field names must be confirmed live (§8) |
| 5 Integrity | Phone heartbeat + canary, NextDNS health, interruption/gap/restoration incidents, AP review, dashboard | **Worker built + tested.** Android worker is source only (no SDK in this environment; not compiled) |

`npm test` in `cloudflare/web-controls` runs 53 tests. The Worker also runs
under `wrangler dev` (real workerd runtime and local D1, including the
append-only triggers).

## 4. Integrity semantics

### Component status

| Status | Meaning |
|---|---|
| **ACTIVE** | Confirmed working |
| **DEGRADED** | Insufficient information, or one component not reporting |
| **INTERRUPTED** | Monitoring confirmed unavailable or disabled |
| **RESTORED** | Reporting resumed after an interruption; AP review pending |
| **UNKNOWN** | Not configured / never verified |

### What counts as confirmed (INTERRUPTED) vs not (DEGRADED)

Missing DNS traffic alone **never** produces INTERRUPTED. A sleeping, offline or
powered-off phone is DEGRADED. RAY-PIXEL becomes INTERRUPTED only on positive
evidence from a fresh heartbeat while the phone is connected:

- Android reports Private DNS **off**;
- Private DNS points to a hostname that is not the RAY-PIXEL profile;
- `test.nextdns.io` reports no NextDNS, or a different profile;
- **two consecutive** server-verified canary lookups never reached RAY-PIXEL's
  log.

A bad report is overridden if DNS is verified through RAY-PIXEL **after** it.
NEXTDNS_API is INTERRUPTED only when NextDNS rejects the AP's key. A failed
restoration makes POLICY_ENFORCEMENT INTERRUPTED. HOME-ROUTER has no phone-side
confirmation, so silence there is only ever DEGRADED, and a `REPORTING_GAP`
opens after the AP-set threshold.

### The canary

Each heartbeat starts by asking the Worker for a one-time nonce. The phone
resolves `<nonce>.hb.michealrayberry.com` through the system resolver, which is
whatever Private DNS is actually in effect. One to ten minutes later, the Worker
searches RAY-PIXEL's NextDNS log for that exact name. Finding it is
**server-side** evidence that the phone's DNS goes through the AP's profile. The
hostname does not need to resolve: NXDOMAIN is still logged.

### Incidents

- Opened only for components that have been verified ACTIVE at least once, so
  setup does not create noise.
- `INTERRUPTION` opens immediately on INTERRUPTED. `REPORTING_GAP` opens after
  DEGRADED has persisted for the threshold (Pixel 120 min and home 60 min by
  default; the AP can change both).
- Each incident records **last verified active**, **failure detected**,
  **restored** and **interruption minutes** (restored − detected).
- **Restoration does not erase the incident.** It moves to RESTORED ("AP
  REVIEW REQUIRED") and can only be closed by an AP review with a disposition
  and a note: technical cause, authorized/safety/emergency, acknowledged, or
  referred for violation review.
- Database triggers block deleting incidents, changing detection facts,
  re-opening, and any edit after review. The audit log rejects UPDATE and
  DELETE.
- No incident is labeled misconduct. The system refers incidents to the AP; it
  does not judge them.

## 5. DNS activity and privacy

| Mode | What the portal returns |
|---|---|
| **BLOCKED EVENTS ONLY** (default) | Queries NextDNS blocked. NextDNS is asked for `status=blocked`, so other lookups never enter the Worker |
| **MONITORED DOMAINS** | Blocked queries plus queries matching monitored domains or controlled services |
| **ALL DOMAINS** | All available DNS activity |

- The default is the narrowest mode. Widening it requires an AP action **with a
  reason** and is audited with the previous and new value.
- Every AP view of activity is itself audited, so the participant can see in
  the audit history when activity was viewed and in which mode.
- Client IP addresses are stripped server-side. Only the domain, time, status,
  block reason and NextDNS device name are returned.
- Every activity page carries this notice: **DNS events are accountability
  signals, not proof of deliberate use.** Apps and the OS make background
  lookups. DNS reveals domain names only — not page contents, passwords,
  balances, transactions, card numbers or messages.
- **HOME NETWORK ACTIVITY** is visually distinct (purple rule) and labeled: it
  may come from computers, TVs, streaming and smart-home devices or guests, and
  is *not attributed to Micheal personally*. **RAY-PIXEL ACTIVITY** (blue rule)
  is the phone-specific source.
- The participant role cannot read DNS activity at all. It can see controls,
  requests, integrity status, incidents and the full audit history.

## 6. Security boundary

In scope: **filtering + visibility + approval + integrity monitoring +
auditability.**

Out of scope, and not present in the code: HTTPS interception or decryption,
credential or password capture, banking-data retrieval, keylogging, message
interception, covert camera or microphone use, installing software, and access
to devices or networks the participant does not own or control. The phone
heartbeat reads only the network type, Android's Private DNS state, the
`test.nextdns.io` result and the canary lookup.

Other controls:

- Cloudflare Access JWTs are verified in the Worker (RS256 signature, audience,
  issuer, expiry).
- Roles come from AP-controlled vars. An email listed as both AP and
  participant is refused.
- CSRF: mutations require JSON and a same-origin request.
- CSP `script-src 'self'`; all rendered data is HTML-escaped (domain names come
  from DNS traffic and are treated as untrusted).
- Device tokens are stored only as SHA-256 hashes, shown once, and revocable.
- Dev auth refuses to run unless `ENVIRONMENT=development` **and** the request
  is to localhost.

## 7. AP setup runbook

**A. NextDNS (AP-owned)**
1. Create a NextDNS account with the **AP's** email. Enable 2FA on the AP's
   device.
2. Create two profiles, named **RAY-PIXEL** and **HOME-ROUTER**. Note each
   profile ID (six characters, e.g. `abc123`).
3. On both profiles, under Settings → Logs, **enable logs** (integrity and
   activity depend on them) and choose a retention period consistent with
   `docs/DATA_RETENTION.md`. Leave "log client IPs" off if the AP does not need
   them. The Worker strips them regardless.
4. Account → API: generate the API key. It goes **only** into
   `wrangler secret put` (step B4).

**B. Cloudflare (AP-owned)**
1. `cd cloudflare/web-controls && npm install`
2. `npx wrangler d1 create web-controls`, then put the returned id in
   `wrangler.toml` (`database_id`).
3. `npm run db:migrate:remote`
4. `npx wrangler secret put NEXTDNS_API_KEY` (and optionally
   `ALERT_WEBHOOK_URL`, e.g. an ntfy topic or a Slack/Discord webhook).
5. In `wrangler.toml` `[vars]`, set the two profile IDs, `AP_EMAILS`,
   `PARTICIPANT_EMAILS` and `CANARY_SUFFIX`.
6. `npm run deploy`, then attach a custom domain (e.g.
   `ap.michealrayberry.com`).
7. Zero Trust → Access → add a **self-hosted application** for that hostname.
   Policy: allow the AP's and the participant's emails, with one-time PIN or a
   stronger IdP. Copy the **AUD tag** into `ACCESS_AUD` and the team domain
   into `ACCESS_TEAM_DOMAIN`, then redeploy.
8. Add a second Access application for `ap.michealrayberry.com/api/device/*`
   with a **Bypass** policy. The phone authenticates with its device token
   instead.

**C. Pixel (RAY-PIXEL)**
1. Settings → Network & internet → Private DNS → **Private DNS provider
   hostname**: `<RAY-PIXEL id>.dns.nextdns.io` (optionally prefixed with a
   device name: `ray--pixel-<id>.dns.nextdns.io`).
2. Install the Console app built with `-PwebControlsBaseUrl=https://ap.michealrayberry.com/`.
3. AP Portal → Devices → **Issue heartbeat token**. Enter it in the app (Project
   tab → Accountability heartbeat).
4. Exempt the app from battery optimization so heartbeats are not deferred for
   hours.

**D. Google Nest Wifi (HOME-ROUTER)**
1. Google Home app → Wi-Fi → Settings → Advanced networking → DNS → **Custom**:
   enter the HOME-ROUTER profile's DNS server addresses from the NextDNS
   **Setup** tab (Linked IP section). In the same tab, link the home IP to the
   HOME-ROUTER profile.
2. Plain-DNS IPv4 resolvers identify the profile by **Linked IP**. If the home
   IP changes and is not re-linked, HOME-ROUTER stops reporting and a
   `REPORTING_GAP` opens. Keep the link current with NextDNS's link-IP update
   URL, called periodically from a device on the home network. Where IPv6 is
   available, the profile-specific IPv6 resolver addresses avoid this.
3. Nest Wifi does not support DoH/DoT on the router itself. Devices that set
   their own DNS bypass the router profile, which is why the Pixel uses its own
   Private DNS profile.

**E. First verification**
Portal → Overview → **Run integrity checks now**. Every component should reach
ACTIVE ("ALL SYSTEMS REPORTING"). Recording Assistant shows UNKNOWN until it is
integrated, and does not count against the rollup.

## 8. Go-live checks (cannot be verified from this environment)

This build environment's network policy blocked the NextDNS documentation and
API, so the client was written against the documented v1 API from knowledge
and tested against a faithful fake. Before relying on it:

1. Confirm these endpoints and shapes against https://nextdns.github.io/api/:
   `GET /profiles/:id` (`denylist`, `allowlist`, `parentalControl.{services,
   categories,safeSearch,youtubeRestrictedMode,blockBypass}`); child-array
   `POST`/`PATCH /:id`/`DELETE /:id`; `GET /profiles/:id/logs` params
   (`from`, `limit` 10–1000, `status`, `search`, `cursor`) and entry fields
   (`timestamp`, `domain`, `root`, `status`, `reasons`, `device`). All of it
   lives in `src/nextdns.ts`, so any correction is local to that file.
2. Confirm the category ids in `MANAGED_CATEGORIES` (`porn`, `gambling`,
   `dating`, `piracy`, `social-networks`) and any service ids you use (e.g.
   `reddit`).
3. Confirm `https://test.nextdns.io` returns JSON `{status, profile}` to the
   phone.
4. Using the AP's account, block a test domain from the portal and check it in
   the NextDNS dashboard. Grant 2 minutes, then confirm restoration in the
   dashboard and in the audit history.
5. Turn Private DNS off on the Pixel for 20 minutes. Confirm an INTERRUPTION
   incident, then RESTORED with the correct minutes after it is turned back on,
   then record an AP review.

## 9. Known limitations (stated plainly)

- **Detection, not prevention.** The participant can switch off Private DNS,
  reset the router, uninstall the app or restrict it, or factory-reset the
  phone. Each of these shows up as an interruption or a reporting gap. None is
  prevented.
- The heartbeat is **self-reported**, apart from the canary. A determined
  participant holding the device token could forge heartbeats and even query
  the canary via RAY-PIXEL from another machine. That takes deliberate
  circumvention, which the project rule already covers. The AP can revoke and
  re-issue tokens at any time.
- **Restoration timing.** Expiry runs on a one-minute cron, so restoration
  happens within about 60 seconds of `expiresAt`. Already-open connections and
  cached DNS answers (typically minutes) can outlast a re-block.
- DNS filtering does not see inside apps that use hard-coded DNS-over-HTTPS or a
  VPN. NextDNS **block bypass** (Policy → Filtering) blocks many such methods.
- Home attribution is never personal. Only RAY-PIXEL is phone-specific.

## 10. Project rule this system supports

> Accountability controls must remain enabled and configured as directed by the
> Accountability Partner. Micheal may not disable, replace, circumvent, or
> materially alter an active accountability control without prior AP approval,
> except when reasonably necessary for safety, emergency access, or essential
> device recovery.
>
> Loss of monitoring does not suspend the underlying accountability requirement.
> If monitoring is interrupted, the event is preserved and referred to the AP
> for review.

Both statements are displayed on the portal's Accountability System panel and
stored with every integrity incident.
