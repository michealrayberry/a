# Project Console — Apple TV (tvOS) client

A native SwiftUI tvOS app for the Accountability Project Console. It's built
for the Siri Remote and a screen across the room. It talks to the same backend
as the Android app and the web surfaces.

> **Status:** source only. This repo's build environment is Linux, which has no
> Xcode or tvOS SDK, so the app has **not been compiled or run**. Treat it the
> same way as `android/`: real source to open in Xcode, not a shipped app.

## What it does

| Tab | Auth | Purpose |
|---|---|---|
| **Today** | Participant | Day number, overall status, live countdown to the next outstanding mandatory deadline (falls back to day close), requirement cards with server status and timeliness. Auto-refreshes every 60 s. |
| **History** | Participant | Every project day. Select one to see its requirements and full audit trail. |
| **Notices** | Participant | AP/system notices, with unacknowledged and response-required flags. **Acknowledge receipt** (with confirmation) records a server-timestamped read. |
| **Public Board** | None | An always-on tracker built only from the public API: current verified weight, start, goal, change, to-goal, progress bar, weight chart with a goal line, and recent published days. Keeps the TV awake while it's on screen. |
| **Settings** | — | Server URL, public slug, remote-control reference, sign-out. |

### Siri Remote controls

| Input | Action |
|---|---|
| Swipe / arrows | Move focus. Left/right on the tab bar switches tabs |
| Click (Select) | Open a requirement, day or notice |
| **Play/Pause** | Refresh the current screen |
| Back / Menu | Close a detail sheet, return to the tab bar |

Text fields open the tvOS keyboard. A nearby iPhone can also type into them
through the Apple TV keyboard notification.

## Deliberate limits

- **No evidence submission on TV.** Apple TV has no camera and no file
  access, so recording, upload and weight entry stay in the phone client. The
  TV never shows a "mark complete" control (evidence before status, §3.3).
- **Participant role only.** AP accounts are refused at sign-in. AP rulings
  belong in the portal, which has a full keyboard and audit context.
- **Server time is authoritative.** The countdown is anchored to `serverTime`
  from `/participant/today` and advanced by `CLOCK_MONOTONIC`, so changing the
  Apple TV's clock can't move it. All times show in the project zone that the
  server reports, not the TV's zone. This mirrors Android `ServerCountdown`.
- **Token in the Keychain** (`AfterFirstUnlockThisDeviceOnly`), never in
  UserDefaults. A 401 on any call signs out and returns to sign-in. Server
  tokens expire after 12 h.

## Compliance gate and parental controls

Today carries a **compliance gate card**. It shows LOCKED until today's
mandatory evidence is submitted, and a missed or deficient item keeps it locked
for the rest of the day. Paired with Single App Mode on a supervised Apple TV,
this makes the TV unusable for anything else until you comply. The gate mode is
set by managed config or at build time, never from the couch. Setup, the
Restrictions passcode, kid-safe settings, loopholes and safety are covered in
**[PARENTAL_CONTROLS.md](PARENTAL_CONTROLS.md)**.

## Build

Requires Xcode 15.3+ and tvOS 17+ (uses `@Observable`, `ContentUnavailableView`
and Swift Charts).

```bash
brew install xcodegen
cd tvos
xcodegen generate          # writes ProjectConsoleTV.xcodeproj + Info.plist
open ProjectConsoleTV.xcodeproj
```

Run the `ProjectConsoleTV` scheme on the Apple TV simulator. Run tests with ⌘U
(server clock math, ISO parsing in the project zone, wire decoding, and status
labels).

### Pointing it at a server

- **Simulator:** the default `http://localhost:3000` reaches the reference
  server on your Mac (`cd server && npm run dev`).
- **Real Apple TV on your LAN:** in Settings, enter `http://<mac-ip>:3000`.
  `NSAllowsLocalNetworking` permits plain HTTP to local addresses for
  development only.
- **Production:** use the HTTPS origin. Don't add broader ATS exceptions.

Demo sign-in (development only): `participant@michealrayberry.com` /
`participant-dev-pass`.

## Layout

```
tvos/
  project.yml                     XcodeGen spec (app + unit-test targets)
  ProjectConsoleTV/
    App/                          Entry point, root routing, tab shell
    Core/                         Models, APIClient, ServerClock + ISODate, Keychain/settings
    Features/Session/             SessionModel (auth, clock anchor, project zone, refresh)
    Features/{Login,Today,History,Notices,Board,Settings,Gate}/
    UI/                           Theme (shared palette), StatusBadge, CountdownView
  ProjectConsoleTVTests/
```
