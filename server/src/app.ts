import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DB } from './db.js';
import { systemClock, type Clock } from './time.js';
import { authRouter } from './routes/authRoutes.js';
import { participantRouter } from './routes/participant.js';
import { apRouter } from './routes/ap.js';
import { publicRouter } from './routes/publicApi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Assemble the Express app. The clock is injectable so tests can pin time and
 * so scheduled runs are deterministic (blueprint §3.2, §20 time-based tests).
 */
export function createApp(db: DB, clock: Clock = systemClock): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, time: clock.now().toISO() }));

  app.use('/auth', authRouter(db, clock));
  app.use('/participant', participantRouter(db, clock));
  app.use('/ap', apRouter(db, clock));
  app.use('/public', publicRouter(db));

  // Static web surfaces (public record, AP portal, participant client).
  const webRoot = path.resolve(__dirname, '../../web');
  app.use('/', express.static(path.join(webRoot, 'public-record')));
  app.use('/portal', express.static(path.join(webRoot, 'portal')));
  app.use('/app', express.static(path.join(webRoot, 'participant')));

  return app;
}
