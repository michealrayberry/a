# API Documentation

Base URL (local): `http://localhost:3000`. All request/response bodies are JSON.
Authenticated routes require `Authorization: Bearer <token>` from `/auth/login`.
Role is enforced server-side per request.

## Auth

### POST /auth/login
```json
{ "email": "participant@michealrayberry.com", "password": "…" }
```
→ `200 { "token": "<jwt>", "user": { "id", "displayName", "role" } }`
→ `401 { "error": "invalid_credentials" }`

## Participant (role: PARTICIPANT)

### GET /participant/today
Returns the server-calculated project day and requirement cards.
```json
{
  "serverTime": "2026-07-27T15:00:00.000Z",
  "timeZone": "America/New_York",
  "localDate": "2026-07-27",
  "dayNumber": 40,
  "dayDeadline": "2026-07-28T03:59:59.999Z",
  "overallStatus": "OPEN",
  "day": { "id": "day_…", "…": "…" },
  "requirements": [
    { "id": "rqi_…", "requirementCode": "DAILY_VIDEO", "name": "Daily inspection video",
      "evidenceType": "VIDEO", "status": "NOT_STARTED", "deadlineAt": "…", "timeliness": null }
  ],
  "recordingTemplate": { "name", "scriptVersion", "requiredVariables", "steps": [ … ] }
}
```

### POST /participant/evidence
```json
{ "requirementInstanceId": "rqi_…", "type": "VIDEO",
  "sha256": "…", "sizeBytes": 24000000, "durationMs": 62000,
  "captureStartedAt": "…", "captureCompletedAt": "…",
  "appVersion": "0.1.0", "scriptVersion": "1.0.0", "recordingTemplateVersion": "1.0.0" }
```
→ `201 { "evidenceId", "shortCode", "serverReceivedAt" }` — **the server stamps
the trusted receipt time; timeliness is computed from it, not from the client.**

### POST /participant/weights
```json
{ "projectDayId": "day_…", "weight": 268.4, "unit": "lb", "requirementInstanceId": "rqi_…" }
```
→ `201 { "weightId" }`. Rejects implausible values (≤0 or >2000). Corrections
pass `supersedesEntryId` + `correctionReason` (original preserved).

### POST /participant/external-links
```json
{ "requirementInstanceId": "rqi_…", "platform": "website", "url": "https://…" }
```
→ `201 { "publicationId" }` — recorded `MANUAL_REVIEW_REQUIRED` for AP.

### GET /participant/history · GET /participant/project-days/:id
Chronological days and a full day record (with audit timeline).

### GET /participant/notices · POST /participant/notices/:id/acknowledge

### POST /participant/violations/:id/acknowledge
Acknowledge (never edit) a violation → state `ACKNOWLEDGED`.

## Accountability Partner (role: AP)

| Method & path | Purpose |
|---|---|
| `GET  /ap/dashboard` | Queue/deficiency/violation/late/missed counts |
| `GET  /ap/review-queue` | Evidence awaiting review |
| `GET  /ap/evidence/:id` | Evidence + its audit trail |
| `POST /ap/evidence/:id/verify` `{note?}` | Verify evidence + requirement |
| `POST /ap/deficiencies` `{evidenceId?, requirementInstanceId, reasonCode, description, correctionWindow?}` | Issue deficiency (description required) |
| `POST /ap/violations` `{projectId, projectDayId, violationType, factualBasis, consequenceAmount?, override?}` | Assess a violation. Returns `{violationId, warnings[]}`; a mismatch vs the configured consequence table warns and **requires** `override:{reason}` |
| `POST /ap/publish` `{table, id, status}` | Set `publicStatus` (PRIVATE/PENDING/PUBLIC/UNLISTED/WITHHELD/REMOVED) |
| `POST /ap/deadline-sweep` `{projectId}` | Run the deadline engine on demand |
| `POST /ap/configurations` `{projectId, title, effectiveAt, configuration, changeSummary?}` | Draft a new config version |
| `POST /ap/configurations/:id/activate` | Activate (AP approval; prior days unchanged) |
| `GET  /ap/audit?entityType&entityId` | Audit log (filtered or latest 500) |

All AP determinations other than plain verify require a reason/basis (§8.3).

## Public (no auth — read-only, blueprint §5.4)

`?slug=<publicSlug>` selects the project (defaults to the first project).

| Path | Returns |
|---|---|
| `GET /public/project` | Name, participant, domain, start/goal, milestones |
| `GET /public/status` | Current verified weight, total change, current day, latest status |
| `GET /public/project-days` | Published days (date, dayNumber, status) |
| `GET /public/project-days/:date` | One published day + published requirements/links |
| `GET /public/weights` | Verified + published weight history |
| `GET /public/violations` | Published violations |
| `GET /public/feed` | Combined chronological public feed |

The public API **never** exposes user ids, emails, device ids, AP identity,
internal notes, raw storage paths, auth claims, private evidence, or internal
audit metadata. It only selects rows with `publicStatus IN ('PUBLIC','UNLISTED')`.

## Errors

`400` validation/illegal-transition, `401` unauthenticated/invalid token,
`403` wrong role, `404` not found. Bodies: `{ "error": "<code>" }`.
