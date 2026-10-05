'use strict';
const TZ = 'America/New_York';
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '—';
const stamp = (iso) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const ICON = { ACTIVE: '●', REPORTING: '●', BLOCKED: '■', TEMPORARILY_ALLOWED: '◷', ALLOWED: '○', DEGRADED: '▲', INTERRUPTED: '✕', RESTORED: '↺', UNKNOWN: '?', PENDING: '◷', FAILED: '✕', ARCHIVED: '–' };
const LABEL = { ACTIVE: 'ACTIVE', TEMPORARILY_ALLOWED: 'TEMPORARILY ALLOWED' };
// Status is always shown as icon + text, never by color alone.
const badge = (s, text) => `<span class="status s-${esc(s)}">${ICON[s] ?? ''} ${esc(text ?? LABEL[s] ?? String(s).replace(/_/g, ' '))}</span>`;

// Local development only: ?as=ap@example.test is forwarded as X-Dev-User; the Worker refuses it in production.
const devUser = (() => { if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null;
  const q = new URLSearchParams(location.search).get('as'); if (q) sessionStorage.setItem('devUser', q); return sessionStorage.getItem('devUser'); })();

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(devUser ? { 'X-Dev-User': devUser } : {}) };
  const res = await fetch(path, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const put = (path, body = {}) => api(path, { method: 'PUT', body });

function toast(text, ok = true) { const t = $('toast'); t.className = 'msg ' + (ok ? 'ok' : 'err'); t.textContent = text; if (ok) setTimeout(() => { if (t.textContent === text) t.textContent = ''; }, 6000); }
async function act(fn, okText) { try { const r = await fn(); if (r && r.applied === false) toast('Saved, but NextDNS did not confirm: ' + (r.errors || []).join('; ') + ' — the Worker will keep retrying.', false); else if (okText) toast(okText); await refresh(); return r; } catch (e) { toast(e.message, false); } }

let me = null, controls = [], settings = null, auditBefore = null;
const TABS_AP = [['overview', 'Overview'], ['requests', 'Requests'], ['activity', 'Activity'], ['integrity', 'Integrity'], ['policy', 'Policy'], ['devices', 'Devices'], ['audit', 'Audit']];
const TABS_P = [['overview', 'Overview'], ['requests', 'Requests'], ['integrity', 'Integrity'], ['audit', 'Audit']];

function showTab(tab) {
  document.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('hide', el.dataset.tab !== tab));
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.t === tab));
  if (tab === 'audit') loadAudit(true);
  if (tab === 'policy') loadPolicy();
  if (tab === 'devices') loadDevices();
  if (tab === 'integrity') loadIncidents();
}

async function boot() {
  try { me = await api('/api/me'); } catch (e) { $('boot').textContent = 'Not authorized: ' + e.message; return; }
  $('who').textContent = `${me.email} · ${me.role === 'AP' ? 'Accountability Partner' : 'Participant (read-only controls)'}`;
  const isAP = me.role === 'AP';
  document.querySelectorAll('.ap-only').forEach((el) => el.classList.toggle('hide', !isAP));
  document.querySelectorAll('.participant-only').forEach((el) => el.classList.toggle('hide', isAP));
  $('nav').innerHTML = (isAP ? TABS_AP : TABS_P).map(([t, l]) => `<a data-t="${t}">${l}</a>`).join('');
  document.querySelectorAll('nav a').forEach((a) => (a.onclick = () => showTab(a.dataset.t)));
  $('boot').classList.add('hide'); $('app').classList.remove('hide');
  showTab('overview');
  await refresh();
  setInterval(refresh, 60_000);
}

async function refresh() {
  const [status, integ, ctl, reqs] = await Promise.all([api('/api/status'), api('/api/integrity'), api('/api/controls'), api('/api/requests')]);
  controls = ctl;
  renderSystem(integ); renderNextDns(status); renderControls(); renderRequests(reqs);
  if (me.role === 'AP') renderGrants(await api('/api/ap/grants'));
}

function renderSystem(i) {
  const label = { NEXTDNS_API: 'NextDNS', DNS_RAY_PIXEL: 'Pixel profile', DNS_HOME_ROUTER: 'Home router', PHONE_HEARTBEAT: 'Phone heartbeat', POLICY_ENFORCEMENT: 'Policy enforcement', RECORDING_ASSISTANT: 'Recording Assistant' };
  const word = (c) => c.code === 'PHONE_HEARTBEAT' && c.status === 'ACTIVE' ? 'ONLINE' : c.code === 'RECORDING_ASSISTANT' && c.status === 'ACTIVE' ? 'READY' : (c.code.startsWith('DNS_') && c.status === 'ACTIVE' ? 'REPORTING' : undefined);
  $('sys').innerHTML = i.components.map((c) => `<div class="sysrow"><div>${esc(label[c.code] || c.label)}<div class="d">${esc(c.detail || '')}${c.lastVerifiedActiveAt ? ` · last verified ${esc(stamp(c.lastVerifiedActiveAt))}` : ''}</div></div>${badge(c.status, word(c))}</div>`).join('');
  $('headline').innerHTML = `${badge(i.overall)} &nbsp;${esc(i.headline)}${i.awaitingReview ? ` · ${i.awaitingReview} awaiting AP review` : ''}`;
  $('rule1').textContent = i.rules.accountability; $('rule2').textContent = i.rules.monitoringLoss;
}

function renderNextDns(s) {
  $('nextdns').innerHTML = `<div class="sysrow"><div>NEXTDNS<div class="d">${esc(s.nextdns.detail || '')}</div></div>${badge(s.nextdns.status)}</div>` +
    s.profiles.map((p) => `<div class="sysrow"><div>${esc(p.code)} <span class="muted">— ${esc(p.label)}${p.attributedToParticipant ? '' : ' · not attributed to Micheal personally'}</span><div class="d">${p.configured ? '' : 'Profile id not configured · '}Last DNS: ${esc(stamp(p.lastDnsAt))}</div></div>${badge(p.status, p.status === 'ACTIVE' ? 'REPORTING' : undefined)}</div>`).join('');
}

function renderControls() {
  const isAP = me.role === 'AP';
  $('controls').innerHTML = controls.length ? controls.map((c) => {
    const expires = c.activeGrant ? ` · expires ${esc(time(c.activeGrant.expiresAt))}` : '';
    let actions = '';
    if (isAP) {
      if (c.state === 'BLOCKED') actions = `<button data-a="grant" data-id="${c.id}">GRANT ACCESS</button><button class="sec" data-a="allow" data-id="${c.id}">Allow</button>`;
      if (c.state === 'TEMPORARILY_ALLOWED') actions = `<button class="bad" data-a="restore" data-id="${c.id}">End access now</button>`;
      if (c.state === 'ALLOWED') actions = `<button data-a="block" data-id="${c.id}">Block</button>`;
      actions += `<button class="sec" data-a="archive" data-id="${c.id}">Remove</button>`;
    } else if (c.state === 'BLOCKED') actions = `<button class="sec" data-a="request" data-id="${c.id}">Request access</button>`;
    return `<tr><td><b>${esc(c.label)}</b><div class="muted mono">${esc(c.domains.join(', '))}${c.nextdnsServiceId ? ` · service:${esc(c.nextdnsServiceId)}` : ''}</div></td>
      <td>${badge(c.state)}${expires}</td><td class="muted">${esc(c.profiles.join(' + '))}</td><td>${actions}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">No web controls yet.</td></tr>';
  $('controls').querySelectorAll('button').forEach((b) => (b.onclick = () => controlAction(b.dataset.a, b.dataset.id)));
  $('r-control').innerHTML = controls.filter((c) => c.state === 'BLOCKED').map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
}

async function controlAction(a, id) {
  const c = controls.find((x) => x.id === id);
  if (a === 'grant') { const m = parseInt(prompt(`Grant ${c.label} access for how many minutes?`, '30'), 10); if (!m) return;
    return act(() => post(`/api/ap/controls/${id}/grant`, { minutes: m, note: prompt('Note (optional):') || null }), `${c.label} temporarily allowed for ${m} minutes.`); }
  if (a === 'restore') return act(() => post(`/api/ap/controls/${id}/restore`, { reason: prompt('Reason (optional):') || null }), `${c.label} restriction restored.`);
  if (a === 'allow') { if (!confirm(`Lift the standing restriction on ${c.label}? Use GRANT ACCESS for time-limited access.`)) return;
    return act(() => post(`/api/ap/controls/${id}/allow`, { reason: prompt('Reason:') || null }), `${c.label} allowed.`); }
  if (a === 'block') return act(() => post(`/api/ap/controls/${id}/block`, { reason: null }), `${c.label} blocked.`);
  if (a === 'archive') { const r = prompt(`Remove the ${c.label} control? Its NextDNS entries will be deleted. Reason (required):`); if (!r) return;
    return act(() => post(`/api/ap/controls/${id}/archive`, { reason: r }), `${c.label} removed.`); }
  if (a === 'request') { showTab('requests'); $('r-control').value = id; $('r-reason').focus(); }
}

$('b-btn').onclick = () => {
  const p = $('b-profiles').value;
  act(() => post('/api/ap/controls/block', { domain: $('b-domain').value, label: $('b-label').value || undefined,
    profiles: p === 'both' ? undefined : [p], nextdnsServiceId: $('b-service').value || null, note: $('b-note').value || null }), 'Blocked.')
    .then(() => { ['b-domain', 'b-label', 'b-service', 'b-note'].forEach((k) => ($(k).value = '')); });
};
$('r-btn').onclick = () => act(() => post('/api/requests', { controlId: $('r-control').value, minutes: parseInt($('r-min').value, 10), reason: $('r-reason').value }), 'Request submitted to the AP.')
  .then(() => ($('r-reason').value = ''));
$('runChecks').onclick = () => act(() => post('/api/ap/integrity/run'), 'Integrity checks complete.');

function renderRequests(rows) {
  const isAP = me.role === 'AP';
  $('requests').innerHTML = rows.length ? rows.map((r) => `<div class="incident">
    <div class="t">ACCESS REQUEST ${badge(r.status === 'APPROVED' ? 'ACTIVE' : r.status === 'PENDING' ? 'PENDING' : 'UNKNOWN', r.status)}</div>
    <div class="kv"><div>Service</div><div>${esc(r.controlLabel)}</div><div>Requested duration</div><div>${r.requestedMinutes} minutes</div>
    <div>Reason</div><div>${esc(r.reason)}</div><div>Requested</div><div>${esc(stamp(r.requestedAt))}</div>
    ${r.decidedAt ? `<div>Decision</div><div>${esc(r.status)} ${r.approvedMinutes ? `(${r.approvedMinutes} min)` : ''} ${esc(r.decisionNote || '')} · ${esc(stamp(r.decidedAt))}</div>` : ''}
    ${r.grantStatus ? `<div>Grant</div><div>${esc(r.grantStatus)}${r.grantExpiresAt ? ` · expires ${esc(time(r.grantExpiresAt))}` : ''}${r.grantError ? ` · ${esc(r.grantError)}` : ''}</div>` : ''}</div>
    ${r.status === 'PENDING' ? (isAP ? `<div style="margin-top:8px"><button data-d="APPROVE" data-id="${r.id}">APPROVE</button><button class="sec" data-d="CUSTOM" data-id="${r.id}" data-m="${r.requestedMinutes}">APPROVE WITH DIFFERENT DURATION</button><button class="bad" data-d="DENY" data-id="${r.id}">DENY</button></div>`
      : `<div style="margin-top:8px"><button class="sec" data-w="${r.id}">Withdraw</button></div>`) : ''}
  </div>`).join('') : '<div class="muted">No requests.</div>';
  $('requests').querySelectorAll('button[data-d]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.id;
    if (b.dataset.d === 'DENY') return act(() => post(`/api/ap/requests/${id}/decision`, { decision: 'DENY', note: prompt('Reason for denial (optional):') || null }), 'Request denied.');
    let minutes;
    if (b.dataset.d === 'CUSTOM') { minutes = parseInt(prompt('Approve for how many minutes?', b.dataset.m), 10); if (!minutes) return; }
    act(() => post(`/api/ap/requests/${id}/decision`, { decision: 'APPROVE', minutes }), 'Approved — access applied in NextDNS.');
  }));
  $('requests').querySelectorAll('button[data-w]').forEach((b) => (b.onclick = () => act(() => post(`/api/requests/${b.dataset.w}/withdraw`), 'Request withdrawn.')));
}

function renderGrants(rows) {
  $('grants').innerHTML = rows.map((g) => `<tr><td>${esc(g.controlLabel)}</td><td>${esc(stamp(g.grantedAt))}<div class="muted">${esc(g.grantedBy)}</div></td><td>${g.minutes} min</td>
    <td>${esc(time(g.expiresAt))}</td><td>${badge(g.status === 'ACTIVE' ? 'TEMPORARILY_ALLOWED' : g.status === 'APPLY_FAILED' ? 'FAILED' : 'UNKNOWN', g.status)}</td>
    <td>${g.restoreStatus ? badge(g.restoreStatus === 'RESTORED' ? 'BLOCKED' : g.restoreStatus === 'FAILED' ? 'FAILED' : 'PENDING', g.restoreStatus) : ''}${g.restoredAt ? ` ${esc(time(g.restoredAt))}` : ''}${g.lastError ? `<div class="muted">${esc(g.lastError)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None.</td></tr>';
}

$('a-btn').onclick = async () => {
  try {
    const p = await api(`/api/ap/activity?profile=${encodeURIComponent($('a-profile').value)}&from=${encodeURIComponent($('a-from').value)}`);
    $('a-out').classList.remove('hide');
    $('a-out').className = p.context === 'NETWORK' ? 'home' : 'pixel';
    $('a-heading').textContent = p.heading; $('a-attr').textContent = p.attribution; $('interp').textContent = p.interpretation;
    $('a-mode').textContent = `Visibility mode: ${p.visibilityMode.replace(/_/g, ' ')}`;
    const sig = { BLOCKED_ATTEMPT: 'BLOCKED', MONITORED_DOMAIN: 'PENDING', CONTROLLED_DOMAIN: 'PENDING', DNS_QUERY: 'UNKNOWN' };
    $('a-rows').innerHTML = p.events.map((e) => `<tr><td>${esc(stamp(e.timestamp))}</td><td class="mono">${esc(e.domain)}</td><td>${badge(sig[e.signal], e.signal.replace(/_/g, ' '))}</td><td>${esc(e.matched || '')}</td><td class="muted">${esc(e.deviceName || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No events in this window for the current visibility mode.</td></tr>';
  } catch (e) { toast(e.message, false); }
};

async function loadIncidents() {
  const rows = await api('/api/incidents');
  const isAP = me.role === 'AP';
  $('incidents').innerHTML = rows.length ? rows.map((i) => `<div class="incident">
    <div class="t">${esc(i.title)}</div>
    <div class="kv"><div>Kind</div><div>${esc(i.kind.replace(/_/g, ' '))}</div>
      <div>Last verified active</div><div>${esc(stamp(i.lastVerifiedActiveAt))}</div>
      <div>Failure detected</div><div>${esc(stamp(i.detectedAt))}</div>
      <div>Restored</div><div>${i.restoredAt ? esc(stamp(i.restoredAt)) : 'Ongoing'}</div>
      <div>Interruption</div><div>${i.interruptionMinutes != null ? `${i.interruptionMinutes} minutes` : i.ongoingMinutes != null ? `${i.ongoingMinutes} minutes so far` : '—'}</div>
      <div>Status</div><div>${i.status === 'RESTORED' ? badge('RESTORED', 'AP REVIEW REQUIRED') : i.status === 'OPEN' ? badge('INTERRUPTED', 'OPEN') : badge('ACTIVE', 'REVIEWED')}</div>
      <div>Detail</div><div class="muted">${esc(i.evidence?.detail || (Array.isArray(i.evidence) ? i.evidence.map((e) => `${e.profile}: ${e.drift.map((d) => `${d.list} ${d.id} ${d.from}→${d.to}`).join(', ')}`).join(' | ') : ''))}</div>
      ${i.reviewedAt ? `<div>AP review</div><div>${esc(i.reviewDisposition.replace(/_/g, ' '))} — ${esc(i.reviewNote)} · ${esc(stamp(i.reviewedAt))}</div>` : ''}</div>
    ${isAP && i.status === 'RESTORED' ? `<div class="row" style="margin-top:8px"><div><select data-disp="${i.id}"><option value="TECHNICAL_NO_ACTION">Technical cause — no action</option><option value="AUTHORIZED">Authorized / safety / emergency</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="REFERRED_FOR_VIOLATION_REVIEW">Refer for violation review</option></select></div><div><input data-note="${i.id}" placeholder="Review note (required)" /></div><div><button data-rev="${i.id}">Record review</button></div></div>` : ''}
  </div>`).join('') : '<div class="muted">No integrity incidents recorded.</div>';
  $('incidents').querySelectorAll('button[data-rev]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.rev;
    await act(() => post(`/api/ap/incidents/${id}/review`, { disposition: document.querySelector(`[data-disp="${id}"]`).value, note: document.querySelector(`[data-note="${id}"]`).value }), 'Review recorded.');
    loadIncidents();
  }));
}

async function loadPolicy() {
  const s = await api('/api/ap/settings'); settings = s.settings;
  $('v-mode').value = settings.visibilityMode; $('l-max').value = settings.maxGrantMinutes; $('l-lapse').value = settings.requestLapseMinutes;
  const [allow, mon] = await Promise.all([api('/api/ap/allowlist'), api('/api/ap/monitored')]);
  $('allow').innerHTML = allow.map((a) => `<div class="sysrow"><div class="mono">${esc(a.domain)} <span class="muted">${esc(a.profiles.join(' + '))} ${esc(a.note || '')}</span></div><button class="sec" data-al="${a.id}">Remove</button></div>`).join('') || '<div class="muted">Empty.</div>';
  $('mon').innerHTML = mon.map((m) => `<div class="sysrow"><div class="mono">${esc(m.domain)} <span class="muted">${esc(m.label || '')}</span></div><button class="sec" data-mo="${m.id}">Remove</button></div>`).join('') || '<div class="muted">Empty.</div>';
  $('allow').querySelectorAll('button').forEach((b) => (b.onclick = () => act(() => post(`/api/ap/allowlist/${b.dataset.al}/remove`, { reason: prompt('Reason:') || null }), 'Removed.').then(loadPolicy)));
  $('mon').querySelectorAll('button').forEach((b) => (b.onclick = () => act(() => post(`/api/ap/monitored/${b.dataset.mo}/remove`, { reason: null }), 'Removed.').then(loadPolicy)));
  const cats = s.options.categories;
  $('filtering').innerHTML = ['RAY-PIXEL', 'HOME-ROUTER'].map((p) => {
    const f = settings.filtering[p];
    const cb = (k, l, v) => `<label style="display:inline-flex;gap:6px;align-items:center;margin-right:14px"><input type="checkbox" style="width:auto" data-f="${p}" data-k="${k}" ${v ? 'checked' : ''} ${f ? '' : 'disabled'} /> ${l}</label>`;
    return `<h3>${p}</h3><label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" style="width:auto" data-managed="${p}" ${f ? 'checked' : ''}/> Managed by the AP Portal</label><div>
      ${cb('safeSearch', 'SafeSearch', f?.safeSearch)}${cb('youtubeRestrictedMode', 'YouTube Restricted Mode', f?.youtubeRestrictedMode)}${cb('blockBypass', 'Block bypass methods (VPNs/proxies)', f?.blockBypass)}</div>
      <div class="muted" style="margin-top:6px">Block categories:</div><div>${cats.map((c) => cb('cat:' + c, c, f?.categories?.[c])).join('')}</div>
      <button style="margin-top:6px" data-save="${p}">Save ${p} filtering</button>`;
  }).join('');
  $('filtering').querySelectorAll('[data-managed]').forEach((el) => (el.onchange = () => $('filtering').querySelectorAll(`[data-f="${el.dataset.managed}"]`).forEach((x) => (x.disabled = !el.checked))));
  $('filtering').querySelectorAll('button[data-save]').forEach((b) => (b.onclick = () => {
    const p = b.dataset.save;
    const managed = document.querySelector(`[data-managed="${p}"]`).checked;
    let policy = null;
    if (managed) { policy = { categories: {} };
      $('filtering').querySelectorAll(`[data-f="${p}"]`).forEach((x) => { const k = x.dataset.k; if (k.startsWith('cat:')) policy.categories[k.slice(4)] = x.checked; else policy[k] = x.checked; }); }
    act(() => put('/api/ap/settings/filtering', { profile: p, policy, reason: prompt('Reason (optional):') || null }), `${p} filtering saved.`).then(loadPolicy);
  }));
}
$('v-btn').onclick = () => act(() => put('/api/ap/settings/visibility', { mode: $('v-mode').value, reason: $('v-reason').value }), 'Visibility mode saved.').then(() => ($('v-reason').value = ''));
$('al-btn').onclick = () => act(() => post('/api/ap/allowlist', { domain: $('al-domain').value, note: $('al-note').value || null }), 'Allowlisted.').then(loadPolicy);
$('mo-btn').onclick = () => act(() => post('/api/ap/monitored', { domain: $('mo-domain').value, label: $('mo-label').value || null }), 'Monitoring added.').then(loadPolicy);
$('l-btn').onclick = () => act(() => put('/api/ap/settings/limits', { maxGrantMinutes: parseInt($('l-max').value, 10), requestLapseMinutes: parseInt($('l-lapse').value, 10) }), 'Limits saved.');

async function loadDevices() {
  const rows = await api('/api/ap/devices');
  $('devices').innerHTML = rows.map((d) => `<div class="sysrow"><div>${esc(d.label)} <span class="muted">${esc(d.profileCode)} · last heartbeat ${esc(stamp(d.lastHeartbeatAt))}</span></div>${d.revokedAt ? badge('ARCHIVED', 'REVOKED') : `<button class="sec" data-dev="${d.id}">Revoke</button>`}</div>`).join('') || '<div class="muted">No devices registered.</div>';
  $('devices').querySelectorAll('button').forEach((b) => (b.onclick = () => act(() => post(`/api/ap/devices/${b.dataset.dev}/revoke`, { reason: prompt('Reason:') || null }), 'Revoked.').then(loadDevices)));
}
$('d-btn').onclick = async () => {
  try { const r = await post('/api/ap/devices', { label: $('d-label').value }); $('d-token').classList.remove('hide'); $('d-token-v').textContent = r.token; loadDevices(); }
  catch (e) { toast(e.message, false); }
};

async function loadAudit(reset) {
  if (reset) { auditBefore = null; $('audit').innerHTML = ''; }
  const rows = await api(`/api/audit?limit=100${auditBefore ? `&before=${encodeURIComponent(auditBefore)}` : ''}`);
  if (rows.length) auditBefore = rows[rows.length - 1].ts;
  $('audit').insertAdjacentHTML('beforeend', rows.map((r) => `<tr><td>${esc(stamp(r.ts))}</td><td>${esc(r.actorType)}<div class="muted">${esc(r.actorId || '')}</div></td>
    <td>${esc(r.summary)}${r.reason ? `<div class="muted">Reason: ${esc(r.reason)}</div>` : ''}</td><td>${r.automatic ? 'Automatic' : 'Manual'}</td></tr>`).join(''));
}
$('audit-more').onclick = () => loadAudit(false);

boot();
