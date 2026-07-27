# Deployment, Backup & Restore

## Local development

```bash
cd server
cp ../.env.example .env      # then edit JWT_SECRET etc.
npm install
npm run seed                 # creates project-console.db with demo data
npm run dev                  # http://localhost:3000
npm test                     # 42 tests
```

Surfaces once running:

- Public record: `http://localhost:3000/`
- AP portal: `http://localhost:3000/portal/`
- Participant web client: `http://localhost:3000/app/`
- Public API: `http://localhost:3000/public/status`

Demo credentials (development only — rotate before production):
`participant@michealrayberry.com` / `participant-dev-pass`,
`ap@michealrayberry.com` / `ap-dev-pass`.

## Production (reference: Node service)

1. Provision a Node 20+ host (Cloud Run, Fly.io, a container, etc.).
2. Set environment variables (see `.env.example`) — **`JWT_SECRET` must be a
   strong random value** and never committed.
3. Put the service behind TLS and a reverse proxy. Restrict `/participant` and
   `/ap` to the app/portal origins; `/public` may be open.
4. Point a durable volume (or managed Postgres via a driver swap) at `DB_PATH`.
5. Run the scheduled deadline sweep. Built in via `SWEEP_INTERVAL_MS`; in a
   serverless setup use an external scheduler hitting `POST /ap/deadline-sweep`
   with a service credential instead.

## Production (blueprint target: Firebase)

The reference maps directly onto the blueprint's suggested stack:

| Reference | Firebase |
|---|---|
| SQLite tables | Firestore collections (same field names, see ERD) |
| `requireRole` + service checks | Firestore/Storage security rules + callable Cloud Functions that re-validate every transition |
| local storage paths | Cloud Storage: separate raw / processed / thumbnail / export / public buckets, short-lived signed URLs |
| `setInterval` sweep | scheduled Cloud Function |
| `notices` + schedule | Firebase Cloud Messaging |
| media overlay | Cloud Run video-processing service (preserve original; generate public copy) |

Never place service-account keys, signing credentials, or webhook secrets in the
Android client (§13.4). The client authenticates users; privileged operations go
through server functions.

## Backups

- **Reference (SQLite):** the DB uses WAL mode. Back up with the online backup
  API or `sqlite3 project-console.db ".backup 'backup-YYYYMMDD.db'"` on a
  schedule; copy backups to off-host encrypted storage. Retain per
  `docs/DATA_RETENTION.md`.
- **Firebase:** enable scheduled Firestore exports to a Cloud Storage bucket and
  enable Storage object versioning. Test restores quarterly.

## Restore

1. Stop the service (or route to maintenance).
2. Reference: replace `DB_PATH` with the chosen backup file; verify integrity
   with `PRAGMA integrity_check;`. Firebase: import the Firestore export into a
   staging project first, verify, then promote.
3. Verify: run `npm test` against a staging copy, confirm `/public/status` and
   `/ap/audit` return expected data, then bring the service back.
4. Record the restore in the operational log and (if data changed) as an audit
   event.
