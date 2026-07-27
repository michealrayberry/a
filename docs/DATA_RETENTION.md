# Data Retention Configuration

Retention is policy, not code default — confirm against the signed agreement and
counsel. Values below are the recommended defaults.

| Data class | Retention | Notes |
|---|---|---|
| Original evidence (video/photo) | Life of project + archive period | Never overwritten; preserved even after a public copy is generated (§12.1) |
| Processed / public media copies | While published, then archived | Removing from public retains privately in the audit archive |
| Weight & tracking entries | Life of project + archive period | Corrections preserve original + corrected values |
| Deficiency / violation records | Permanent within project archive | Official record; never deleted |
| Notices | Permanent within project archive | Do not disappear after acknowledgment (§7.14) |
| Audit events | Permanent | Append-only; the system of record |
| Technical logs (sign-in, upload, jobs) | 90 days rolling | Operational/security only |
| Device model / OS metadata | With the evidence record, private | Troubleshooting only; never public |
| Exports | Per requester retention; encrypted at rest | Include generation time + config version + hashes |

## Archive & completion

- On project completion, set `projects.completedAt`; begin the maintenance
  period from the active configuration.
- On archive, set `projects.archivedAt`. Archived projects become read-only;
  public records follow the active publication rules.

## Deletion requests

Health-related and personal data deletion requests are handled per the privacy
notice and applicable law. Deletion of an **official record** entry is not
performed unilaterally; it requires AP action and is itself audit-logged. The
audit trail of what existed is retained even when content is withdrawn from
public display.
