# Entity Relationship Diagram

Mirrors blueprint §11. In the reference these are SQLite tables; in a Firebase
deployment they map 1:1 to collections with the same field names.

```mermaid
erDiagram
  users ||--o{ projects : "participant"
  projects ||--o{ configurations : "versions"
  projects ||--o{ project_days : "has"
  configurations ||--o{ project_days : "in force for"
  project_days ||--o{ requirement_instances : "has"
  requirement_instances ||--o{ evidence : "documented by"
  requirement_instances ||--o{ external_publications : "links"
  project_days ||--o{ weights : "records"
  requirement_instances ||--o{ deficiencies : "may have"
  projects ||--o{ violations : "may have"
  projects ||--o{ notices : "issues"
  projects ||--o{ audit_events : "logs"

  users {
    string id PK
    string displayName
    string email UK
    string role "PARTICIPANT|AP|TECH_ADMIN"
    string status
    int    publicIdentityAllowed
  }
  projects {
    string id PK
    string participantId FK
    string publicSlug UK
    string timeZone
    string activeConfigurationId FK
  }
  configurations {
    string id PK
    int    version
    string status "DRAFT|ACTIVE|SUPERSEDED"
    string effectiveAt
    json   configuration
    string activatedBy
    string activatedAt
  }
  project_days {
    string id PK
    string localDate
    int    dayNumber
    string configurationId FK
    string overallStatus
    string deadlineAt
    string publicStatus
    string publicPublishedAt
  }
  requirement_instances {
    string id PK
    string requirementCode
    string status "state machine"
    int    mandatory
    string deadlineAt
    string timeliness
    string publicStatus
  }
  evidence {
    string id PK
    string type
    string state "state machine"
    string sha256
    string serverReceivedAt "TRUSTED"
    string originalStoragePath "preserved"
    string publicStatus
  }
  weights {
    string id PK
    real   weight
    string verificationStatus
    string supersedesEntryId "correction chain"
    string publicStatus
  }
  external_publications {
    string id PK
    string platform
    string url
    string accessibilityStatus
    string publicStatus
  }
  deficiencies {
    string id PK
    string reasonCode
    string correctionDueAt
    string status
  }
  violations {
    string id PK
    int    violationNumber
    string state "state machine"
    string factualBasis
    real   consequenceAmount
    string paymentStatus
    string publicStatus
  }
  notices {
    string id PK
    string type
    string responseDueAt
    string acknowledgedAt
    string publicStatus
  }
  audit_events {
    string id PK
    string actorRole
    string action
    string entityType
    string entityId
    string previousState
    string newState
    string serverTimestamp
  }
```

## Notes

- **Publication state** (`publicStatus`) lives on every publishable entity so
  the public/private boundary is data, not code paths (§3.6).
- **Correction chains**: `weights.supersedesEntryId` preserves the original and
  the corrected value; the original row is never mutated (§7.9, §3.4).
- **Config binding**: `project_days.configurationId` freezes the rules a day was
  created under; activating a new configuration never rewrites prior days.
- **Trusted time**: `evidence.serverReceivedAt` and `requirement_instances`'
  computed `timeliness` are the authoritative timeliness inputs.
