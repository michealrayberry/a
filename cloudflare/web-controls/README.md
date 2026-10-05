# Web Controls Worker (NextDNS)

AP-owned Cloudflare Worker behind the AP Portal's **WEB CONTROLS** section:
NextDNS policy (block / allow / allowlist / monitored domains / filtering),
temporary access with automatic restoration, DNS activity with AP-selected
visibility, monitoring-integrity incidents, and an append-only audit trail.

Full design, setup runbook, go-live checks and limitations:
**[docs/NEXTDNS.md](../../docs/NEXTDNS.md)**.

```
src/
  index.ts        fetch + scheduled (cron every minute)
  routes.ts       explicit routes → named operations (no NextDNS passthrough)
  operations.ts   blockDomain, allowDomain, grantTemporaryAccess, restoreRestriction,
                  getNextDnsStatus, getDnsActivity, getMonitoredEvents, getIntegrityStatus
  controls.ts     web controls, allowlist, monitored domains, desired-state reconcile + drift
  access.ts       requests, grants, expiry, confirmed restoration, request lapse
  activity.ts     visibility modes, IP stripping, Pixel vs home labeling
  integrity.ts    heartbeat, canary verification, component evaluation, incidents, AP review
  auth.ts         Cloudflare Access JWT verification + role mapping
  nextdns.ts      the only code that talks to api.nextdns.io (key = Worker secret)
  audit.ts        append-only audit log
migrations/       D1 schema (append-only + immutability triggers)
public/           portal page (index.html + app.js)
test/             53 tests: D1 shim over SQLite running the real migrations + fake NextDNS
```

```bash
npm install
npm test            # 53 tests
npm run typecheck
npm run dev         # local Worker + local D1 at http://localhost:8787/?as=ap@example.test
                    # (dev auth: localhost + ENVIRONMENT=development only)
```

Production deploys come **only** from the Accountability Partner's Cloudflare
account. `NEXTDNS_API_KEY` is set with `wrangler secret put` and never committed.
