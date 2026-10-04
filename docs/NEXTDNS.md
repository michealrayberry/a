# NextDNS / Web Controls

NextDNS is a core part of the accountability system, not an optional add-on.
This document covers the authority model, the architecture, what has been built
in each phase, how to set it up on the current hardware, and the loopholes that
remain open.

**Scope:** DNS filtering, visibility, approval, integrity monitoring, and
auditability on devices and networks the participant owns, all by consent. This
module will not be expanded into HTTPS interception, credential or banking-data
capture, keylogging, message interception, covert camera or microphone use,
software installation, or access to anyone else's devices or networks.

## Authority model

| Who | Controls |
|---|---|
| **AP** | The Cloudflare account hosting the portal and backend, the NextDNS account, the NextDNS API key, every web-control policy decision |
| **Participant (Micheal)** | Physical control of the Pixel, including emergency access. Can view restrictions, request temporary access, and withdraw requests. Cannot block, allow, grant, restore, bind profiles, or change filtering settings (`403`, tested). |
| **System** | Automatic expiry of temporary access, restoration of restrictions, and retrying NextDNS writes. Recorded as `actorRole = SYSTEM` and `mode = AUTOMATIC`. |

In short: the AP controls the rules, the participant keeps emergency control of
the device, and any interruption becomes visible and reviewable.

### Project rule (for the controlling agreement)

> Accountability controls must remain enabled and configured as directed by the
> Accountability Partner. Micheal may not disable, replace, circumvent, or
> materially alter an active accountability control without prior AP approval,
> except when reasonably necessary for safety, emergency access, or essential
> device recovery.
>
> Loss of monitoring does not suspend the underlying accountability requirement.
> If monitoring is interrupted, the event is preserved and referred to the AP
> for review.

## Architecture

```
RAY-PIXEL  Android Private DNS ─────────► NextDNS profile "RAY-PIXEL"
Google Nest Wifi DNS (home network) ────► NextDNS profile "HOME-ROUTER"

AP Portal ─► AP-owned backend (Cloudflare Worker target) ─► NextDNS API
NextDNS status/activity ─► backend ─► AP Portal
```

| File | Role |
|---|---|
| `server/src/nextdns/gateway.ts` | The only module that holds the API key or calls NextDNS. Uses `fetch` only, so it runs unchanged in a Worker. Exposes a fixed set of typed operations and has no pass-through method. |
| `server/src/nextdns/model.ts` | Profile definitions, enums, and strict input validation (bare hostnames only: no scheme, path, port, wildcard, or IP). |
| `server/src/services/webControls.ts` | Named operations, reconciliation, the expiry sweep, status and integrity. |
| `server/src/routes/webControls.ts` | `/ap/web-controls/*` (AP) and `/participant/web-controls/*` (participant). |
| `web/portal` → **Web Controls** tab | The AP UI. |
| `web/participant` → **Web access** | Restriction list and access requests. |

### Named operations (no generic API console)

| Operation | Route |
|---|---|
| `getNextDnsStatus()` | `GET /ap/web-controls/status` |
| `getIntegrityStatus()` | `GET /ap/integrity` (also served at `GET /ap/web-controls/integrity`) |
| list controls and pending requests | `GET /ap/web-controls` |
| audit history | `GET /ap/web-controls/history` |
| bind a profile (the id is verified against NextDNS first) | `PUT /ap/web-controls/profiles/:label` |
| selected filtering settings | `PATCH /ap/web-controls/profiles/:label/filtering` |
| `blockDomain()` (domain or NextDNS service id) | `POST /ap/web-controls/block` |
| `allowDomain()` | `POST /ap/web-controls/allow` |
| add a monitored domain (portal-side only; no filtering change) | `POST /ap/web-controls/monitor` |
| remove a control permanently (reason required) | `POST /ap/web-controls/controls/:id/remove` |
| `grantTemporaryAccess()` | `POST /ap/web-controls/controls/:id/grant` |
| `restoreRestriction()` (end access early) | `POST /ap/web-controls/controls/:id/restore` |
| approve, or approve with a different duration | `POST /ap/web-controls/requests/:id/approve` `{minutes?}` |
| deny | `POST /ap/web-controls/requests/:id/deny` |
| run the sweep now | `POST /ap/web-controls/sweep` |

Only three filtering settings can be changed: `safeSearch`,
`youtubeRestrictedMode`, and `blockBypass`. Any other key is rejected.

### Policy of record and reconciliation

`web_controls` is the AP's policy of record, and NextDNS is reconciled to match
it. A failed NextDNS write never makes the database misreport what is enforced.
Instead:

- The control is marked `SYNC_FAILED` with the error, and the failure is audited
  **once** (not on every retry).
- The sweep retries every pass until NextDNS matches, then audits
  `NEXTDNS_SYNC_RECOVERED`.
- Integrity reads `DEGRADED`, and the portal shows the sync error on the control.
- If the policy changes while a NextDNS call is in flight, the control stays
  `PENDING` and the next pass applies the newer state.

### Temporary access

1. The participant requests access with a service, a duration, and a required
   reason. Only one request per control can be pending at a time.
2. The AP chooses **Approve**, **Approve w/ different duration**, or **Deny**.
   The AP can also grant access directly without a request.
3. The backend deactivates the denylist or service entry. The entry is kept
   rather than deleted, so restoring it is a single flag flip.
4. The sweep runs every 30 s locally (`WEB_CONTROL_SWEEP_MS`); on the Cloudflare
   target it runs on a one-minute Cron Trigger. When access expires, the sweep
   reactivates the restriction and audits:
   `Temporary access expired. Reddit restriction restored.` (SYSTEM / AUTOMATIC)
5. If NextDNS is down at expiry, the **policy** returns to BLOCKED immediately,
   and the NextDNS write keeps retrying until it succeeds (see above).

Durations are limited to 1–1440 minutes, and a control can have only one active
grant (enforced by a unique index).

### Audit

Every action writes to `audit_events` with the timestamp, actor, actor role,
action, target, previous state, new state, a readable reason, and `mode`
(`MANUAL` or `AUTOMATIC`). `audit_events` is now **append-only at the database
layer**: SQLite triggers abort any `UPDATE` or `DELETE`. This protects the whole
system, not only this module.

### Status vocabulary: missing DNS activity is not misconduct

| Per profile | Meaning |
|---|---|
| `REPORTING` | NextDNS logged a query within 30 minutes |
| `NO_RECENT_ACTIVITY` | No query within 30 minutes. This is informational: the device may be asleep, offline, or idle. |
| `UNVERIFIED` | The NextDNS API could not be reached |
| `NOT_CONFIGURED` | The profile is not bound, or there is no API key |

These per-profile states feed the integrity status. `INTERRUPTED` requires a
positive report from the phone's heartbeat that Private DNS is off or wrong;
DNS silence alone never produces it. See Phase 5 below.

### Router vs. Pixel

`RAY-PIXEL` is `PARTICIPANT_DEVICE`. `HOME-ROUTER` is `SHARED_NETWORK` and is
labelled in the UI as *"HOME NETWORK ACTIVITY · shared — not attributable to
Micheal"*. Phone-specific accountability should use RAY-PIXEL.

## Phase status

| Phase | Status |
|---|---|
| 1. Foundation: server-side integration, credential handling, profile records, status, portal module, audit | **Built and tested** |
| 2. Policy controls: denylist, allowlist, monitored domains, selected filtering settings | **Built and tested** |
| 3. Temporary access: requests, approve, approve with a different duration, deny, timed access, automatic restoration | **Built and tested** |
| 4. Activity: blocked events, monitored-domain events, visibility modes, router vs. Pixel separation | Not built. Planned design is below. |
| 5. Integrity: phone heartbeat, NextDNS health checks, interruption and restoration incidents, AP integrity dashboard | **Built and tested** (server and web). Android heartbeat source written but not compiled here. |

### Phase 4 design

- Proxy NextDNS logs per profile on demand rather than bulk-copying them into
  the database.
- Add an AP-set, audited `activityVisibility` with three values:
  `BLOCKED_EVENTS_ONLY` (the recommended default), `MONITORED_DOMAINS`, and
  `ALL_DOMAINS`. Filter on the server, so the browser never receives entries
  outside the selected mode.
- Label every DNS event as a *signal*, never as proof of deliberate use:
  `doordash.com contacted` is not the same as "opened DoorDash".

## Phase 5: monitoring integrity

Code: `server/src/services/integrity.ts`, `server/src/routes/integrity.ts`, the
portal's **Integrity** tab, the participant's **Monitoring integrity** section,
and the Android files `integrity/PrivateDnsProbe.kt`, `work/HeartbeatWorker.kt`,
and `work/HeartbeatScheduler.kt`.

### Signals: confirmed vs. circumstantial

| Incident | Trigger | Severity | AP review | Participant notified |
|---|---|---|---|---|
| `PRIVATE_DNS_DISABLED`: *DNS ACCOUNTABILITY INTERRUPTED* | The heartbeat **reports** Private DNS as Off, Automatic, or a hostname that isn't RAY-PIXEL | **INTERRUPTED** | Always | Yes |
| `DNS_HEARTBEAT_MISMATCH` | The heartbeat says compliant and online, but NextDNS logged no RAY-PIXEL query for over 60 minutes | DEGRADED | Always | Yes |
| `PHONE_HEARTBEAT_LOST` | No heartbeat for over 45 minutes (three missed 15-minute beats) | DEGRADED | Only if it lasts 3 hours or more | No |
| `HOME_ROUTER_SILENT` | No HOME-ROUTER query for over 2 hours | DEGRADED | Never (shared network, not attributed) | No |
| `NEXTDNS_API_UNREACHABLE` | The backend cannot reach NextDNS | DEGRADED | Never (this is the AP's own infrastructure) | No |

Only a **positive report from the phone** produces INTERRUPTED. Silence of any
kind produces DEGRADED. A phone that has never sent a heartbeat opens no
incident, and a heartbeat sent while offline (`network: NONE`,
`privateDnsMode: unknown`) changes nothing.

The mismatch check exists because the heartbeat is self-reported: the
participant controls the phone and the session token, so the heartbeat can be
faked. NextDNS's own logs are the independent check. Each heartbeat makes a DNS
lookup for the backend, so a phone that really uses RAY-PIXEL keeps producing
RAY-PIXEL queries. **NextDNS logging must stay enabled** on both profiles, or
the mismatch check will fire.

### Lifecycle (restoration never erases)

`OPEN` → restored → `AP_REVIEW_REQUIRED` or `CLOSED` → `REVIEWED`

Each incident records last verified active, failure detected, restored, the
**interruption** length (from detection to restoration), and the **maximum
window** (from the last verification to restoration). For example: last
verified 8:41 PM, detected 8:46 PM, restored 9:03 PM gives an interruption of
17 minutes and a window of at most 22 minutes.

- **Participant explanation:** one submission per incident, which cannot be
  edited. This is the route for the safety, emergency, and device-recovery
  exceptions in the project rule.
- **AP determination:** `TECHNICAL_FAILURE`, `AUTHORIZED_EXCEPTION`,
  `UNAUTHORIZED_INTERRUPTION`, or `INCONCLUSIVE`, with a required note. Only
  restored incidents can be reviewed, so an open incident cannot be reviewed
  away. An `UNAUTHORIZED_INTERRUPTION` determination does **not** assess a
  consequence automatically; the AP uses the Violations workflow.
- Incidents cannot be deleted (a database trigger enforces this), and every
  transition is in the append-only audit log.

### AP-authorized windows (the "prior AP approval" path)

`POST /ap/integrity/exemptions {component: PRIVATE_DNS | PHONE_HEARTBEAT | ALL,
minutes, reason}` grants a window. An interruption inside a window is **still
recorded**, but it closes without review if it is restored before the window
ends. No participant notice is sent for it. If the window ends first, the
incident needs review as usual. The AP can end a window early.

### Overall status

`INTERRUPTED` (an open confirmed interruption) > `NOT_CONFIGURED` > `DEGRADED`
(any open incident, or any component not healthy) > `RESTORED` (everything is
healthy but incidents await review) > `ACTIVE`.

### Integrity API

| Route | Who |
|---|---|
| `POST /participant/integrity/heartbeat` `{deviceId, privateDnsMode: off\|opportunistic\|hostname\|unknown, privateDnsHost?, network: WIFI\|CELLULAR\|OTHER\|NONE, recordingReady?, appVersion?, clientTime?}` | Participant (the phone app) |
| `GET /participant/integrity` | Participant: own heartbeat and Private DNS state, and incidents |
| `POST /participant/integrity/incidents/:id/explanation` `{explanation}` | Participant, once per incident |
| `GET /ap/integrity` | AP dashboard: overall status, components, incidents, active windows |
| `GET /ap/integrity/incidents` | AP |
| `POST /ap/integrity/incidents/:id/review` `{determination, note}` | AP |
| `POST /ap/integrity/exemptions`, `POST /ap/integrity/exemptions/:id/revoke` | AP |
| `POST /ap/integrity/sweep` | AP (also runs every minute; NextDNS is checked every 5 minutes) |

The first heartbeat from a new `deviceId` is audited
(`PHONE_DEVICE_REGISTERED`), so a switch to a different phone is visible.

## Setup

### First live connection (the AP does all of this)

1. The AP creates the NextDNS account with their own email and password, then
   creates two profiles named `RAY-PIXEL` and `HOME-ROUTER`.
2. The AP generates an API key (NextDNS → Account → API) and stores it as a
   server secret: `NEXTDNS_API_KEY` in the server environment, or
   `wrangler secret put NEXTDNS_API_KEY` on the Worker. It must never go in the
   repository, the browser, or chat.
3. In the portal, open **Web Controls → Bind a profile** and enter each profile
   id. Binding calls NextDNS first and rejects ids that don't exist.
4. **Check the endpoints against the live API.** The NextDNS API reference was
   not reachable while this was built. `gateway.ts` assumes `X-Api-Key`, the
   `{data}` envelope, `PATCH/POST/DELETE /profiles/:id/{denylist,allowlist,
   parentalControl/services}[/:entry]`, `PATCH /profiles/:id/parentalControl`,
   and `GET /profiles/:id/logs?limit=1`. Block a test domain and confirm it
   appears in the NextDNS dashboard before relying on it.

### RAY-PIXEL (Android Private DNS)

Go to Settings → Network & internet → Private DNS → Private DNS provider
hostname → `<RAY-PIXEL-id>.dns.nextdns.io`. This covers both Wi-Fi and cellular.

### HOME-ROUTER (Google Nest Wifi)

In the Google Home app, go to Wi-Fi → Settings → Advanced networking → DNS →
Custom, and enter the IPv4/IPv6 addresses NextDNS shows for the HOME-ROUTER
profile. Nest Wifi uses plain DNS, so NextDNS identifies the profile by the
home's **linked IP**. If the ISP changes the public IP, the link has to be
updated (NextDNS provides a link-IP update URL that the AP can schedule).
When the Pixel is on home Wi-Fi, its Private DNS setting takes precedence, so
the Pixel's traffic goes to RAY-PIXEL.

## Deployment target: Cloudflare (AP-owned)

The runnable reference is the existing Node/Express + SQLite backend. To move it
to the AP's Cloudflare account:

| Reference | Cloudflare |
|---|---|
| `NEXTDNS_API_KEY` env var | Worker secret (`wrangler secret put`) |
| SQLite tables (`nextdns_profiles`, `web_controls`, `web_access_requests`, `web_temporary_grants`, `audit_events`) | D1, same schema and triggers |
| `setInterval` sweep | Cron Trigger `* * * * *` calling `runWebControlSweep` |
| `gateway.ts` | Unchanged (`fetch` only) |
| `webControls.ts` | Port the synchronous `better-sqlite3` calls to D1's async API; the logic stays the same |

**Deployment control matters as much as key custody.** If the participant can
push code that the AP's Worker deploys automatically, the participant can ship
code that removes restrictions or leaks the key. The AP must deploy from the
AP's own Cloudflare account, without auto-deploy from a repository the
participant can push to.

## Known gaps and bypasses

None of these are hidden. The system is designed to detect them, not to make
them impossible.

| Gap | Current control | Recommended next step |
|---|---|---|
| Turning Private DNS off on the Pixel | The heartbeat reports it immediately (network callback) or within 15 minutes, which opens an INTERRUPTED incident | — |
| Faking heartbeats (the participant holds the token) | Cross-checked against NextDNS logs, which raise `DNS_HEARTBEAT_MISMATCH` | Keep NextDNS logging on |
| Signing out of the app, force-stopping it, uninstalling it, or turning off battery-optimization exemption | Heartbeats stop, so the incident is `PHONE_HEARTBEAT_LOST` (DEGRADED), with review after 3 hours | Add an agreement rule: the app stays installed and signed in. Consider a lower review threshold. |
| Doze deferring heartbeats overnight | Tolerated: DEGRADED, and short gaps need no review | Exempt the app from battery optimization |
| Participant is a Google Home admin for Nest Wifi and can change its DNS | None | Make the AP the Nest owner/manager, or accept that changes are detectable once HOME-ROUTER goes quiet |
| VPN, proxy, or a browser's own secure DNS (Chrome/Firefox DoH) | NextDNS `blockBypass` setting, which the AP can toggle | Turn `blockBypass` on for both profiles at launch |
| Retained NextDNS credentials | The AP owns the account, and the key lives only on the server | Confirm the participant has no login, recovery email, or API key for the account |
| Domain blocks miss alternate domains (for example `redd.it`) | Service-id blocks (`reddit`) cover a service's domain set | Prefer service ids where NextDNS has one |
| Simulated mode mistaken for real enforcement | Integration shows `SIMULATED` and the integrity summary says "NOT REAL ENFORCEMENT" | Never set `NEXTDNS_MODE=simulated` in production |
