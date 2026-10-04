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
| `getIntegrityStatus()` | `GET /ap/web-controls/integrity` |
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

The overall status is `ACTIVE` or `DEGRADED`. **`INTERRUPTED` and `RESTORED`
are reserved for Phase 5.** They need positive confirmation, such as a phone
heartbeat reporting that Private DNS is off. DNS silence alone is never
reported as an interruption. The integrity panel shows "Phone heartbeat" and
"Recording Assistant" as `NOT_IMPLEMENTED` rather than displaying them as
healthy.

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
| 5. Integrity: phone heartbeat, `INTERRUPTED`/`RESTORED` incidents, AP review | Not built. Status vocabulary and UI slots are reserved. |

### Phase 4 design

- Proxy NextDNS logs per profile on demand rather than bulk-copying them into
  the database.
- Add an AP-set, audited `activityVisibility` with three values:
  `BLOCKED_EVENTS_ONLY` (the recommended default), `MONITORED_DOMAINS`, and
  `ALL_DOMAINS`. Filter on the server, so the browser never receives entries
  outside the selected mode.
- Label every DNS event as a *signal*, never as proof of deliberate use:
  `doordash.com contacted` is not the same as "opened DoorDash".

### Phase 5 design

- The Android app posts a signed heartbeat about every 5 minutes that includes
  the Private DNS mode and hostname (readable through
  `Settings.Global "private_dns_mode"/"private_dns_specifier"`).
- An incident opens only when the heartbeat confirms Private DNS is off or
  changed. It records last verified, failure detected, restored, and duration,
  with status `AP REVIEW REQUIRED`. Restoration closes the incident but never
  deletes it.

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
| Turning Private DNS off on the Pixel | None until the Phase 5 heartbeat. DNS silence alone is not proof. | Build the Phase 5 heartbeat first. It is the only confirmation signal. |
| Participant is a Google Home admin for Nest Wifi and can change its DNS | None | Make the AP the Nest owner/manager, or accept that changes are detectable once HOME-ROUTER goes quiet |
| VPN, proxy, or a browser's own secure DNS (Chrome/Firefox DoH) | NextDNS `blockBypass` setting, which the AP can toggle | Turn `blockBypass` on for both profiles at launch |
| Cellular data with Private DNS off | Same as the first row | Phase 5 |
| Retained NextDNS credentials | The AP owns the account, and the key lives only on the server | Confirm the participant has no login, recovery email, or API key for the account |
| Domain blocks miss alternate domains (for example `redd.it`) | Service-id blocks (`reddit`) cover a service's domain set | Prefer service ids where NextDNS has one |
| Simulated mode mistaken for real enforcement | Integration shows `SIMULATED` and the integrity summary says "NOT REAL ENFORCEMENT" | Never set `NEXTDNS_MODE=simulated` in production |
