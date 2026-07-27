/**
 * Seed script (blueprint §26.11, §26.12, §28). Creates demonstration users, a
 * project, an ACTIVE configuration from the seed, and a few sample project-day
 * records so the whole system is explorable end-to-end after `npm run seed`.
 *
 * Every value here is demonstration-only and editable via versioned admin. The
 * default passwords are development conveniences — production must rotate them.
 */
import { openDb } from './db.js';
import { createUser } from './auth.js';
import { SEED_CONFIGURATION } from './config.js';
import { createProject, draftConfiguration, activateConfiguration } from './services/projects.js';
import { ensureProjectDay } from './engine.js';
import { submitEvidence, submitWeight, submitExternalLink } from './services/submission.js';
import { verifyEvidence, verifyWeight, setPublicStatus } from './services/review.js';
import { fixedClock, resolveDeadline } from './time.js';

export function seed(dbPath?: string) {
  const db = openDb(dbPath ?? process.env.DB_PATH ?? 'project-console.db');

  // Idempotency: skip if already seeded.
  const existing = db.prepare(`SELECT id FROM projects LIMIT 1`).get();
  if (existing) {
    console.log('Database already seeded. Delete the DB file to reseed.');
    return db;
  }

  const clock = fixedClock('2026-07-27T15:00:00Z');

  const participant = createUser(db, {
    displayName: 'Micheal Ray Berry',
    email: 'participant@michealrayberry.com',
    password: 'participant-dev-pass',
    role: 'PARTICIPANT',
    publicIdentityAllowed: true,
  });
  const ap = createUser(db, {
    displayName: 'Accountability Partner',
    email: 'ap@michealrayberry.com',
    password: 'ap-dev-pass',
    role: 'AP',
  });
  createUser(db, {
    displayName: 'Technical Administrator',
    email: 'admin@michealrayberry.com',
    password: 'admin-dev-pass',
    role: 'TECH_ADMIN',
  });

  const projectId = createProject(
    db,
    {
      name: SEED_CONFIGURATION.identity.projectName,
      participantId: participant.id,
      publicSlug: 'micheal-ray-berry',
      timeZone: SEED_CONFIGURATION.identity.timeZone,
    },
    clock,
  );

  const configId = draftConfiguration(
    db,
    {
      projectId,
      title: 'Seed configuration v1',
      effectiveAt: SEED_CONFIGURATION.dates.effectiveDate,
      configuration: SEED_CONFIGURATION,
      createdBy: ap.id,
      changeSummary: 'Initial seed configuration for demonstration.',
    },
    clock,
  );
  activateConfiguration(db, configId, ap.id, clock);

  // Two sample days: one fully verified & published, one pending review.
  const zone = SEED_CONFIGURATION.identity.timeZone;

  // Day A — verified & public.
  const dayA = '2026-07-25';
  const clockA = fixedClock(resolveDeadline(dayA, '20:00', zone));
  const dayAId = ensureProjectDay(db, projectId, dayA, clockA);
  seedFullDay(db, dayAId, participant.id, ap.id, clockA, true);
  setPublicStatus(db, { table: 'project_days', id: dayAId, status: 'PUBLIC', apId: ap.id }, clockA);

  // Day B — submitted, awaiting AP review.
  const dayB = '2026-07-26';
  const clockB = fixedClock(resolveDeadline(dayB, '21:00', zone));
  const dayBId = ensureProjectDay(db, projectId, dayB, clockB);
  seedFullDay(db, dayBId, participant.id, ap.id, clockB, false);

  console.log('Seed complete.');
  console.log('  Participant : participant@michealrayberry.com / participant-dev-pass');
  console.log('  AP          : ap@michealrayberry.com / ap-dev-pass');
  console.log('  Public slug : micheal-ray-berry');
  return db;
}

function seedFullDay(
  db: import('./db.js').DB,
  dayId: string,
  participantId: string,
  apId: string,
  clock: ReturnType<typeof fixedClock>,
  verify: boolean,
) {
  const reqs = db.prepare(`SELECT * FROM requirement_instances WHERE projectDayId = ?`).all(dayId) as {
    id: string;
    requirementCode: string;
  }[];
  const day = db.prepare(`SELECT projectId FROM project_days WHERE id = ?`).get(dayId) as { projectId: string };

  for (const ri of reqs) {
    if (ri.requirementCode === 'DAILY_VIDEO') {
      const { evidenceId } = submitEvidence(
        db,
        {
          requirementInstanceId: ri.id,
          actorId: participantId,
          type: 'VIDEO',
          sha256: 'demo-hash-' + ri.id,
          sizeBytes: 24_000_000,
          durationMs: 62_000,
          appVersion: '0.1.0',
          scriptVersion: '1.0.0',
          recordingTemplateVersion: '1.0.0',
        },
        clock,
      );
      if (verify) verifyEvidence(db, { evidenceId, apId, note: 'All sequence elements present.' }, clock);
    } else if (ri.requirementCode === 'DAILY_WEIGHT') {
      const w = submitWeight(
        db,
        {
          projectDayId: dayId,
          actorId: participantId,
          weight: 268.4,
          unit: 'lb',
          measurementType: 'STANDARD',
          requirementInstanceId: ri.id,
        },
        clock,
      );
      if (verify) verifyWeight(db, { weightId: w.weightId, apId, publish: true }, clock);
    } else if (ri.requirementCode === 'WEBSITE_UPDATE' || ri.requirementCode === 'X_CHECKIN') {
      submitExternalLink(
        db,
        {
          requirementInstanceId: ri.id,
          actorId: participantId,
          platform: ri.requirementCode === 'X_CHECKIN' ? 'x' : 'website',
          url:
            ri.requirementCode === 'X_CHECKIN'
              ? 'https://x.com/example/status/1'
              : 'https://michealrayberry.com/updates/1',
        },
        clock,
      );
    } else {
      // Tracking + others: attach a generic tracking evidence record.
      const { evidenceId } = submitEvidence(
        db,
        { requirementInstanceId: ri.id, actorId: participantId, type: 'TRACKING' },
        clock,
      );
      if (verify) verifyEvidence(db, { evidenceId, apId }, clock);
    }
  }
}

// Run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
}
