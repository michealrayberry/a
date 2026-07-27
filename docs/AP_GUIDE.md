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
