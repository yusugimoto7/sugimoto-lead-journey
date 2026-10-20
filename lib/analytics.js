// Pure aggregation functions over normalised leads.
const { PHASES } = require('./data');

const NONE = '(none)';
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const round = (n, d = 0) => { const k = 10 ** d; return Math.round(n * k) / k; };
const DAY = 86400000;
const ts = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : null);
const daysBetween = (a, b) => (a && b ? (b - a) / DAY : null);
const avg = (arr) => (arr.length ? round(arr.reduce((s, x) => s + x, 0) / arr.length, 1) : null);

function groupBy(leads, keyFn) {
  const m = new Map();
  for (const l of leads) {
    const k = keyFn(l) ?? NONE;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(l);
  }
  return m;
}

const counts = (ls) => {
  const converted = ls.filter((l) => l.converted).length;
  const lost = ls.filter((l) => l.lost).length;
  return { total: ls.length, converted, lost, historical: ls.filter((l) => l.historical).length, open: ls.filter((l) => l.status === 'Open').length, rate: pct(converted, ls.length) };
};

function revenue(ls) {
  const out = { CAD: { contracts: 0, total: 0 }, EUR: { contracts: 0, total: 0 } };
  for (const l of ls) if (l.revenueCounted) { out[l.currency].contracts++; out[l.currency].total += l.contractValue; }
  out.CAD.total = round(out.CAD.total, 2); out.EUR.total = round(out.EUR.total, 2);
  return out;
}

// Imported records: what we can say about them without trusting their dates or lost flag.
function historicalInfo(all) {
  const h = all.filter((l) => l.historical);
  const dates = h.map((l) => l.created).filter(Boolean).sort();
  return {
    total: h.length,
    withContractData: h.filter((l) => l.hasContractData).length,
    withContractValue: h.filter((l) => l.contractValue).length,
    atStage22: h.filter((l) => l.stageNum === 22).length,
    withLostReason: h.filter((l) => l.lostReason).length,
    importedFrom: dates[0] || null, importedTo: dates[dates.length - 1] || null,
    native: all.length - h.length,
  };
}

function summary(leads, all = leads) {
  const yr = (y) => (typeof y === 'number' ? y : 1e9);
  const byYear = [...groupBy(leads, (l) => l.year)].sort((a, b) => yr(a[0]) - yr(b[0]))
    .map(([year, ls]) => ({ year, ...counts(ls) }));
  const monthly = [...groupBy(leads.filter((l) => !l.historical), (l) => l.month)].sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .map(([month, ls]) => ({ month, ...counts(ls) }));
  const stages = [...groupBy(leads, (l) => l.stage)]
    .map(([stage, ls]) => ({ stage, num: ls[0].stageNum, count: ls.length }))
    .sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
  return { totals: counts(leads), byYear, monthly, stages, historical: historicalInfo(all) };
}

function dimension(leads, keyFn) {
  return [...groupBy(leads, keyFn)]
    .map(([name, ls]) => ({ name, ...counts(ls) }))
    .sort((a, b) => b.total - a.total);
}

function sources(leads) {
  return {
    source: dimension(leads, (l) => l.source),
    medium: dimension(leads, (l) => l.medium),
    campaign: dimension(leads, (l) => l.campaign),
    referrer: dimension(leads, (l) => l.refUser),
  };
}

function journey(leads) {
  const inFlow = leads.filter((l) => l.stageNum !== null);
  const phases = PHASES.map((p) => {
    const current = leads.filter((l) => l.stageNum >= p.min && l.stageNum <= p.max);
    // "reached" = leads whose current/last stage is at or beyond the phase start (nurture sits outside the linear flow)
    const reached = p.min === 23 ? current.length
      : inFlow.filter((l) => l.stageNum >= p.min && l.stageNum <= 22).length;
    return {
      phase: p.key, range: p.min === p.max ? `${p.min}` : `${p.min}-${p.max}`,
      current: current.length, open: current.filter((l) => l.status === 'Open').length,
      lost: current.filter((l) => l.lost).length, reached,
    };
  });
  const stages = [...groupBy(leads, (l) => l.stage)].map(([stage, ls]) => ({
    stage, num: ls[0].stageNum, phase: ls[0].phase, total: ls.length,
    open: ls.filter((l) => l.status === 'Open').length, lost: ls.filter((l) => l.lost).length,
    avgProbability: avg(ls.map((l) => l.probability).filter((p) => p !== null)),
  })).sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
  return { phases, stages };
}

function matrix(rows, rowKey, colKey, maxRows = 15, maxCols = 12) {
  const rTop = dimension(rows, rowKey).slice(0, maxRows).map((r) => r.name);
  const cTop = dimension(rows, colKey).slice(0, maxCols).map((c) => c.name);
  const cells = rTop.map((r) => cTop.map((c) =>
    rows.filter((l) => (rowKey(l) ?? NONE) === r && (colKey(l) ?? NONE) === c).length));
  return { rows: rTop, cols: cTop, cells };
}

function lost(leads) {
  const lostLeads = leads.filter((l) => l.lost);
  return {
    total: lostLeads.length,
    archivedWithoutReason: leads.filter((l) => l.status === 'Archived (no reason)').length,
    byReason: dimension(lostLeads, (l) => l.lostReason).map(({ name, total }) => ({ reason: name, count: total, share: pct(total, lostLeads.length) })),
    byStage: [...groupBy(lostLeads, (l) => l.stage)]
      .map(([stage, ls]) => ({ stage, num: ls[0].stageNum, count: ls.length, share: pct(ls.length, lostLeads.length) }))
      .sort((a, b) => (a.num ?? 999) - (b.num ?? 999)),
    sourceReason: matrix(lostLeads, (l) => l.source, (l) => l.lostReason),
  };
}

function sales(leads, det) {
  const won = leads.filter((l) => l.converted);
  const stageCount = (n) => leads.filter((l) => l.stageNum === n).length;
  const bySales = [...groupBy(leads, (l) => l.user)].map(([name, ls]) => ({
    name, ...counts(ls), revenue: revenue(ls),
  })).sort((a, b) => b.total - a.total);
  const types = [...groupBy(won, (l) => l.contractType)].map(([type, ls]) => {
    const withValue = ls.filter((l) => l.contractValue);
    return {
      type, count: ls.length, currency: ls[0].currency,
      revenue: round(ls.filter((l) => l.revenueCounted).reduce((s, l) => s + l.contractValue, 0), 2),
      avgValue: withValue.length ? round(withValue.reduce((s, l) => s + l.contractValue, 0) / withValue.length, 0) : null,
    };
  }).sort((a, b) => b.count - a.count);
  return {
    kpi: {
      signed: won.length, draftSent: stageCount(13), mainContractSent: stageCount(18),
      revenue: revenue(leads),
      signedWithoutRevenue: won.filter((l) => !l.revenueCounted).length,
    },
    contractTypes: types, bySalesperson: bySales,
    fields: { contractType: det.contractType, contractValue: det.contractValue },
  };
}

function deep(allScoped) {
  const now = Date.now();
  const leads = allScoped.filter((l) => !l.historical); // import-day dates would poison every duration
  const timeBySource = [...groupBy(leads, (l) => l.source)].map(([name, ls]) => {
    const conv = ls.filter((l) => l.converted).map((l) => daysBetween(ts(l.created), ts(l.closed || l.updated)));
    const lst = ls.filter((l) => l.lost).map((l) => daysBetween(ts(l.created), ts(l.updated)));
    const open = ls.filter((l) => l.status === 'Open').map((l) => daysBetween(ts(l.created), now));
    return {
      name, total: ls.length,
      avgDaysToConvert: avg(conv.filter((x) => x !== null)),
      avgDaysToLost: avg(lst.filter((x) => x !== null)),
      avgOpenAge: avg(open.filter((x) => x !== null)),
    };
  }).sort((a, b) => b.total - a.total).slice(0, 20);

  const campaigns = [...groupBy(leads, (l) => l.campaign)].map(([name, ls]) => ({
    name, ...counts(ls), revenue: revenue(ls),
    avgDaysToConvert: avg(ls.filter((l) => l.converted).map((l) => daysBetween(ts(l.created), ts(l.closed || l.updated))).filter((x) => x !== null)),
  })).sort((a, b) => b.total - a.total).slice(0, 40);

  return {
    timeBySource, campaigns,
    lostHeatmap: matrix(leads.filter((l) => l.lost), (l) => l.source, (l) => l.lostReason),
    salespersonSource: matrix(leads, (l) => l.user, (l) => l.source, 15, 10),
    salespersonSourceConverted: matrix(leads.filter((l) => l.converted), (l) => l.user, (l) => l.source, 15, 10),
  };
}

function segments(leads, det) {
  const out = {};
  for (const key of ['budget', 'immigration', 'destination']) {
    out[key] = det.segments[key]
      ? { field: det.segments[key].name, label: det.segments[key].string, data: dimension(leads, (l) => l.seg[key]) }
      : null;
  }
  out.country = dimension(leads, (l) => l.country);
  return out;
}

// Which contract-related fields are actually filled in? Aggregates only, no personal data.
function diagnostics(all, det) {
  const native = all.filter((l) => !l.historical);
  const scopes = {
    native, native_converted: native.filter((l) => l.converted),
    historical: all.filter((l) => l.historical),
  };
  const fields = det.contract.map((c) => {
    const out = { name: c.name, label: c.string, type: c.type, used_as: c.name === det.contractType ? 'contract type' : c.name === det.contractValue ? 'contract value' : null };
    for (const [scope, ls] of Object.entries(scopes)) {
      const vals = ls.map((l) => l.cf[c.name]).filter((v) => v !== null);
      out[scope] = { filled: vals.length, of: ls.length };
      if (['monetary', 'float', 'integer'].includes(c.type)) {
        const nz = vals.filter((v) => Number(v) > 0);
        out[scope].non_zero = nz.length;
        out[scope].sum = round(nz.reduce((s, v) => s + Number(v), 0), 2);
      } else if (['char', 'selection'].includes(c.type)) {
        const m = new Map();
        vals.forEach((v) => m.set(v, (m.get(v) || 0) + 1));
        out[scope].top_values = [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([value, count]) => ({ value, count }));
      }
    }
    return out;
  });
  return {
    leads: { native: native.length, historical: scopes.historical.length },
    native_converted: scopes.native_converted.length,
    native_converted_counted_in_revenue: scopes.native_converted.filter((l) => l.revenueCounted).length,
    historical_stage22_in_odoo: scopes.historical.filter((l) => l.stageNum === 22).length,
    historical_source: (() => {
      const h = scopes.historical;
      const m = new Map();
      h.forEach((l) => { if (l.descSource) m.set(l.descSource, (m.get(l.descSource) || 0) + 1); });
      return {
        with_description: h.filter((l) => l.notes).length,
        source_found_in_description: h.filter((l) => l.descSource).length,
        odoo_source_set: h.filter((l) => l.odooSource).length,
        top_values: [...m].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([value, count]) => ({ value, count })),
      };
    })(),
    in_use: { contractType: det.contractType, contractValue: det.contractValue },
    fields,
  };
}

// ---- lead explorer ----
const SORTS = {
  created: (a, b) => (a.created || '') < (b.created || '') ? -1 : 1,
  name: (a, b) => a.name.localeCompare(b.name),
  stage: (a, b) => (a.stageNum ?? 999) - (b.stageNum ?? 999),
  value: (a, b) => (a.contractValue || 0) - (b.contractValue || 0),
};

function filterLeads(leads, q) {
  const s = (q.q || '').trim().toLowerCase();
  let out = leads.filter((l) =>
    (!q.status || l.status === q.status) &&
    (!q.stage || l.stage === q.stage) &&
    (!q.phase || l.phase === q.phase) &&
    (!q.year || String(l.year) === q.year) &&
    (!q.source || (l.source || NONE) === q.source) &&
    (!q.medium || (l.medium || NONE) === q.medium) &&
    (!q.campaign || (l.campaign || NONE) === q.campaign) &&
    (!q.user || (l.user || NONE) === q.user) &&
    (!q.reason || (l.lostReason || NONE) === q.reason) &&
    (!s || [l.name, l.partner, l.email, l.phone, String(l.id)].some((x) => (x || '').toLowerCase().includes(s))));
  const cmp = SORTS[q.sort] || SORTS.created;
  out = [...out].sort(cmp);
  if (q.dir !== 'asc') out.reverse();
  return out;
}

function facets(leads) {
  const uniq = (fn) => [...new Set(leads.map((l) => fn(l) ?? NONE))].sort();
  return {
    status: ['Open', 'Converted', 'Lost', 'Historical', 'Archived (no reason)'],
    stage: [...groupBy(leads, (l) => l.stage)].map(([s, ls]) => [ls[0].stageNum ?? 999, s]).sort((a, b) => a[0] - b[0]).map((x) => x[1]),
    year: uniq((l) => l.year).map(String),
    source: uniq((l) => l.source), medium: uniq((l) => l.medium), campaign: uniq((l) => l.campaign),
    user: uniq((l) => l.user), reason: uniq((l) => l.lostReason),
  };
}

module.exports = { diagnostics, summary, sources, journey, lost, sales, deep, segments, filterLeads, facets, counts };
