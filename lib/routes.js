// Every dashboard answer as a pure function of the loaded data and the query string. The server (server.js) serves
// them over HTTP; the static build (tools/build-pack.js) runs the same functions in the browser on an anonymised copy
// of the data, so both give the same numbers.
const A = require('./analytics');

// scope=native (default) | historical | all, and an optional window from=YYYY-MM-DD&to=YYYY-MM-DD on the lead's date
// (Created on; Created at for imported cards). Applied to every answer so every page agrees. With a window, each
// answer also covers the window of the same length just before it (`_prev`), for growth figures.
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
function scoped(d, q) {
  const scope = ['native', 'historical', 'all'].includes(q.scope) ? q.scope : 'native';
  // Duplicate import cards (a pre-CRM client's second card) stay out of every count; the Contracts tab still lists them.
  const counted = d.leads.filter((l) => !l.duplicate);
  // market=Canada|Europe narrows every count to that market (Destination field, see marketOf in lib/data.js).
  const market = ['Canada', 'Europe'].includes(q.market) ? q.market : null;
  const inScope = (scope === 'all' ? counted : counted.filter((l) => l.historical === (scope === 'historical')))
    .filter((l) => !market || l.market === market);
  const all = market ? d.leads.filter((l) => l.market === market) : d.leads;
  const win = windowOf(q);
  return { ...d, leads: win ? inScope.filter(inWin(win)) : inScope, inScope, all, everyone: d.leads, scope, win, market };
}

// Owner: drafts on historical (imported, archived) cards are retargeted too, so the list ignores the native/historical
// switch and follows only the market. Who has signed is checked across every card.
const retargetPool = (s) => s.all.filter((l) => !l.duplicate);

// name -> [answer(scoped data, query), with a previous-window answer?]
const ROUTES = {
  fields: [(d) => ({ contract_related: d.det.contract, detected: { contractType: d.det.contractType, contractValue: d.det.contractValue, segments: d.det.segments } })],
  period: [(d, q) => A.period(d.all, q), false],
  compare: [(d, q) => A.compare(d.leads, q, d.win)],
  forms: [(d) => A.forms(d.all, d.sheet, d.win)],
  summary: [(d) => A.summary(d.leads, d.all, d.win)],
  sources: [(d) => A.sources(d.leads)],
  journey: [(d) => A.journey(d.leads)],
  lost: [(d) => A.lost(d.leads)],
  sales: [(d) => A.sales(d.leads, d.det, d.staff)],
  deep: [(d) => A.deep(d.leads)],
  diagnostics: [(d) => A.diagnostics(d.all, d.det), false],
  contracts: [(d) => ({ ...A.contracts(d.all, d.sheet, d.win, d.market), odoo_url: d.odooUrl })],
  'revenue-check': [(d) => ({ ...A.revenueCheck(d.all, d.sheet, d.win, d.market), odoo_url: d.odooUrl })],
  'contracts-sent': [(d) => ({ ...A.contractsSent(d.all, d.sheet, d.win, d.market), odoo_url: d.odooUrl })],
  audience: [(d, q) => { const a = A.audience(d.leads, q, d.everyone); delete a.allRows; return { ...a, odoo_url: d.odooUrl }; }, false],
  retargeting: [(d, q) => ({ ...A.retargeting(retargetPool(d), d.win, d.everyone, q), odoo_url: d.odooUrl })],
  segments: [(d) => A.segments(d.leads, d.det)],
};

function run(name, d, q) {
  const [fn, prev = true] = ROUTES[name] || [];
  if (!fn) throw new Error(`unknown answer ${name}`);
  const s = scoped(d, q);
  const body = fn(s, q);
  if (s.win && prev && body && typeof body === 'object') {
    body._window = { from: s.win.from, to: s.win.to, span: s.win.span, prevFrom: s.win.prev.from, prevTo: s.win.prev.to };
    body._prev = fn({ ...s, leads: s.inScope.filter(inWin(s.win.prev)), win: s.win.prev }, q);
    if (body._prev) { delete body._prev.rows; delete body._prev.issues; delete body._prev.facets; } // growth needs the aggregates only
  }
  return body;
}

module.exports = { ROUTES, run, scoped, retargetPool, windowOf };
