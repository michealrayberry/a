# Implementation Assumptions & Scope

Per the blueprint's final directive (§29.8): "Document every assumption in an
implementation-assumptions file." This document also states honestly what is
**built and running** versus what is **structured for a native/production
target** so nobody mistakes design for delivery.

## What is fully implemented and runs (with tests)

The **backend, compliance engine, and public API** in `server/` are a complete,
runnable reference implementation:

- Role-based authentication (JWT; role re-read from the trusted DB on every
  request — never from the token or a hardcoded email).
- Versioned, immutable project **configuration** with explicit AP activation.
- **Server-authoritative** deadline math (timezone/DST-safe via Luxon).
- The three required **state machines** (evidence, requirement, violation) with
  illegal transitions rejected at a single choke point.
- Project-day generation, requirement instantiation, and the scheduled
  **deadline sweep** (marks MISSED / LATE, opens notices, never auto-assesses a
  discretionary consequence).
- Participant submission (evidence, weight, external links) with a trusted
  server receipt time.
- AP determinations: verify, deficiency, violation (with consequence-table
  validation + explicit-override audit), publish/withhold.
- Append-only **audit trail** on every material action.
- Read-only **public API** that structurally cannot return private rows and
  strips identifying fields.
- A **test suite** (`npm test`, 42 tests) covering deadline/DST math, boundary
  timeliness, state machines, day generation, the end-to-end
  participant→AP→public sequence, and the security/permission checks called out
  in the acceptance criteria.

The three **web surfaces** in `web/` are functional (not mockups): the public
record page, the AP portal (login, dashboard, review queue with verify/
deficiency, violation assessment, audit view), the participant client (today,
submissions, weight, notices), and an embeddable website status widget. They
call the real API.

## What is structured as a native/production target (not built here)

- **`android/`** is an idiomatic Kotlin/Compose source **skeleton** for the
  native participant client. This environment has **no Android SDK/emulator**,
  so it has not been compiled or run. It is real source a developer can open in
  Android Studio, not a claim of a shipped app. The runnable participant flow
  in this repo is the web client under `web/participant/`.
- The blueprint suggests **Firebase** (Firestore/Storage/Functions/FCM). To make
  the whole system runnable locally with zero external services, this reference
  uses **SQLite + Express** instead, preserving every specified capability. A
  Firebase deployment would map collections 1:1 to the tables in
  [`docs/ERD.md`](./ERD.md) and move security rules into Firestore/Storage
  rules. See [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).

## Decisions made where the blueprint left room (per §29 tie-breakers)

1. **Video "upload" is simulated in the reference server.** The participant
   endpoints accept evidence *metadata* (hash, size, capture times) and the
   server stamps the trusted `serverReceivedAt`. Actual binary upload, hashing,
   resumable transfer, and overlay processing live in the native client
   (WorkManager) and a media-processing worker; the server contract is the
   receipt + evidence record. Original evidence is always preserved; processing
   failures never auto-classify the participant as noncompliant (§12.4).
2. **`serverReceivedAt` is the only trusted timeliness input.** Client-asserted
   capture times are stored for the audit trail but never decide timeliness
   (acceptance #6, #19).
3. **Consequences are never auto-charged.** Violations record an amount + due
   date + payment status only. Payment processing is explicitly deferred (§7.16,
   §22).
4. **Publication is opt-in per record.** Nothing is public until the AP sets its
   `publicStatus` to PUBLIC/UNLISTED. The public API only ever selects those.
5. **"Immutable" is honest.** Activated configurations and submitted evidence
   are treated as append-only *by the service layer and audit trail*; we do not
   claim the database is cryptographically tamper-proof (prohibited design
   choice §23). The audit log records every state change instead.
6. **Seed values are demonstration-only** (start/goal weight, deadlines,
   consequence table). They must be compared against the controlling signed
   agreement and explicitly approved by the AP before production activation
   (§28). No contract terms were invented as authoritative.
7. **Weekly schedule** is encoded as `WEEKLY:<luxon-weekday>` (7 = Sunday) in
   configuration; daily as `DAILY`. This is an extension point for richer
   recurrence without code changes.

## Known limitations of the reference (post-MVP / out of scope §22)

Direct YouTube/X publishing, automatic payment collection, AI visual compliance
judgments, livestreaming, push notification *delivery* (the notice records and
schedule are modeled; FCM wiring is documented, not sent), malware scanning, and
iOS are intentionally not implemented. Extension points exist; none are faked as
working.
