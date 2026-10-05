-- Web Controls (NextDNS) — D1 schema, Phase 1–5 foundation.
--
-- Ownership: this database lives in the Accountability Partner's Cloudflare
-- account. The participant has no Cloudflare or NextDNS administrative access.
--
-- History protection: audit_log is append-only and integrity_incidents can
-- never be deleted or have their detection facts rewritten (enforced by
-- triggers below, not just by convention in the service layer).

-- ---------------------------------------------------------------------------
-- Profiles: the two logically separate NextDNS contexts.
-- The NextDNS profile IDs themselves come from Worker vars (AP-controlled).
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  code TEXT PRIMARY KEY CHECK (code IN ('RAY-PIXEL', 'HOME-ROUTER')),
  label TEXT NOT NULL,
  context TEXT NOT NULL CHECK (context IN ('DEVICE', 'NETWORK')),
  -- 1 = activity may be attributed to the participant personally.
  -- HOME-ROUTER is 0: it carries TVs, computers, smart-home devices and guests.
  attributedToParticipant INTEGER NOT NULL CHECK (attributedToParticipant IN (0, 1)),
  lastDnsAt TEXT,
  lastDnsCheckedAt TEXT
);

INSERT INTO profiles (code, label, context, attributedToParticipant) VALUES
  ('RAY-PIXEL', 'Primary Android phone (Private DNS)', 'DEVICE', 1),
  ('HOME-ROUTER', 'Home network (Google Nest Wifi DNS)', 'NETWORK', 0);

-- ---------------------------------------------------------------------------
-- AP-controlled settings (visibility mode, thresholds, filtering policy, ...).
-- Every change is audited by the service layer.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  updatedBy TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Web controls: named services the AP restricts (e.g. "Reddit", "DoorDash").
-- policy = the AP's standing rule. Effective state also considers grants.
-- ---------------------------------------------------------------------------
CREATE TABLE web_controls (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  domains TEXT NOT NULL,              -- JSON array of registrable domains
  nextdnsServiceId TEXT,              -- optional NextDNS parental-control service id
  profiles TEXT NOT NULL,             -- JSON array of profile codes
  policy TEXT NOT NULL CHECK (policy IN ('BLOCKED', 'ALLOWED')),
  note TEXT,
  createdAt TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  archivedBy TEXT
);
CREATE UNIQUE INDEX idx_controls_label ON web_controls(label COLLATE NOCASE) WHERE archivedAt IS NULL;

-- AP allowlist (overrides NextDNS blocklists/categories for these domains).
CREATE TABLE allowlist_entries (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  profiles TEXT NOT NULL,
  note TEXT,
  createdAt TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  archivedAt TEXT,
  archivedBy TEXT
);
CREATE UNIQUE INDEX idx_allow_domain ON allowlist_entries(domain) WHERE archivedAt IS NULL;

-- Monitored domains: surfaced in activity views; never blocks anything.
CREATE TABLE monitored_domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  label TEXT,
  createdAt TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  archivedAt TEXT,
  archivedBy TEXT
);
CREATE UNIQUE INDEX idx_monitored_domain ON monitored_domains(domain) WHERE archivedAt IS NULL;

-- Entries this portal owns inside NextDNS, so reconciliation knows what it may
-- change or remove. Entries created by hand in the NextDNS dashboard are never
-- touched.
CREATE TABLE managed_entries (
  profileCode TEXT NOT NULL,
  list TEXT NOT NULL CHECK (list IN ('denylist', 'allowlist', 'services')),
  entryId TEXT NOT NULL,
  -- Last state this portal confirmed in NextDNS (1/0). A different live value
  -- that the portal did not write is configuration drift.
  appliedActive INTEGER,
  firstManagedAt TEXT NOT NULL,
  PRIMARY KEY (profileCode, list, entryId)
);

-- ---------------------------------------------------------------------------
-- Temporary access.
-- ---------------------------------------------------------------------------
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  controlId TEXT NOT NULL REFERENCES web_controls(id),
  requestedMinutes INTEGER NOT NULL CHECK (requestedMinutes > 0),
  reason TEXT NOT NULL,
  requestedBy TEXT NOT NULL,
  requestedAt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'WITHDRAWN', 'LAPSED')),
  decidedBy TEXT,
  decidedAt TEXT,
  decisionNote TEXT,
  approvedMinutes INTEGER,
  grantId TEXT
);
CREATE INDEX idx_requests_status ON access_requests(status, requestedAt);

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  controlId TEXT NOT NULL REFERENCES web_controls(id),
  requestId TEXT,
  grantedBy TEXT NOT NULL,
  grantedAt TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  expiresAt TEXT NOT NULL,
  -- APPLYING: being pushed to NextDNS. ACTIVE: confirmed applied.
  -- APPLY_FAILED: NextDNS refused; restriction kept (fail closed).
  -- EXPIRED / REVOKED: ended; see restoreStatus for whether NextDNS confirmed.
  status TEXT NOT NULL CHECK (status IN ('APPLYING', 'ACTIVE', 'APPLY_FAILED', 'EXPIRED', 'REVOKED')),
  appliedAt TEXT,
  endedAt TEXT,
  endedBy TEXT,
  restoreStatus TEXT CHECK (restoreStatus IN ('PENDING', 'RESTORED', 'FAILED')),
  restoredAt TEXT,
  lastError TEXT
);
CREATE INDEX idx_grants_status ON access_grants(status, expiresAt);

-- ---------------------------------------------------------------------------
-- Integrity monitoring.
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  profileCode TEXT NOT NULL REFERENCES profiles(code),
  tokenHash TEXT NOT NULL UNIQUE,     -- SHA-256 of the device token; raw token shown once
  createdAt TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  revokedAt TEXT,
  revokedBy TEXT
);

CREATE TABLE heartbeat_challenges (
  nonce TEXT PRIMARY KEY,
  deviceId TEXT NOT NULL REFERENCES devices(id),
  issuedAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  usedAt TEXT
);

CREATE TABLE heartbeats (
  id TEXT PRIMARY KEY,
  deviceId TEXT NOT NULL REFERENCES devices(id),
  receivedAt TEXT NOT NULL,           -- server time; the only trusted timestamp
  deviceTime TEXT,                    -- display only
  network TEXT NOT NULL CHECK (network IN ('WIFI', 'CELLULAR', 'OTHER', 'NONE')),
  privateDnsActive INTEGER,           -- device-reported (LinkProperties.isPrivateDnsActive)
  privateDnsServer TEXT,              -- device-reported (LinkProperties.getPrivateDnsServerName)
  nextdnsTestStatus TEXT,             -- device-reported result of test.nextdns.io
  nextdnsTestProfile TEXT,
  canaryNonce TEXT,
  -- Server-verified: did the device's canary lookup appear in RAY-PIXEL logs?
  canaryStatus TEXT NOT NULL CHECK (canaryStatus IN ('PENDING', 'VERIFIED', 'NOT_FOUND', 'SKIPPED')),
  canaryCheckedAt TEXT,
  recordingAssistant TEXT,
  appVersion TEXT
);
CREATE INDEX idx_heartbeats_device ON heartbeats(deviceId, receivedAt);
CREATE INDEX idx_heartbeats_canary ON heartbeats(canaryStatus, receivedAt);

CREATE TABLE integrity_components (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DEGRADED', 'INTERRUPTED', 'RESTORED', 'UNKNOWN')),
  detail TEXT,
  lastVerifiedActiveAt TEXT,
  statusSince TEXT,
  lastCheckedAt TEXT
);

INSERT INTO integrity_components (code, label, status) VALUES
  ('NEXTDNS_API', 'NextDNS', 'UNKNOWN'),
  ('DNS_RAY_PIXEL', 'Pixel profile', 'UNKNOWN'),
  ('DNS_HOME_ROUTER', 'Home router', 'UNKNOWN'),
  ('PHONE_HEARTBEAT', 'Phone heartbeat', 'UNKNOWN'),
  ('POLICY_ENFORCEMENT', 'Policy enforcement', 'UNKNOWN'),
  ('RECORDING_ASSISTANT', 'Recording Assistant', 'UNKNOWN');

CREATE TABLE integrity_incidents (
  id TEXT PRIMARY KEY,
  componentCode TEXT NOT NULL REFERENCES integrity_components(code),
  kind TEXT NOT NULL CHECK (kind IN ('INTERRUPTION', 'REPORTING_GAP', 'CONFIGURATION_DRIFT', 'ENFORCEMENT_FAILURE')),
  title TEXT NOT NULL,
  lastVerifiedActiveAt TEXT,
  detectedAt TEXT NOT NULL,
  restoredAt TEXT,
  interruptionMinutes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESTORED', 'REVIEWED')),
  evidence TEXT NOT NULL DEFAULT '{}',
  reviewDisposition TEXT,
  reviewNote TEXT,
  reviewedBy TEXT,
  reviewedAt TEXT
);
CREATE INDEX idx_incidents_status ON integrity_incidents(status, detectedAt);

CREATE TRIGGER incidents_no_delete BEFORE DELETE ON integrity_incidents
BEGIN SELECT RAISE(ABORT, 'integrity incidents cannot be deleted'); END;

CREATE TRIGGER incidents_facts_immutable BEFORE UPDATE ON integrity_incidents
WHEN NEW.detectedAt IS NOT OLD.detectedAt
  OR NEW.lastVerifiedActiveAt IS NOT OLD.lastVerifiedActiveAt
  OR NEW.kind IS NOT OLD.kind
  OR NEW.componentCode IS NOT OLD.componentCode
  OR (OLD.restoredAt IS NOT NULL AND NEW.restoredAt IS NOT OLD.restoredAt)
  OR (OLD.status = 'REVIEWED')
  OR (OLD.status = 'RESTORED' AND NEW.status = 'OPEN')
BEGIN SELECT RAISE(ABORT, 'integrity incident history cannot be rewritten'); END;

-- ---------------------------------------------------------------------------
-- Audit trail (append-only).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actorType TEXT NOT NULL CHECK (actorType IN ('AP', 'PARTICIPANT', 'SYSTEM', 'DEVICE')),
  actorId TEXT,
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  action TEXT NOT NULL,
  targetType TEXT NOT NULL,
  targetId TEXT,
  targetLabel TEXT,
  profileCode TEXT,
  previousState TEXT,
  newState TEXT,
  summary TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_target ON audit_log(targetType, targetId);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
