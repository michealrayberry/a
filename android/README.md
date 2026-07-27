# Project Console — Android participant client

Native Android client for the **Project Console** participant app. It is the
phone-side companion to the existing Node/TypeScript REST backend in
[`../server`](../server); this module contains **only** the Android client.

> ⚠️ **Honest build status.** This source tree has **not** been compiled, run,
> or tested in this repository's CI environment — there is no Android SDK here.
> It is written to be clean, idiomatic, and to *look* compilable when opened in
> Android Studio with the Android SDK installed, but you should treat a first
> local build as the first real build. Version numbers in the Gradle version
> catalog reflect a stable early-2026 baseline; adjust to whatever your
> installed SDK/AGP supports.

---

## Tech stack

| Concern            | Choice                                                   |
|--------------------|----------------------------------------------------------|
| Language / UI      | Kotlin, Jetpack Compose, Material 3                      |
| Architecture       | Unidirectional data flow; ViewModel + Repository        |
| DI                 | Hilt                                                     |
| Networking         | Retrofit + OkHttp + Moshi (codegen)                      |
| Offline storage    | Room (durable upload queue + `/today` cache)            |
| Preferences        | Jetpack DataStore (non-sensitive); EncryptedSharedPreferences for the session token |
| Video capture      | CameraX (`Recorder` / `VideoCapture`)                   |
| Durable uploads    | WorkManager `CoroutineWorker` (foreground, resumable)   |

## Module layout

```
android/
├── settings.gradle.kts, build.gradle.kts, gradle.properties
├── gradle/libs.versions.toml           # version catalog (single source of truth)
└── app/
    ├── build.gradle.kts                 # deps + BuildConfig.API_BASE_URL
    ├── src/main/AndroidManifest.xml     # camera/audio/internet/foreground-service perms
    └── src/main/java/com/michealrayberry/console/
        ├── ProjectConsoleApp.kt         # @HiltAndroidApp + WorkManager Configuration.Provider
        ├── MainActivity.kt              # single activity, Compose host
        ├── data/
        │   ├── remote/                  # ApiService, DTOs, AuthInterceptor, TokenStore
        │   ├── local/                   # Room: entities, DAOs, ConsoleDatabase, UploadState
        │   ├── prefs/                   # DataStore preferences
        │   └── repo/                    # AuthRepository, ProjectRepository
        ├── domain/                      # UI-facing models
        ├── work/                        # ResumableUploadWorker, UploadEnqueuer, transport, hashing
        ├── camera/                      # GuidedRecordingController (sequence engine)
        ├── di/                          # Hilt modules (Network, Database, App/Bindings)
        └── ui/
            ├── theme/                   # restrained Material 3 theme + tabular numerals
            ├── nav/                     # NavHost + 5 bottom-nav destinations
            ├── common/                  # ServerCountdown
            ├── today/  record/  history/  notices/  project/
```

## Mapping to the backend

Every call targets an endpoint that already exists on the server — no endpoints
are invented client-side. See `data/remote/ApiService.kt`.

| Screen / action              | Endpoint                                            |
|------------------------------|-----------------------------------------------------|
| Sign in                      | `POST /auth/login`                                  |
| Today (cards, countdown)     | `GET  /participant/today`                           |
| Submit video/photo evidence  | `POST /participant/evidence`                        |
| Submit weight                | `POST /participant/weights`                         |
| Submit external link         | `POST /participant/external-links`                  |
| Notices + acknowledge        | `GET /participant/notices`, `POST /participant/notices/:id/acknowledge` |
| Acknowledge a violation      | `POST /participant/violations/:id/acknowledge`      |

DTOs in `data/remote/dto/` mirror the server's request/response shapes,
including the `recordingTemplate` (steps, teleprompter text, min-hold seconds,
required variables) that drives the guided recorder.

## Server-authoritative time (how it works here)

Timeliness and deadlines are decided **by the server**, never by the device
clock. The client treats device time as display-only.

- `GET /participant/today` returns `serverTime`, `dayDeadline`, and each
  requirement's `deadlineAt`, all computed by the backend in the project time
  zone.
- On sync, `ProjectRepository.refreshToday()` stores the server time alongside
  `SystemClock.elapsedRealtime()` (a **monotonic** clock the user cannot
  back-date). `ui/common/ServerCountdown.kt` animates the live countdown by
  adding the monotonic delta to the server anchor — so the ticking display
  stays honest even offline, without ever letting the wall clock influence the
  number.
- The **trusted instant** for a submission is `serverReceivedAt`, returned by
  `POST /participant/evidence`. The app captures it verbatim
  (`PendingEvidenceEntity.serverReceivedAt`) and displays it; it never computes
  its own submission time.

## Offline & upload state model (evidence-before-status)

A recording that merely exists on the phone is **not** a submission. The device
tracks an explicit lifecycle (`data/local/UploadState.kt`) and the UI renders
each state distinctly so the participant is never misled:

```
RECORDED_LOCALLY → QUEUED → UPLOADING → UPLOADED → SUBMITTED → VERIFIED
                                   ↘ FAILED (retried; original never destroyed)
```

- **RECORDED_LOCALLY** — captured + SHA-256 hashed; original preserved. Not a
  submission.
- **QUEUED / UPLOADING / UPLOADED** — durable, resumable transfer in progress
  (see below).
- **SUBMITTED** — the server registered the evidence and returned
  `serverReceivedAt`. Only now is the requirement considered submitted.
- **VERIFIED** — reflected from the server after review; never decided locally.

Resilience details:
- The queue lives in Room, so items survive process death, reboot, and network
  loss.
- `work/ResumableUploadWorker` runs as a **foreground** `CoroutineWorker`,
  re-verifies the stored SHA-256 against the preserved original before
  registering, and persists a resume cursor (`bytesUploaded`) between chunks so
  transfers continue rather than restart.
- The binary blob transport is abstracted behind
  `work/EvidenceUploadTransport`. The listed backend API accepts evidence
  **metadata**; the actual bytes go to object storage via a resumable transport
  (signed PUT / GCS resumable / TUS) that is a deployment detail. The reference
  `ChunkedUploadTransport` implements all the resume bookkeeping and leaves a
  single clearly-marked `putChunk` seam to wire to your storage — it does not
  fabricate a working upload or invent an endpoint.

## No editing, capture only

The recorder is a guided, single-continuous-take sequence engine
(`camera/GuidedRecordingController`): it advances teleprompter steps, enforces
per-step minimum hold times, and preserves the original file verbatim. Review
(`ui/record/RecordingReviewScreen`) offers exactly **playback + Accept /
Re-record** — there is no trim, filter, or splice anywhere in the app.

## No secrets in the client; server-assigned authority

- There are **no API keys or shared secrets** compiled into the app. The only
  credential is the per-session JWT, stored in EncryptedSharedPreferences
  (`data/remote/TokenStore.kt`) and attached by `AuthInterceptor`.
- **Role/authority comes from the backend.** `LoginResponse.user.role` is stored
  and displayed but the app performs no capability decisions based on it or on
  the account email. The server authorizes every action.

## Configure the API base URL (no host committed)

The base URL is a build-time `BuildConfig.API_BASE_URL`, resolved in
`app/build.gradle.kts`. It defaults to the emulator's host-loopback alias
(`http://10.0.2.2:3000/`) so it points at a locally running `../server`.

Override without committing anything — pick one:

```bash
# Per-invocation Gradle property
./gradlew :app:assembleDebug -PconsoleApiBaseUrl=https://your-dev-host.example/

# Or in your USER gradle properties (never the repo):
#   ~/.gradle/gradle.properties
#   consoleApiBaseUrl=https://your-dev-host.example/
```

Do not put real hosts, tokens, or keys in `gradle.properties` or source.

## Open / build in Android Studio

1. Install Android Studio (Ladybug or newer) with **SDK Platform 35** and
   build-tools. Set `local.properties` `sdk.dir`, or let Studio do it.
2. **Open** the `android/` directory (not the repo root) as the project.
3. The Gradle **wrapper jar** and `gradlew` script are intentionally not
   committed (binary). Let Android Studio generate them on first sync, or run
   `gradle wrapper --gradle-version 8.11.1` with a local Gradle.
4. Start `../server` (`npm install && npm run dev` — see its README), then run
   the `app` configuration on an emulator/device.
5. Grant camera + microphone when the preflight checklist asks.

### Tests

Pure-JVM unit tests live in `app/src/test/` (e.g. `ServerCountdownTest`,
`HashingTest`) and run with `./gradlew :app:testDebugUnitTest` once the SDK is
available.

## Known seams / assumptions

- **Sign-in screen** is intentionally omitted; `MainActivity` notes where an
  auth gate would sit above the nav host. `AuthRepository.login` is wired.
- **`putChunk` transport** is a no-op placeholder (see above) — wire it to real
  resumable storage.
- **Teleprompter variables** `participantName` / `currentWeight` are left as
  explicit blanks rather than fabricated; a full build resolves them from the
  server identity and the latest verified weight.
- Versions in `libs.versions.toml` are a plausible baseline, not pinned against
  a verified local build.
