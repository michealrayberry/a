# Accountability Partner (AP) User Guide

You administer the official record: review evidence, decide compliance, issue
deficiency and violation notices, control publication, and manage the versioned
configuration. Your identity is not public unless you authorize it.

## Dashboard

Counts of items awaiting review, open deficiencies, open violations, and
late/missed requirements. Work deadline-sensitive items first.

## Review queue & evidence workspace

Each item shows the date, requirement, submission and deadline times, computed
timeliness, and automated validation. Open an item to play the evidence, inspect
metadata (hash, duration, capture time, **server receipt time**), and read any
participant explanation.

Determinations: **Verify**, **Mark deficient**, **Reject**, **Excuse**, **Mark
not applicable**, **Request replacement**, **Escalate to violation review**.
Every determination except a straightforward verify **requires a reason**. Bulk
approval is intentionally unavailable for evidence needing individual review.

## Deficiencies

Issue with a reason code, description, optional rule citation, and correction
window. The participant is notified and can submit corrected evidence, which
returns to your queue.

## Violations

Assess against the affected day/requirement with a **factual basis**. The system
looks up the configured consequence for the violation type and occurrence:

- If your proposed amount **matches** the table, it's applied.
- If it **differs**, you get a warning and must supply an **override reason**;
  the override is recorded in the audit trail. The system warns but never
  silently blocks or silently changes your input.

Violations are never charged automatically. Financial consequences record an
amount, due date, and payment status only.

## Publication

Nothing is public until you set a record's publication state to **PUBLIC** or
**UNLISTED** (`POST /ap/publish`). You can withhold or remove from public while
retaining the record privately in the audit archive.

## Configuration

The active configuration is the controlling rule set. To change rules: draft a
**new version**, review the difference against the signed agreement, and
**activate** it. Activated configurations are immutable, and activating a new
version never rewrites prior days — each day keeps the rules it was created
under. Before production activation, compare the seed/config against the signed
agreement and approve explicitly.

## Web Controls (NextDNS)

The **Web Controls** tab is where you administer the participant's web
filtering. You never need the NextDNS dashboard for routine work. See
[`NEXTDNS.md`](./NEXTDNS.md) for one-time setup, which you own: the NextDNS
account, the API key, and the profile binding.

- **Accountability System / NextDNS** show integration status and each
  profile's reporting state. `NO_RECENT_ACTIVITY` is informational; a sleeping
  or offline phone produces it too.
- **HOME-ROUTER** traffic comes from the shared home network. Do not attribute
  it to the participant. Use **RAY-PIXEL** for phone-specific accountability.
- **Access Requests:** choose Approve, Approve w/ different duration, or Deny.
  Approved access expires on its own and the restriction is restored
  automatically. Use **Restore now** to end access early.
- **Web Controls:** block a domain or a NextDNS service id (for example
  `reddit`, which covers its alternate domains), allowlist, or monitor.
  Removing a control requires a reason.
- A **SYNC FAILED** badge means NextDNS has not accepted the change yet. It is
  retried automatically, and integrity shows DEGRADED until it is fixed.
- **Filtering Settings:** turn on *Block bypass methods* for both profiles.
- Every action appears in **Web Controls History** and the main audit log,
  neither of which can be edited.

## Integrity

The **Integrity** tab monitors the monitoring itself.

- **INTERRUPTED** means the phone itself reported Private DNS off or pointed at
  the wrong place. **DEGRADED** means something went quiet, such as the
  heartbeat, DNS traffic, or NextDNS. Silence alone is not evidence of a bypass.
- Restored incidents that need your decision show **AP REVIEW REQUIRED**. Read
  the participant's explanation if there is one, then record a determination
  and a note. Determinations do not assess consequences; use **Violations** if
  one is warranted.
- **Authorized windows** are how you give prior approval, for example while
  troubleshooting the phone. Interruptions inside a window are still recorded.
- Loss of monitoring does not suspend the participant's obligations.

## Audit log

Every material action is recorded with actor, role, action, previous/new state,
reason, and server timestamp. Filter by entity or export it. It is append-only —
treat it as the system of record.

## Technical failures

Upload/processing failures are presented to you for determination under the
active rules. A technical failure is **not** automatically a participant
violation.
