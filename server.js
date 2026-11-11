require('dotenv').config();
const path = require('path');
const express = require('express');
const { current, startLoad, state, CACHE_MS } = require('./lib/data');
const A = require('./lib/analytics');
const { baseUrl } = require('./lib/odoo');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/healthz', (_req, res) => res.send('ok'));

// Optional HTTP Basic protection — the dashboard exposes lead names, emails and phone numbers.
if (process.env.DASHBOARD_PASSWORD) {
  const user = process.env.DASHBOARD_USER || 'sugimoto';
  const expected = 'Basic ' + Buffer.from(`${user}:${process.env.DASHBOARD_PASSWORD}`).toString('base64');
  app.use((req, res, next) => {
    if (req.headers.authorization === expected) return next();
    res.set('WWW-Authenticate', 'Basic realm="Sugimoto Dashboard"').status(401).send('Authentication required');
  });
} else {
  console.warn('[security] DASHBOARD_PASSWORD not set: the dashboard is open to anyone with the URL');
}

// Chart.js is served from here, not a CDN: on some phone networks the CDN did not load and every tab failed.
app.get('/vendor/chart.umd.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));
app.use(express.static(path.join(__dirname, 'public')));

// Answers from cache. With no data yet, replies 503 {syncing:true} (or 502 with the Odoo error) so the
// browser can poll instead of holding a request open past Render's proxy timeout.
const notReady = (res) => (state.promise || !state.error
  ? res.status(503).json({ syncing: true, error: 'Syncing from Odoo, first load can take a few minutes' })
  : res.status(502).json({ error: state.error }));
const { ROUTES, run, scoped, retargetPool } = require('./lib/routes');
// The loaded data plus what the answers need that is not in it.
const loaded = () => { const d = current(); return d && { ...d, odooUrl: baseUrl() }; };
const route = (name) => (req, res) => {
  const d = loaded();
  if (!d) return notReady(res);
  try { res.json(run(name, d, req.query)); } catch (e) { res.status(500).json({ error: e.message }); }
};

app.get('/api/status', (_req, res) => {
  const d = current();
  res.json({
    total_leads: d ? d.leads.length : 0,
    historical_leads: d ? d.leads.filter((l) => l.historical).length : 0,
    native_leads: d ? d.leads.filter((l) => !l.historical).length : 0,
    historical_tags: d ? d.historicalTags : null,
    crm_tags: d ? Object.entries(d.leads.reduce((m, l) => { l.tags.forEach((t) => { m[t] = (m[t] || 0) + 1; }); return m; }, {}))
      .map(([name, leads]) => ({ name, leads })).sort((a, b) => b.leads - a.leads) : null,
    lost_reasons: d ? Object.entries(d.leads.reduce((m, l) => { if (l.lostReason) m[l.lostReason] = (m[l.lostReason] || 0) + 1; return m; }, {}))
      .map(([name, leads]) => ({ name, leads })).sort((a, b) => b.leads - a.leads) : null,
    contracts_feed: d && d.sheet ? { read_at: d.sheet.generatedAt, live: d.sheet.live, error: d.sheet.error, rows: d.sheet.rows.length } : null,
    last_sync: d ? new Date(d.fetchedAt).toISOString() : null,
    cache_age_seconds: d ? Math.round((Date.now() - d.fetchedAt) / 1000) : null,
    last_sync_detail: d ? d.sync : null,
    cache_ttl_seconds: CACHE_MS / 1000,
    syncing: !!state.promise,
    last_error: state.error,
    odoo_url: baseUrl(),
    fields: d ? {
      contract_type: d.det.contractType, contract_value: d.det.contractValue,
      historical_date: d.det.histDate, historical_date_candidates: d.det.histDateCandidates,
      segments: Object.fromEntries(Object.entries(d.det.segments).map(([k, v]) => [k, v.name])),
      fetched: d.fields, skipped: d.missing,
    } : null,
  });
});
for (const name of Object.keys(ROUTES)) app.get(`/api/${name}`, route(name));
app.get('/api/refresh', (req, res) => {
  startLoad(true, req.query.full === '1'); // runs in the background; poll /api/status (syncing / last_sync)
  res.status(202).json({ started: true, syncing: true });
});
const FM_COLS = ['date', 'name', 'mobile', 'email', 'source', 'medium', 'odoo', 'sync', 'status', 'row'];
app.get('/api/forms-missing.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  const s = scoped(d, req.query);
  const r = A.forms(s.all, d.sheet, s.win);
  if (!r.available) return res.status(503).json({ error: 'form submissions are not in the n8n feed yet' });
  const esc = (v) => { const x = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const csv = [FM_COLS.join(','), ...r.missing.map((x) => FM_COLS.map((c) => esc(x[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="forms-missing-in-odoo.csv"' }).send('\ufeff' + csv);
});
const AUD_COLS = ['name', 'partner', 'email', 'phone', 'age', 'quality', 'budgetTier', 'path', 'advisorPath', 'employment', 'marital', 'education', 'language', 'stage', 'status', 'lostReason', 'user', 'source', 'created', 'id'];
app.get('/api/audience.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const s = scoped(d, req.query);
  const rows = A.audience(s.leads, req.query, s.everyone).allRows.map(A.audienceRow);
  if (req.query.format === 'meta') return sendMeta(res, rows, 'audience-meta.csv');
  const csv = [AUD_COLS.join(','), ...rows.map((r) => AUD_COLS.map((c) => esc(r[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audience.csv"' }).send('\ufeff' + csv);
});
const CS_COLS = ['category', 'type', 'company', 'no', 'status', 'issued', 'signed', 'leadDate', 'leadToSent', 'sentToSigned', 'leadToSigned', 'fee', 'currency', 'agent', 'user', 'source', 'budgetTier', 'name', 'id'];
app.get('/api/contracts-sent.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const s = scoped(d, req.query);
  const r = A.contractsSent(s.all, d.sheet, s.win, s.market);
  if (!r.available) return res.status(503).json({ error: 'contracts feed not loaded' });
  const csv = [CS_COLS.join(','), ...r.rows.map((x) => CS_COLS.map((c) => esc(x[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contracts-sent.csv"' }).send('\ufeff' + csv);
});
// Meta custom-audience upload: email and phone only, one person per row (Meta's own column names).
function sendMeta(res, rows, file) {
  const seen = new Set();
  const lines = ['email,phone'];
  for (const r of rows) {
    const email = String(r.email || '').trim().toLowerCase().split(/[\s,;]+/).find((e) => e.includes('@')) || '';
    const phone = A.metaPhone(r.phone);
    const k = `${email}|${phone}`;
    if ((!email && !phone) || seen.has(k)) continue;
    seen.add(k);
    lines.push(`${email.replace(/[",]/g, '')},${phone}`);
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"` }).send(lines.join('\n'));
}
const RT_COLS = ['stepLabel', 'draftOn', 'name', 'partner', 'email', 'phone', 'service', 'serviceRaw', 'age', 'budgetTier', 'path', 'employment', 'marital', 'education', 'language', 'market', 'user', 'stage', 'status', 'lostReason', 'fee', 'currency', 'source', 'created', 'updated', 'id'];
app.get('/api/retargeting.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const s = scoped(d, req.query);
  const rows = A.retargeting(retargetPool(s), s.win, s.everyone, req.query).rows;
  if (req.query.format === 'meta') return sendMeta(res, rows, 'retargeting-meta.csv');
  const csv = [RT_COLS.join(','), ...rows.map((r) => RT_COLS.map((c) => esc(r[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="retargeting-drafts.csv"' }).send('\ufeff' + csv);
});

app.listen(PORT, () => {
  console.log(`Dashboard on http://localhost:${PORT}`);
  startLoad(); // warm the cache on boot
  // Refresh in the background too, so a visitor never waits for one; skipped while a sync is already running.
  setInterval(() => { if (state.data) startLoad(); }, CACHE_MS).unref();
});
