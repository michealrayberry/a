import { openDb } from './db.js';
import { createApp } from './app.js';
import { runDeadlineSweep } from './engine.js';
import { systemClock } from './time.js';
import { nextDnsFromEnv } from './nextdns/gateway.js';
import { runWebControlSweep } from './services/webControls.js';
import { runIntegritySweep } from './services/integrity.js';

const db = openDb();
const nextdns = nextDnsFromEnv();
const app = createApp(db, systemClock, nextdns);
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

// Web-controls sweep: expires temporary NextDNS access and restores the
// restriction automatically, then retries any policy NextDNS has not accepted.
// On the Cloudflare Worker target this is a Cron Trigger (docs/NEXTDNS.md).
const WEB_SWEEP_MS = Number(process.env.WEB_CONTROL_SWEEP_MS ?? 30_000);
setInterval(() => {
  runWebControlSweep(db, nextdns, systemClock).catch((e) => console.error('web-control sweep failed', e));
}, WEB_SWEEP_MS).unref();

// Monitoring-integrity sweep: heartbeat staleness every pass; NextDNS health
// checks are throttled inside the sweep (NEXTDNS_CHECK_INTERVAL_MINUTES).
const INTEGRITY_SWEEP_MS = Number(process.env.INTEGRITY_SWEEP_MS ?? 60_000);
setInterval(() => {
  runIntegritySweep(db, nextdns, systemClock).catch((e) => console.error('integrity sweep failed', e));
}, INTEGRITY_SWEEP_MS).unref();

app.listen(port, () => {
  console.log(`Project Console backend listening on http://localhost:${port}`);
  console.log(`  Public record : http://localhost:${port}/`);
  console.log(`  AP portal     : http://localhost:${port}/portal/`);
  console.log(`  Participant   : http://localhost:${port}/app/`);
  console.log(`  NextDNS       : ${nextdns ? nextdns.mode : 'NOT CONFIGURED'}`);
});
