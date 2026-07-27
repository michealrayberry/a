import { openDb } from './db.js';
import { createApp } from './app.js';
import { runDeadlineSweep } from './engine.js';
import { systemClock } from './time.js';

const db = openDb();
const app = createApp(db, systemClock);
const port = Number(process.env.PORT ?? 3000);

// Scheduled deadline engine (blueprint §9.2). In production this is a scheduled
// server function; here we run it on an interval against every active project.
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 60_000);
setInterval(() => {
  try {
    const projects = db.prepare(`SELECT id FROM projects WHERE status = 'ACTIVE'`).all() as { id: string }[];
    for (const p of projects) runDeadlineSweep(db, p.id, systemClock);
  } catch (e) {
    console.error('deadline sweep failed', e);
  }
}, SWEEP_MS).unref();

app.listen(port, () => {
  console.log(`Project Console backend listening on http://localhost:${port}`);
  console.log(`  Public record : http://localhost:${port}/`);
  console.log(`  AP portal     : http://localhost:${port}/portal/`);
  console.log(`  Participant   : http://localhost:${port}/app/`);
});
