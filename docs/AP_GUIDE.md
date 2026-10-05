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

## Audit log

Every material action is recorded with actor, role, action, previous/new state,
reason, and server timestamp. Filter by entity or export it. It is append-only —
treat it as the system of record.

## Technical failures

Upload/processing failures are presented to you for determination under the
active rules. A technical failure is **not** automatically a participant
violation.

## Web Controls (NextDNS)

The separate **WEB CONTROLS** portal (Cloudflare-hosted, under your account)
administers NextDNS. Full details are in [`NEXTDNS.md`](./NEXTDNS.md).

- **Overview:** the Accountability System panel (NextDNS, Pixel profile, home
  router, phone heartbeat, policy enforcement, Recording Assistant), the
  profile status, and the web controls table. **BLOCK DOMAIN** adds a
  restriction; **GRANT ACCESS** opens a timed window; **End access now**
  restores the restriction early.
- **Requests:** APPROVE, APPROVE WITH DIFFERENT DURATION, or DENY. Restoration
  at expiry is automatic and confirmed against NextDNS. Unanswered requests
  lapse and the restriction stays.
- **Activity:** RAY-PIXEL ACTIVITY is phone-specific; HOME NETWORK ACTIVITY is
  not attributable to Micheal. Treat DNS events as signals, not proof of
  deliberate use. Each view is audited.
- **Integrity:** a RESTORED incident needs your review (disposition + note).
  Restoration does not erase the interruption. A REPORTING GAP means
  insufficient information, not confirmed bypass.
- **Policy:** visibility mode (changing it requires a reason), allowlist,
  monitored domains, filtering settings, limits.
- Make NextDNS changes **through the portal**. Changes to portal-managed
  entries made in the NextDNS dashboard are reverted and recorded as
  configuration drift.
