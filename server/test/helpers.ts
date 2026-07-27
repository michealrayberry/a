import { openDb, type DB } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { SEED_CONFIGURATION, type ProjectConfiguration } from '../src/config.js';
import { createProject, draftConfiguration, activateConfiguration } from '../src/services/projects.js';
import { fixedClock, type Clock } from '../src/time.js';

export interface Harness {
  db: DB;
  app: ReturnType<typeof createApp>;
  projectId: string;
  participantId: string;
  apId: string;
  clock: Clock;
}

/** Build an in-memory harness with one project + active config. */
export function makeHarness(opts?: { nowIso?: string; config?: ProjectConfiguration }): Harness {
  const db = openDb(':memory:');
  const clock = fixedClock(opts?.nowIso ?? '2026-07-27T15:00:00Z');
  const participant = createUser(db, {
    displayName: 'Micheal Ray Berry',
    email: 'p@example.com',
    password: 'pw',
    role: 'PARTICIPANT',
  });
  const ap = createUser(db, { displayName: 'AP', email: 'ap@example.com', password: 'pw', role: 'AP' });
  const projectId = createProject(
    db,
    { name: 'Test', participantId: participant.id, publicSlug: 'test', timeZone: 'America/New_York' },
    clock,
  );
  const cfgId = draftConfiguration(
    db,
    {
      projectId,
      title: 'v1',
      effectiveAt: (opts?.config ?? SEED_CONFIGURATION).dates.effectiveDate,
      configuration: opts?.config ?? SEED_CONFIGURATION,
      createdBy: ap.id,
    },
    clock,
  );
  activateConfiguration(db, cfgId, ap.id, clock);
  const app = createApp(db, clock);
  return { db, app, projectId, participantId: participant.id, apId: ap.id, clock };
}
