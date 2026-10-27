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
// scope=native (default) | historical | all, and an optional window from=YYYY-MM-DD&to=YYYY-MM-DD on the lead's date
// (Created on; Created at for imported cards). Applied to every endpoint so every page agrees. With a window, each
// endpoint also answers for the window of the same length just before it (`_prev`), for growth figures.
const DAY = 86400000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
function windowOf(q) {
  const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  if (!ok(q.from) || !ok(q.to) || q.from > q.to) return null;
  const a = Date.parse(`${q.from}T00:00:00Z`), b = Date.parse(`${q.to}T00:00:00Z`);
  const span = Math.round((b - a) / DAY) + 1;
  return { from: q.from, to: q.to, span, prev: { from: isoDay(a - span * DAY), to: isoDay(a - DAY), span } };
}
const inWin = (w) => (l) => { const d = String(l.created || '').slice(0, 10); return !!d && d >= w.from && d <= w.to; };
const scoped = (d, req) => {
  const scope = ['native', 'historical', 'all'].includes(req.query.scope) ? req.query.scope : 'native';
  // Duplicate import cards (a pre-CRM client's second card) stay out of every count; the Contracts tab still lists them.
  const counted = d.leads.filter((l) => !l.duplicate);
  // market=Canada|Europe narrows every count to that market (Destination field, see marketOf in lib/data.js).
  const market = ['Canada', 'Europe'].includes(req.query.market) ? req.query.market : null;
  const inScope = (scope === 'all' ? counted : counted.filter((l) => l.historical === (scope === 'historical')))
    .filter((l) => !market || l.market === market);
  const all = market ? d.leads.filter((l) => l.market === market) : d.leads;
  const win = windowOf(req.query);
  return { ...d, leads: win ? inScope.filter(inWin(win)) : inScope, inScope, all, everyone: d.leads, scope, win, market };
};
const route = (fn, { prev = true } = {}) => (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  try {
    const s = scoped(d, req);
    const body = fn(s, req);
    if (s.win && prev && body && typeof body === 'object') {
      body._window = { from: s.win.from, to: s.win.to, span: s.win.span, prevFrom: s.win.prev.from, prevTo: s.win.prev.to };
      body._prev = fn({ ...s, leads: s.inScope.filter(inWin(s.win.prev)), win: s.win.prev }, req);
      if (body._prev) { delete body._prev.rows; delete body._prev.issues; } // growth needs the aggregates only
    }
    res.json(body);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
app.get('/api/period', route((d, req) => A.period(d.all, req.query), { prev: false }));
app.get('/api/compare', route((d, req) => A.compare(d.leads, req.query, d.win)));
app.get('/api/forms', route((d) => A.forms(d.all, d.sheet, d.win)));
const FM_COLS = ['date', 'name', 'mobile', 'email', 'source', 'medium', 'odoo', 'sync', 'status', 'row'];
app.get('/api/forms-missing.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  const s = scoped(d, req);
  const r = A.forms(s.all, d.sheet, s.win);
  if (!r.available) return res.status(503).json({ error: 'form submissions are not in the n8n feed yet' });
  const esc = (v) => { const x = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const csv = [FM_COLS.join(','), ...r.missing.map((x) => FM_COLS.map((c) => esc(x[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="forms-missing-in-odoo.csv"' }).send('\ufeff' + csv);
});
app.get('/api/summary', route((d) => A.summary(d.leads, d.all, d.win)));
app.get('/api/sources', route((d) => A.sources(d.leads)));
app.get('/api/journey', route((d) => A.journey(d.leads)));
app.get('/api/lost', route((d) => A.lost(d.leads)));
app.get('/api/sales', route((d) => A.sales(d.leads, d.det)));
app.get('/api/deep', route((d) => A.deep(d.leads)));
app.get('/api/diagnostics', route((d) => A.diagnostics(d.all, d.det), { prev: false }));
app.get('/api/contracts', route((d) => ({ ...A.contracts(d.all, d.sheet, d.win, d.market), odoo_url: baseUrl() })));
app.get('/api/revenue-check', route((d) => ({ ...A.revenueCheck(d.all, d.sheet, d.win, d.market), odoo_url: baseUrl() })));
app.get('/api/contracts-sent', route((d) => ({ ...A.contractsSent(d.all, d.sheet, d.win, d.market), odoo_url: baseUrl() })));
app.get('/api/audience', route((d, req) => { const a = A.audience(d.leads, req.query, d.everyone); delete a.allRows; return { ...a, odoo_url: baseUrl() }; }, { prev: false }));
const AUD_COLS = ['name', 'partner', 'email', 'phone', 'age', 'quality', 'budgetTier', 'path', 'advisorPath', 'stage', 'status', 'lostReason', 'user', 'source', 'created', 'id'];
app.get('/api/audience.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const s = scoped(d, req);
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
  const s = scoped(d, req);
  const r = A.contractsSent(s.all, d.sheet, s.win, s.market);
  if (!r.available) return res.status(503).json({ error: 'contracts feed not loaded' });
  const csv = [CS_COLS.join(','), ...r.rows.map((x) => CS_COLS.map((c) => esc(x[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contracts-sent.csv"' }).send('\ufeff' + csv);
});
// Rows follow the scope (native / historical / all) and market; who has signed is checked across every card.
app.get('/api/retargeting', route((d) => ({ ...A.retargeting(d.inScope, d.win, d.everyone), odoo_url: baseUrl() })));
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
const RT_COLS = ['stepLabel', 'draftOn', 'name', 'partner', 'email', 'phone', 'user', 'stage', 'status', 'lostReason', 'budgetTier', 'contractType', 'fee', 'currency', 'source', 'created', 'updated', 'id'];
app.get('/api/retargeting.csv', (req, res) => {
  const d = current();
  if (!d) return notReady(res);
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const s = scoped(d, req);
  const rows = A.retargeting(s.inScope, s.win, s.everyone).rows;
  if (req.query.format === 'meta') return sendMeta(res, rows, 'retargeting-meta.csv');
  const csv = [RT_COLS.join(','), ...rows.map((r) => RT_COLS.map((c) => esc(r[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="retargeting-drafts.csv"' }).send('\ufeff' + csv);
});
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
}, { prev: false }));

const CSV_COLS = ['id', 'name', 'partner', 'email', 'phone', 'country', 'created', 'closed', 'status', 'stage', 'phase',
  'historical', 'user', 'refUser', 'source', 'medium', 'campaign', 'lostReason', 'probability', 'contractType', 'contractValue', 'currency', 'budgetTier', 'sheetStatus', 'sheetSigned'];
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
