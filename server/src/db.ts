/**
 * SQLite persistence (blueprint §11 data model).
 *
 * In production the blueprint suggests Firestore; this reference implementation
 * uses SQLite so the whole system is runnable locally with zero external
 * services. The schema mirrors the specified collections. JSON columns hold the
 * versioned `configuration` blob and structured sub-documents.
 *
 * Server timestamps are always written server-side (see nowIso). Audit rows are
 * append-only by convention and enforced at the service layer.
 */
import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDb(path = process.env.DB_PATH ?? 'project-console.db'): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    displayName TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('PARTICIPANT','AP','TECH_ADMIN')),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    mfaEnabled INTEGER NOT NULL DEFAULT 0,
    publicIdentityAllowed INTEGER NOT NULL DEFAULT 0,
    notificationPreferences TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL,
    lastLoginAt TEXT
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    participantId TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    publicSlug TEXT UNIQUE NOT NULL,
    timeZone TEXT NOT NULL,
    activeConfigurationId TEXT,
    createdAt TEXT NOT NULL,
    completedAt TEXT,
    archivedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS configurations (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    effectiveAt TEXT NOT NULL,
    expiresAt TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    configuration TEXT NOT NULL,
    changeSummary TEXT,
    sourceAgreementId TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    activatedBy TEXT,
    activatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS project_days (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    localDate TEXT NOT NULL,
    dayNumber INTEGER NOT NULL,
    configurationId TEXT NOT NULL REFERENCES configurations(id),
    overallStatus TEXT NOT NULL DEFAULT 'OPEN',
    submissionVersion INTEGER NOT NULL DEFAULT 0,
    submittedAt TEXT,
    deadlineAt TEXT NOT NULL,
    lockedAt TEXT,
    lockedBy TEXT,
    publicStatus TEXT NOT NULL DEFAULT 'PRIVATE',
    publicPublishedAt TEXT,
    UNIQUE (projectId, localDate)
  );

  CREATE TABLE IF NOT EXISTS requirement_instances (
    id TEXT PRIMARY KEY,
    projectDayId TEXT NOT NULL REFERENCES project_days(id),
    requirementCode TEXT NOT NULL,
    name TEXT NOT NULL,
    evidenceType TEXT NOT NULL,
    mandatory INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'NOT_STARTED',
    deadlineAt TEXT NOT NULL,
    grace TEXT,
    submittedAt TEXT,
    serverReceivedAt TEXT,
    verifiedAt TEXT,
    verifiedBy TEXT,
    timeliness TEXT,
    publicStatus TEXT NOT NULL DEFAULT 'PRIVATE'
  );

  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    projectDayId TEXT NOT NULL,
    requirementInstanceId TEXT NOT NULL REFERENCES requirement_instances(id),
    type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    originalStoragePath TEXT,
    processedStoragePath TEXT,
    thumbnailStoragePath TEXT,
    mimeType TEXT,
    sizeBytes INTEGER,
    durationMs INTEGER,
    sha256 TEXT,
    captureStartedAt TEXT,
    captureCompletedAt TEXT,
    uploadedAt TEXT,
    serverReceivedAt TEXT,
    processingStatus TEXT,
    validationStatus TEXT,
    validationFindings TEXT,
    scriptVersion TEXT,
    recordingTemplateVersion TEXT,
    appVersion TEXT,
    publicStatus TEXT NOT NULL DEFAULT 'PRIVATE',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weights (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    projectDayId TEXT NOT NULL,
    weight REAL NOT NULL,
    unit TEXT NOT NULL,
    measurementType TEXT,
    measuredAt TEXT,
    submittedAt TEXT NOT NULL,
    verificationStatus TEXT NOT NULL DEFAULT 'PENDING',
    verifiedBy TEXT,
    verifiedAt TEXT,
    evidenceIds TEXT,
    supersedesEntryId TEXT,
    correctionReason TEXT,
    publicStatus TEXT NOT NULL DEFAULT 'PRIVATE'
  );

  CREATE TABLE IF NOT EXISTS external_publications (
    id TEXT PRIMARY KEY,
    projectDayId TEXT NOT NULL,
    requirementInstanceId TEXT NOT NULL,
    platform TEXT NOT NULL,
    url TEXT NOT NULL,
    externalContentId TEXT,
    visibility TEXT,
    submittedAt TEXT NOT NULL,
    lastCheckedAt TEXT,
    accessibilityStatus TEXT NOT NULL DEFAULT 'UNCHECKED',
    validationMethod TEXT,
    publicStatus TEXT NOT NULL DEFAULT 'PRIVATE'
  );

  CREATE TABLE IF NOT EXISTS deficiencies (
    id TEXT PRIMARY KEY,
    projectDayId TEXT NOT NULL,
    requirementInstanceId TEXT NOT NULL,
    issuedBy TEXT NOT NULL,
    issuedAt TEXT NOT NULL,
    reasonCode TEXT NOT NULL,
    description TEXT NOT NULL,
    ruleCitation TEXT,
    correctionAllowed INTEGER NOT NULL,
    correctionDueAt TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    participantResponse TEXT,
    resolvedAt TEXT,
    resolvedBy TEXT
  );

  CREATE TABLE IF NOT EXISTS violations (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    projectDayId TEXT NOT NULL,
    requirementInstanceId TEXT,
    violationNumber INTEGER NOT NULL,
    ruleCitation TEXT,
    factualBasis TEXT NOT NULL,
    assessedBy TEXT,
    assessedAt TEXT,
    consequenceType TEXT,
    consequenceAmount REAL,
    consequenceDuration TEXT,
    dueAt TEXT,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    acknowledgedAt TEXT,
    completedAt TEXT,
    paymentStatus TEXT,
    paymentEvidenceId TEXT,
    publicStatus TEXT NOT NULL DEFAULT 'PRIVATE',
    reversalReason TEXT
  );

  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    projectDayId TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    issuedByRole TEXT NOT NULL,
    issuedBy TEXT,
    issuedAt TEXT NOT NULL,
    responseRequired INTEGER NOT NULL DEFAULT 0,
    responseDueAt TEXT,
    acknowledgedAt TEXT,
    publicStatus TEXT NOT NULL DEFAULT 'PRIVATE'
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    actorId TEXT,
    actorRole TEXT NOT NULL,
    action TEXT NOT NULL,
    entityType TEXT NOT NULL,
    entityId TEXT NOT NULL,
    previousState TEXT,
    newState TEXT,
    reason TEXT,
    serverTimestamp TEXT NOT NULL,
    securityContext TEXT
  );

  -- The audit trail is append-only at the storage layer, not just by convention:
  -- history cannot be silently rewritten or deleted through the application.
  CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

  -- ---- NextDNS / Web Controls (docs/NEXTDNS.md) ----------------------------
  -- The two NextDNS contexts. nextdnsProfileId is null until the AP binds it.
  CREATE TABLE IF NOT EXISTS nextdns_profiles (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    label TEXT NOT NULL CHECK (label IN ('RAY-PIXEL','HOME-ROUTER')),
    nextdnsProfileId TEXT,
    attribution TEXT NOT NULL CHECK (attribution IN ('PARTICIPANT_DEVICE','SHARED_NETWORK')),
    description TEXT NOT NULL,
    boundBy TEXT,
    boundAt TEXT,
    createdAt TEXT NOT NULL,
    UNIQUE (projectId, label)
  );

  -- AP policy of record. NextDNS is reconciled to this table, never the reverse.
  CREATE TABLE IF NOT EXISTS web_controls (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL CHECK (kind IN ('BLOCK','ALLOW','MONITOR')),
    targetType TEXT NOT NULL CHECK (targetType IN ('DOMAIN','SERVICE')),
    target TEXT NOT NULL,
    displayName TEXT NOT NULL,
    profiles TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ACTIVE','TEMPORARILY_ALLOWED','REMOVED')),
    syncStatus TEXT NOT NULL DEFAULT 'PENDING' CHECK (syncStatus IN ('IN_SYNC','PENDING','SYNC_FAILED')),
    lastSyncError TEXT,
    lastSyncAt TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    removedBy TEXT,
    removedAt TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_web_controls_live
    ON web_controls(projectId, kind, targetType, target) WHERE state != 'REMOVED';

  CREATE TABLE IF NOT EXISTS web_access_requests (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    controlId TEXT NOT NULL REFERENCES web_controls(id),
    requestedBy TEXT NOT NULL,
    requestedAt TEXT NOT NULL,
    requestedMinutes INTEGER NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','DENIED','WITHDRAWN')),
    decidedBy TEXT,
    decidedAt TEXT,
    approvedMinutes INTEGER,
    decisionNote TEXT,
    grantId TEXT
  );

  CREATE TABLE IF NOT EXISTS web_temporary_grants (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    controlId TEXT NOT NULL REFERENCES web_controls(id),
    accessRequestId TEXT,
    grantedBy TEXT NOT NULL,
    grantedAt TEXT NOT NULL,
    durationMinutes INTEGER NOT NULL,
    expiresAt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
    endedAt TEXT,
    endedBy TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_grant
    ON web_temporary_grants(controlId) WHERE status = 'ACTIVE';

  -- ---- Monitoring integrity (Phase 5, docs/NEXTDNS.md) ----------------------
  -- Raw phone heartbeats. serverReceivedAt is trusted; clientTime is not.
  CREATE TABLE IF NOT EXISTS device_heartbeats (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    participantId TEXT NOT NULL,
    deviceId TEXT NOT NULL,
    serverReceivedAt TEXT NOT NULL,
    clientTime TEXT,
    privateDnsMode TEXT NOT NULL,
    privateDnsHost TEXT,
    privateDnsState TEXT NOT NULL,
    network TEXT NOT NULL,
    recordingReady INTEGER,
    appVersion TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_heartbeats_project ON device_heartbeats(projectId, serverReceivedAt);

  -- Latest known state per monitored component (a cache; history is in incidents + audit).
  CREATE TABLE IF NOT EXISTS integrity_checks (
    projectId TEXT NOT NULL REFERENCES projects(id),
    component TEXT NOT NULL,
    state TEXT NOT NULL,
    lastVerifiedAt TEXT,
    lastCheckedAt TEXT NOT NULL,
    detail TEXT,
    PRIMARY KEY (projectId, component)
  );

  -- Interruptions/degradations. Restoration closes an incident; nothing deletes one.
  CREATE TABLE IF NOT EXISTS integrity_incidents (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('INTERRUPTED','DEGRADED')),
    status TEXT NOT NULL CHECK (status IN ('OPEN','AP_REVIEW_REQUIRED','CLOSED','REVIEWED')),
    lastVerifiedAt TEXT,
    detectedAt TEXT NOT NULL,
    restoredAt TEXT,
    detail TEXT NOT NULL,
    restoreDetail TEXT,
    exemptionId TEXT,
    participantExplanation TEXT,
    participantExplainedAt TEXT,
    determination TEXT,
    reviewNote TEXT,
    reviewedBy TEXT,
    reviewedAt TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_one_open_incident
    ON integrity_incidents(projectId, type) WHERE status = 'OPEN';
  CREATE TRIGGER IF NOT EXISTS integrity_incidents_no_delete BEFORE DELETE ON integrity_incidents
  BEGIN SELECT RAISE(ABORT, 'integrity_incidents cannot be deleted'); END;

  -- AP-authorized windows (the "prior AP approval" path, e.g. troubleshooting).
  CREATE TABLE IF NOT EXISTS integrity_exemptions (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    component TEXT NOT NULL CHECK (component IN ('PRIVATE_DNS','PHONE_HEARTBEAT','ALL')),
    startsAt TEXT NOT NULL,
    endsAt TEXT NOT NULL,
    reason TEXT NOT NULL,
    grantedBy TEXT NOT NULL,
    revokedAt TEXT,
    revokedBy TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_days_project ON project_days(projectId, localDate);
  CREATE INDEX IF NOT EXISTS idx_reqinst_day ON requirement_instances(projectDayId);
  CREATE INDEX IF NOT EXISTS idx_evidence_req ON evidence(requirementInstanceId);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entityType, entityId);
  CREATE INDEX IF NOT EXISTS idx_violations_project ON violations(projectId);
  `);
}
