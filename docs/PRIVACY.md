# Privacy Notice (Draft)

_Draft for review by the parties and counsel before publication. Blueprint §13.5._

This project publishes an accountability record. Some information is public **by
design**; most is private by default. This notice explains the boundary.

## What is collected

- **Account data**: display name, email, role, authentication metadata,
  multi-factor status.
- **Submitted evidence**: daily documentation videos, progress photographs,
  documented weights, tracking entries, and links to external public posts.
- **Technical metadata**: file hashes, sizes, durations, capture times, server
  receipt times, app/template/script versions, device model and OS version
  (kept private, for troubleshooting only).
- **Determinations**: Accountability Partner verifications, deficiency notices,
  violation records, corrections, and the append-only audit trail.

## What becomes public

Only records the Accountability Partner has **explicitly published**
(`publicStatus` = PUBLIC or UNLISTED). Typically: current/verified weight and
change, project day and status, published daily summaries, published progress
media, published weekly reviews, and published violation notices.

## What stays private

Raw/original evidence files, private administrative notes, internal audit
metadata, email addresses, user and device identifiers, storage paths,
authentication claims, and the Accountability Partner's personal identity
(unless they authorize its publication). The public API cannot return any of
these.

## Health-related data

Weight and related documentation are treated as sensitive. They are **never
sold** and **never used for unrelated advertising**. This is not a medical
application and provides no medical advice, calorie prescriptions, or diagnoses.

## Retention

- Original evidence and audit history are retained for the life of the project
  and its archive period (see `docs/DATA_RETENTION.md`).
- Public records remain published until the AP sets them to WITHHELD/REMOVED;
  removed public records are retained privately in the audit archive (§3.6).
- Corrections preserve both the original and corrected values.

## Rights & corrections

The participant may export their personal records and may request correction of
an **objective factual error**. Corrections are reviewed and approved by the AP
and recorded in the audit trail; the original record is preserved.

## Technical logs

Operational logs (sign-ins, upload success/failure, processing durations, API
errors, background-job failures) are collected for reliability and security
only — no advertising analytics, no engagement scoring, no public ranking.

## Contact

Corrections, data export requests, and privacy questions: the official contact
route configured for the project (see the active configuration's `identity`).
