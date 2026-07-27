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

  CREATE INDEX IF NOT EXISTS idx_days_project ON project_days(projectId, localDate);
  CREATE INDEX IF NOT EXISTS idx_reqinst_day ON requirement_instances(projectDayId);
  CREATE INDEX IF NOT EXISTS idx_evidence_req ON evidence(requirementInstanceId);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entityType, entityId);
  CREATE INDEX IF NOT EXISTS idx_violations_project ON violations(projectId);
  `);
}
