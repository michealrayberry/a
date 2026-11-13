# Apple TV controls: compliance gate, Restrictions, kid-safe settings

There are three layers. Read the limits first, because each layer does less
than its name suggests.

| Layer | What it actually does | What it can't do |
|---|---|---|
| **Restrictions** (built into tvOS) | Passcode-locks purchases, ratings, explicit content and some settings | Lock the TV until you comply. Ratings don't reliably filter inside third-party apps |
| **Single App Mode** (supervised Apple TV) | Pins the Apple TV to Project Console. Nothing else opens, including Settings | Run itself. Something has to start and stop it: the AP, an MDM, or the app in autonomous mode |
| **In-app compliance gate** | Decides LOCKED / CLEARED from the server's requirement status and shows exactly what's owed. In autonomous mode it starts and stops Single App Mode itself | Block other apps on its own. tvOS doesn't allow it |

**The gate covers this one Apple TV.** It does nothing about a phone, laptop,
another TV, or the TV's other inputs. Treat it as one control, not a total
media lockout.

---

## How the gate decides (server truth only)

Each time Today syncs (every 60 s, and on Play/Pause), the app evaluates
today's **mandatory** requirements:

| Today's mandatory items | Verdict |
|---|---|
| All submitted, under review, late, verified, excused or not applicable | **CLEARED** |
| Any not started / in progress, after the lock window opens | **LOCKED**, listing what's owed |
| Any **missed or deficient** | **LOCKED for the rest of the day**, even after the deadline passes |
| Any not started, before the lock window opens | **Locks at HH:MM**, as a warning |

- **Submission clears the gate, not verification.** AP review can take
  hours, and the gate shouldn't punish review lag. A later deficiency
  re-locks it.
- **Missing a deadline never unlocks the TV.** Without this rule, the
  cheapest way to unlock would be letting the deadline pass.
- **No unlock button, no override in the app.** The AP releases the TV through
  Configurator or MDM, not the participant through the app.
- If the server can't be reached, autonomous mode **leaves the TV as it is.**
- A new project day starts at midnight in the project zone and is evaluated
  fresh.

### Configuration (deliberately not in the app's Settings)

| Key | Values | Default |
|---|---|---|
| `ComplianceGateMode` | `off`, `manual`, `autonomous` | `manual` |
| `ComplianceGateLockFrom` | `HH:mm` project time. `00:00` = locked all day until compliant | `00:00` |

Values come from the **managed app configuration** (pushed by an MDM) if one is
present. Otherwise they come from `project.yml` (`info.properties`) at build
time. The Settings tab shows them read-only.

**Recommendation:** keep `00:00` (no TV until today's evidence is in). If that
proves unworkable, use a fixed time that you and the AP agree in writing, such
as `18:00`. Don't change it on a bad day.

---

## Part A: Restrictions (AP holds the passcode)

On the Apple TV, go to **Settings → General → Restrictions** and turn on
Restrictions. **Have the AP enter the 4-digit passcode** while you look away,
and don't reuse a code you know.

Accountability settings:

| Setting | Set to | Why |
|---|---|---|
| Purchase and Rental | Restrict | No impulse rentals or purchases |
| In-App Purchases | Off | Closes the subscription-upgrade path |
| Apps (ratings) | Whatever you agree. **Not "Don't Allow Apps"** | "Don't Allow Apps" also hides Project Console |
| AirPlay settings | Restrict | Stops "just cast it from my phone" through this box |
| Remotes and Devices / Location / TV Provider | Restrict where offered | Fewer settings to tamper with |

Restrictions alone don't lock the TV until you comply. Use them alongside Part
B or Part C.

---

## Part B: Supervision + Single App Mode (the real lock)

### One-time setup (needs a Mac with Apple Configurator, free on the Mac App Store)
1. Put the Apple TV and the Mac on the same network. On the Apple TV, open
   **Settings → Remotes and Devices → Remote App and Devices**. In Apple
   Configurator, pair with it.
2. **Prepare** the Apple TV with **Supervise devices** turned on. **This
   erases the Apple TV.** Create a new supervision identity.
3. **The AP must control the supervision identity.** If it was created on
   your Mac, export it to the AP and delete it from your Mac. Whoever holds
   the identity can end Single App Mode. If that's you, the lock is
   symbolic.
4. Install Project Console (see README), sign in, and confirm the gate card
   appears on Today.
5. Check the Apple TV under **Settings → General → About**. It should say the
   device is supervised.

### Manual mode (`ComplianceGateMode: manual`)
- To lock: in Apple Configurator, select the Apple TV and choose **Actions →
  Advanced → Start Single App Mode → Project Console**.
- To release: when the gate card reads **TV CLEARED**, the AP chooses
  **Actions → Advanced → Stop Single App Mode**.
- **Drawback:** Configurator only works on the local network. A remote AP
  can't toggle it. For a remote AP, use an MDM: the AP holds the admin login
  and starts or stops Single App Mode from a web console. Several MDM vendors
  support Apple TV. The managed app configuration keys above can be pushed the
  same way.

### Autonomous mode (`ComplianceGateMode: autonomous`), unverified on tvOS
In this mode the app locks the TV itself when the verdict is LOCKED and
releases it when the verdict is CLEARED. Nobody has to toggle anything daily.

1. On the supervised Apple TV, install a configuration profile (Configurator
   or MDM) whose **Restrictions** payload lists this app's bundle ID in
   `autonomousSingleAppModePermittedAppIDs`.
2. Build with `ComplianceGateMode: autonomous`, or push it through managed
   config.
3. **Test before relying on it.** With a requirement outstanding, open Today.
   The caption under the gate card reports whether tvOS accepted or refused
   the request. Apple documents this API for tvOS, but doesn't confirm that
   autonomous Single App Mode is honored on Apple TV. If it's refused, use
   manual or MDM.

---

## Loopholes and the control for each

| Bypass | Control |
|---|---|
| Erase or re-set up the Apple TV | Erasing removes supervision, and it's visible. The AP checks Settings → About weekly, and an unsupervised Apple TV counts as a violation |
| Unplug it, or use another TV, input, phone or laptop | Outside this control. If entertainment elsewhere is the real problem, add Screen Time with an AP-held passcode on those devices |
| Sign out of the app | No effect: in Single App Mode, nothing else opens |
| Change the gate mode | It isn't in the app. It needs a rebuild or a new managed profile. The AP holds the MDM login and checks the mode in Settings |
| Guess the Restrictions passcode | AP-chosen code, not shared, changed if you see it |
| Hold the supervision identity yourself | Don't. Step 3 above |

## Safety and withdrawal

- **Unplugging the Apple TV is always possible**, and it never affects the TV's
  other inputs, your phone, or emergency services. Unplugging without AP release
  counts as a violation to record, not as a trap.
- The AP can end Single App Mode at any time. If you withdraw consent, the AP
  releases it on request. Agree this in writing.
- Keep a sealed backup of the supervision identity with a second trusted
  person. Without it, a supervised Apple TV can't be fully reset if the AP
  becomes unavailable.

---

## Part D: Kid-safe controls (a child using this Apple TV)

Under **Settings → General → Restrictions**:

| Setting | Suggested |
|---|---|
| Purchase and Rental, In-App Purchases | Restrict / Off |
| Movies, TV Shows | Rating cap for the child's age (choose the country's rating system first) |
| Apps | Age rating cap |
| Music, Podcasts, News | **Clean** |
| Game Center multiplayer / adding friends | Off |
| AirPlay settings | Restrict |

Also:
- **Set parental controls inside each streaming app** (Netflix, YouTube, Disney+
  and so on). tvOS ratings don't reliably carry into third-party apps.
- If you use the cable or satellite provider in the TV app, it has its own
  Parental Controls passcode, under Settings → Accounts → Parental Controls in
  that app.
- Restrictions are **device-wide**, not per user profile.
- **Project Console:** the private tabs (Today, History, Notices) need your
  sign-in. The **Public Board** shows the public record, including weight, to
  anyone who opens the app. If that matters, sign out and switch away from the
  app when a child is using the TV.

**Conflict:** Parts A and D use the **same single Restrictions passcode.** If
the AP holds it, a parent in the household can't adjust kid settings without
the AP, and the reverse. Decide who holds it before you set it up.
