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

app.use(express.static(path.join(__dirname, 'public')));

// Answers from cache. With no data yet, replies 503 {syncing:true} (or 502 with the Odoo error) so the
// browser can poll instead of holding a request open past Render's proxy timeout.
const notReady = (res) => (state.promise || !state.error
  ? res.status(503).json({ syncing: true, error: 'Syncing from Odoo, first load can take a few minutes' })
  : res.status(502).json({ error: state.error }));
// scope=native (default) | historical | all. Applied to every endpoint so every page agrees.
const scoped = (d, req) => {
  const scope = ['native', 'historical', 'all'].includes(req.query.scope) ? req.query.scope : 'native';
  // Duplicate import cards (a pre-CRM client's second card) stay out of every count; the Contracts tab still lists them.
  const counted = d.leads.filter((l) => !l.duplicate);
  const leads = scope === 'all' ? counted : counted.filter((l) => l.historical === (scope === 'historical'));
  return { ...d, leads, all: d.leads, scope };
};
const route = (fn) => (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  try { res.json(fn(scoped(d, req), req)); } catch (e) { res.status(500).json({ error: e.message }); }
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
    contract_snapshot: d && d.sheet ? { built: d.sheet.generatedAt, clients: d.sheet.clients.length } : null,
    last_sync: d ? new Date(d.fetchedAt).toISOString() : null,
    cache_age_seconds: d ? Math.round((Date.now() - d.fetchedAt) / 1000) : null,
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
app.get('/api/fields', route((d) => ({ contract_related: d.det.contract, detected: { contractType: d.det.contractType, contractValue: d.det.contractValue, segments: d.det.segments } })));
app.get('/api/refresh', (_req, res) => {
  startLoad(true); // runs in the background; poll /api/status (syncing / last_sync)
  res.status(202).json({ started: true, syncing: true });
});
app.get('/api/summary', route((d) => A.summary(d.leads, d.all)));
app.get('/api/sources', route((d) => A.sources(d.leads)));
app.get('/api/journey', route((d) => A.journey(d.leads)));
app.get('/api/lost', route((d) => A.lost(d.leads)));
app.get('/api/sales', route((d) => A.sales(d.leads, d.det)));
app.get('/api/deep', route((d) => A.deep(d.leads)));
app.get('/api/diagnostics', route((d) => A.diagnostics(d.all, d.det)));
app.get('/api/contracts', route((d) => ({ ...A.contracts(d.all, d.sheet), odoo_url: baseUrl() })));
app.get('/api/segments', route((d) => A.segments(d.leads, d.det)));

// Full lead explorer: server-side filter / sort / paging
app.get('/api/leads', route((d, req) => {
  const rows = A.filterLeads(d.leads, req.query);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 50, 1), 200);
  const pages = Math.max(Math.ceil(rows.length / size), 1);
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  return {
    total: rows.length, page, pages, size, facets: A.facets(d.leads), odoo_url: baseUrl(),
    summary: A.counts(rows), rows: rows.slice((page - 1) * size, page * size),
  };
}));

const CSV_COLS = ['id', 'name', 'partner', 'email', 'phone', 'country', 'created', 'closed', 'status', 'stage', 'phase',
  'historical', 'user', 'refUser', 'source', 'medium', 'campaign', 'lostReason', 'probability', 'contractType', 'contractValue', 'currency', 'sheetStatus', 'sheetSigned'];
app.get('/api/leads.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  try {
    const rows = A.filterLeads(scoped(d, req).leads, req.query)
      .map((l) => ({ ...l, sheetStatus: l.sheet ? l.sheet.status : '', sheetSigned: l.sheet ? l.sheet.signed : '' }));
    const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => esc(r[c])).join(','))].join('\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' }).send('﻿' + csv);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Dashboard on http://localhost:${PORT}`);
  startLoad(); // warm the cache on boot
});
