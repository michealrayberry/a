# Release Checklist

## Acceptance criteria (blueprint §25) — verification map

| # | Criterion | Verified by |
|---|---|---|
| 1 | Correct server-calculated project day | `integration.test.ts` #1; `/participant/today` |
| 2 | Guided multi-step recording | Android `GuidedRecordingController` + `recordingTemplate` |
| 3 | Recording survives connectivity loss | WorkManager queue (native), offline states |
| 4 | Upload resumes after restart | `ResumableUploadWorker` |
| 5 | Server timestamp after upload | `submitEvidence` stamps `serverReceivedAt`; test #5 |
| 6 | Correct before/after deadline | `time.test.ts` boundary tests; test #6 |
| 7 | Participant cannot approve own evidence | `integration.test.ts` #7 (403) |
| 8 | AP can review & verify | test #8 |
| 9 | AP can issue deficiency | test #9 |
| 10 | Participant submits corrective evidence | test #10 |
| 11 | AP assesses authorized violation | test #11 |
| 12 | Participant acknowledges without editing | test #12 |
| 13 | Active config attached to every day | `engine.test.ts`; test asserts binding |
| 14 | New config doesn't rewrite prior days | `integration.test.ts` config versioning |
| 15 | Public sees only approved records | public separation test |
| 16 | Private evidence inaccessible | public API field-strip test |
| 17 | Website shows latest status | `web/integration/status-widget.js` + `/public/status` |
| 18 | Every material action audited | test #18 + `audit.ts` on all transitions |
| 19 | Wrong device time doesn't change result | timeliness uses server instant only |
| 20 | System errors ≠ noncompliance | processing/tech-failure kept separate (§12.4) |
| 21 | Complete official-record export | `GET /ap/export?type=official-record&format=json\|csv` (`exporter.ts`, tested) |
| 22 | Usable at 320px | responsive CSS (`max-width`, flex/grid) |
| 23 | Accessibility on primary workflows | text+icon status, contrast, semantic markup |
| 24 | No placeholder/nonfunctional UI | all buttons wired to the API |
| 25 | No secrets/keys in client | JWT server-side; no keys in `android/` |

## Pre-release

- [ ] Rotate all demo passwords; set a strong `JWT_SECRET`.
- [ ] `npm test` green; `npm run typecheck` clean.
- [ ] Seed configuration compared against the signed agreement and AP-approved.
- [ ] Security review (below) complete.
- [ ] Backups configured and a test restore performed.
- [ ] Privacy notice + data-retention reviewed by counsel.
- [ ] TLS enforced; `/participant` and `/ap` origins restricted.

## Security review

- [ ] Participant cannot reach any AP route (403).
- [ ] Public user cannot fetch any private record.
- [ ] Tampered/expired tokens rejected.
- [ ] Role never trusted from client input.
- [ ] Upload type/size limits + malware scan (production storage).
- [ ] Signed media URLs are short-lived; replay rejected.
- [ ] No secrets in the mobile client or the repo.

## Google Play submission checklist

- [ ] App signing configured (Play App Signing); no keystore in the repo.
- [ ] Target/compile SDK current; 64-bit only.
- [ ] Permissions justified: camera, microphone, internet, foreground service
      (upload). No location/contacts/background surveillance.
- [ ] Data safety form: collects health/photo/video; not sold; not for ads;
      encrypted in transit; deletion request path documented.
- [ ] Sensitive-permission declarations (camera/foreground service) with a
      usage video.
- [ ] Content rating questionnaire completed; no fetish/sexual content.
- [ ] Privacy policy URL live (from `docs/PRIVACY.md`).
- [ ] Store listing avoids prohibited claims; describes an accountability/
      documentation tool, not medical treatment.
- [ ] Closed testing track completed with real devices across DST/timezone.
- [ ] Crash/ANR monitoring wired.
