# Micheal Ray Berry Public Accountability Project — Project Console

An accountability management system: a native Android participant app, an
Accountability Partner (AP) administration portal, and a read-only public record
integrated with michealrayberry.com — all over one **server-authoritative**
backend that owns time, rules, state, and the audit record.

This repository contains a **runnable reference implementation** of the backend,
compliance engine, public API, and the three web surfaces, plus an idiomatic
Android source skeleton for the native client and the full documentation set.

> **Read [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) first** for an honest map
> of what runs today versus what is structured as a native/production target.

## Quick start

```bash
cd server
cp ../.env.example .env      # set JWT_SECRET
npm install
npm run seed                 # demo project, users, sample days
npm run dev                  # http://localhost:3000
npm test                     # 46 tests
```

Then open:

| Surface | URL | Sign in |
|---|---|---|
| Public record | http://localhost:3000/ | — |
| AP portal | http://localhost:3000/portal/ | `ap@michealrayberry.com` / `ap-dev-pass` |
| Participant client | http://localhost:3000/app/ | `participant@michealrayberry.com` / `participant-dev-pass` |
| Public API | http://localhost:3000/public/status | — |

_(Demo credentials are development-only — rotate before production.)_

## The canonical sequence (blueprint §29)

Open today's requirements → capture/submit evidence → receive a **server**
receipt → the AP reviews → verify or deficiency → the official record updates →
the AP publishes → it appears on the public record and the website widget →
every action stays in the audit trail. This full loop is exercised by
`server/test/integration.test.ts`.

## Layout

```
server/            Backend, compliance engine, public API (TypeScript, runnable, tested)
  src/time.ts        Server-authoritative, DST-safe deadline math
  src/stateMachines.ts  Evidence / requirement / violation state machines (§24)
  src/engine.ts      Day generation + deadline sweep (§9)
  src/config.ts      Versioned rule schema + seed configuration (§28)
  src/services/*     Submission, AP review, projects/config, public projection, export
  src/routes/*       /auth /participant /ap /public
  test/*             46 tests incl. the acceptance-criteria sequence
web/
  public-record/     Read-only public site (§14)
  portal/            AP administration portal (§8)
  participant/       Participant web client (runnable stand-in for the native app)
  integration/       Embeddable status widget for michealrayberry.com (§5.5)
android/             Native participant client source skeleton (Kotlin/Compose) — see android/README.md
docs/                Architecture, ERD, API, privacy, deployment, guides, checklists
```

## Design commitments (enforced, not decorative)

- **Server authority** — timeliness is decided by the server's received time;
  the device clock is display-only ([`time.ts`](server/src/time.ts)).
- **Evidence before status** — no completion checkbox bypasses evidence (§3.3).
- **Authority boundaries** — participants can't verify their own evidence,
  dismiss violations, or edit AP rulings (`requireRole`, tested).
- **Public/private separation** — nothing is public until the AP publishes it;
  the public API structurally cannot return a private row.
- **No silent history edits** — activated configs are immutable; corrections
  preserve originals; every material action is audit-logged.
- **Restrained, official design** — near-black/white/gray + one accent, status
  shown by text **and** icon (never color alone); none of the prohibited
  gamified/decorative elements in §23.

## Documentation

[Architecture](docs/ARCHITECTURE.md) ·
[ERD](docs/ERD.md) ·
[API](docs/API.md) ·
[Assumptions & scope](docs/ASSUMPTIONS.md) ·
[Privacy](docs/PRIVACY.md) ·
[Data retention](docs/DATA_RETENTION.md) ·
[Deployment / backup / restore](docs/DEPLOYMENT.md) ·
[Participant guide](docs/PARTICIPANT_GUIDE.md) ·
[AP guide](docs/AP_GUIDE.md) ·
[Release & Play checklists](docs/RELEASE_CHECKLIST.md)
