# Architecture

Project Console is a three-surface accountability system over one authoritative
backend. The backend owns time, rules, state, and the audit record; every
surface is a projection of it.

## Component map

```
                          ┌───────────────────────────────────────────┐
                          │              Backend (server/)              │
                          │                                             │
  Participant  ──HTTPS──▶ │  /auth        JWT login (role from DB)      │
  (Android /              │  /participant Today, submit, notices        │
   web/participant)       │  /ap          Review, deficiency, violation │
                          │  /public      Read-only projection          │
  Accountability ─HTTPS─▶ │                                             │
  Partner (web/portal)    │  ┌────────────────────────────────────┐    │
                          │  │ Compliance engine (server-authoritative)│ │
  Public viewers ─HTTPS─▶ │  │  time.ts  · state machines · engine.ts │ │
  (web/public-record,     │  │  services/{submission,review,projects, │ │
   michealrayberry.com    │  │            publicRecord}               │ │
   via status-widget.js)  │  └────────────────────────────────────┘    │
                          │  audit trail (append-only)                  │
                          │  SQLite (better-sqlite3)  ← Firestore in prod│
                          │  scheduled deadline sweep (setInterval / CF)│
                          └───────────────────────────────────────────┘
```

## Layers (backend)

| Layer | Files | Responsibility |
|-------|-------|----------------|
| HTTP | `src/routes/*`, `src/app.ts` | Auth guards, request/response, role enforcement |
| Auth | `src/auth.ts` | JWT issue/verify; **role re-read from DB per request** |
| Services | `src/services/*` | Business transactions (submission, review, projects, public projection) |
| Engine | `src/engine.ts`, `src/time.ts`, `src/stateMachines.ts` | Day generation, deadline sweep, timeliness, transitions |
| Config | `src/config.ts` | Versioned rule schema + seed |
| Persistence | `src/db.ts` | Schema + connection |
| Audit | `src/audit.ts` | Append-only event log |

## Key invariants (enforced in code)

1. **Server authority.** All deadline/timeliness math is in `time.ts` and runs
   server-side. `evaluateTimeliness` accepts only trusted instants
   (`serverReceivedAt`, server `now`). No endpoint accepts a client timestamp
   that affects timeliness. → acceptance #6, #19.
2. **Evidence before status.** A requirement reaches `SUBMITTED` only through a
   service that first creates an evidence/link/weight record. → §3.3.
3. **Explicit state machines.** `transition()` throws on any edge not in the
   map, so records can't skip required steps. → §24.
4. **Authority boundaries.** Verify / deficiency / violation live behind
   `requireRole('AP')`. The participant has no route to them. → acceptance #7.
5. **Public/private separation.** The public projection (`services/publicRecord.ts`)
   only ever queries `publicStatus IN ('PUBLIC','UNLISTED')` and strips ids,
   emails, hashes, storage paths, AP identity. → acceptance #15, #16.
6. **Configuration immutability.** Activated configs are never edited in place;
   each project day binds the config in force when created, so later
   activations never rewrite history. → acceptance #13, #14.
7. **No silent auto-consequence.** The deadline sweep marks MISSED/LATE and
   opens notices but never assesses a violation; only the AP does. → §9.2.

## Request flow: the canonical sequence (§29)

1. `GET /participant/today` → engine ensures the project day + requirement
   instances for the server-computed local date; returns the live deadline.
2. `POST /participant/evidence` → evidence record created `READY_FOR_REVIEW`,
   requirement → `SUBMITTED`, **server stamps the receipt**, audit event written.
3. Scheduled sweep flips late/missed states as deadlines pass.
4. `POST /ap/evidence/:id/verify` (or `/ap/deficiencies`) → AP determination;
   requirement → `VERIFIED` or `DEFICIENT`; day status recomputed; audit event.
5. `POST /ap/publish` → record `publicStatus = PUBLIC`.
6. `GET /public/*` and the website widget now surface it.
7. Every step above is queryable in `/ap/audit`.

## Production mapping (Firebase)

- Tables → Firestore collections (same field names, see ERD).
- `requireRole` + service checks → Firestore/Storage security rules +
  callable Cloud Functions that re-validate every transition server-side.
- `setInterval` sweep → a scheduled Cloud Function.
- Local storage paths → Cloud Storage with short-lived signed URLs; raw,
  processed, thumbnail, export, and public-media buckets kept separate (§13.3).
- FCM for the notice/notification schedule already modeled in `notices`.
