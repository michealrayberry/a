/**
 * Embeddable public-status widget for michealrayberry.com (blueprint §5.5).
 *
 * Drop-in usage on the website:
 *   <div id="mrb-status" data-api="https://api.michealrayberry.com" data-slug="micheal-ray-berry"></div>
 *   <script src="https://api.michealrayberry.com/app/../integration/status-widget.js" defer></script>
 *
 * It reads ONLY the read-only public API (no auth) and renders a compact status
 * card. All values come from records the AP has explicitly published.
 */
(function () {
  function fmt(n) {
    return n === null || n === undefined ? '—' : n;
  }
  async function render(el) {
    const base = el.getAttribute('data-api') || '';
    const slug = el.getAttribute('data-slug') || 'micheal-ray-berry';
    el.style.cssText =
      'font-family:system-ui,sans-serif;border:1px solid #e2e6ea;border-radius:10px;padding:16px;max-width:420px';
    el.innerHTML = '<div style="color:#5b6470;font-size:13px">Loading accountability status…</div>';
    try {
      const res = await fetch(`${base}/public/status?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('unavailable');
      const s = await res.json();
      const stat = (label, value, sub) =>
        `<div style="flex:1;min-width:90px"><div style="font-size:11px;color:#5b6470;text-transform:uppercase;letter-spacing:.05em">${label}</div>` +
        `<div style="font-size:22px;font-weight:600;font-variant-numeric:tabular-nums">${fmt(value)}<span style="font-size:12px;color:#5b6470"> ${sub || ''}</span></div></div>`;
      el.innerHTML =
        `<div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#5b6470">Accountability Status</div>` +
        `<div style="font-weight:650;margin:2px 0 12px">${s.project}</div>` +
        `<div style="display:flex;gap:14px;flex-wrap:wrap">` +
        stat('Current', s.currentVerifiedWeight, s.unit) +
        stat('Change', s.totalVerifiedChange, s.unit) +
        stat('Goal', s.goalWeight, s.unit) +
        stat('Day', s.currentProjectDay, '') +
        `</div>` +
        `<div style="margin-top:12px;font-size:12px;color:#5b6470">Latest day: ${(s.latestDayStatus || '—').replace(/_/g, ' ')} · Updated ${s.lastUpdated ? new Date(s.lastUpdated).toLocaleDateString() : '—'}</div>`;
    } catch (e) {
      el.innerHTML = '<div style="color:#8a1f1f;font-size:13px">Status temporarily unavailable.</div>';
    }
  }
  function init() {
    document.querySelectorAll('#mrb-status,[data-mrb-status]').forEach(render);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
