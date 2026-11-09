// Pure aggregation functions over normalised leads.
const { PHASES, BUDGET_TIERS } = require('./data');
const { serviceOf } = require('./contracts');

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
  const historical = ls.filter((l) => l.historical).length;
  // Historical leads count in the rate only where the contract sheets cover their period (outcomeKnown).
  const rateBase = ls.filter((l) => l.outcomeKnown !== false).length;
  return { total: ls.length, converted, lost, historical, rateBase, open: ls.filter((l) => l.status === 'Open').length, rate: pct(converted, rateBase) };
};

// Revenue = contract value from the sheets (owner: the sheets are the basis) on signed leads, per currency.
const feeTotal = (l) => (l.sheetFees ? (l.sheetFees.CAD || 0) + (l.sheetFees.EUR || 0) : 0);
function revenue(ls) {
  const out = { CAD: { contracts: 0, total: 0 }, EUR: { contracts: 0, total: 0 } };
  for (const l of ls) {
    if (!l.converted || !l.sheetFees) continue;
    for (const c of ['CAD', 'EUR']) if (l.sheetFees[c]) { out[c].contracts++; out[c].total += l.sheetFees[c]; }
  }
  out.CAD.total = round(out.CAD.total, 2); out.EUR.total = round(out.EUR.total, 2);
  return out;
}

// Imported records: what we can say about them without trusting their dates or lost flag.
function historicalInfo(all) {
  const h = all.filter((l) => l.historical);
  const dates = h.map((l) => l.importedAt).filter(Boolean).sort();
  const real = h.map((l) => l.created).filter(Boolean).sort();
  return {
    total: h.length,
    withContractData: h.filter((l) => l.hasContractData).length,
    withContractValue: h.filter((l) => l.contractValue).length,
    atStage22: h.filter((l) => l.stageNum === 22).length,
    withLostReason: h.filter((l) => l.lostReason).length,
    importedFrom: dates[0] || null, importedTo: dates[dates.length - 1] || null,
    withRealDate: real.length, realFrom: real[0] || null, realTo: real[real.length - 1] || null,
    native: all.length - h.length,
  };
}

// Points across a window: per day up to a month, per week up to ~6 months, else per month (or all months, no window).
function seriesOf(leads, win) {
  const day = (d) => new Date(`${d}T00:00:00Z`);
  const iso = (d) => d.toISOString().slice(0, 10);
  if (!win) {
    return { unit: 'month', points: [...groupBy(leads.filter((l) => l.month), (l) => l.month)].sort((a, b) => (a[0] > b[0] ? 1 : -1))
      .map(([key, ls]) => ({ key, ...counts(ls) })) };
  }
  const unit = win.span <= 31 ? 'day' : win.span <= 186 ? 'week' : 'month';
  const keyOf = (d) => {
    if (unit === 'day') return d;
    if (unit === 'month') return d.slice(0, 7);
    const x = day(d); return iso(new Date(x - ((x.getUTCDay() + 6) % 7) * DAY));
  };
  const keys = [];
  for (let t = day(win.from); t <= day(win.to); t = new Date(t.getTime() + DAY)) { const k = keyOf(iso(t)); if (!keys.includes(k)) keys.push(k); }
  const by = groupBy(leads.filter((l) => l.created), (l) => keyOf(String(l.created).slice(0, 10)));
  return { unit, points: keys.map((key) => ({ key, ...counts(by.get(key) || []) })) };
}

function summary(leads, all = leads, win = null) {
  const yr = (y) => (typeof y === 'number' ? y : 1e9);
  const byYear = [...groupBy(leads, (l) => l.year)].sort((a, b) => yr(a[0]) - yr(b[0]))
    .map(([year, ls]) => ({ year, ...counts(ls) }));
  const monthly = [...groupBy(leads.filter((l) => l.month), (l) => l.month)].sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .map(([month, ls]) => ({ month, ...counts(ls) }));
  const stages = [...groupBy(leads, (l) => l.stage)]
    .map(([stage, ls]) => ({ stage, num: ls[0].stageNum, count: ls.length }))
    .sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
  return { totals: counts(leads), byYear, monthly, series: seriesOf(leads, win), stages, historical: historicalInfo(all) };
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

// Funnel over the owner's stage groups. A lead's phase is its current/last stage's group (signed leads: Signed);
// "reached" = leads whose phase is this one or a later one, so lost and archived leads count up to where they stalled.
function journey(leads) {
  const idx = new Map(PHASES.map((p, i) => [p.key, i]));
  const phaseOfLead = (l) => (l.converted ? 'Signed' : l.phase);
  const inFlow = leads.filter((l) => idx.has(phaseOfLead(l)));
  const phases = PHASES.map((p, i) => {
    const current = leads.filter((l) => phaseOfLead(l) === p.key);
    return {
      phase: p.key, range: p.label,
      current: current.length, open: current.filter((l) => l.status === 'Open').length,
      lost: current.filter((l) => l.lost).length, archived: current.filter((l) => !l.active && !l.lost && !l.converted).length,
      reached: inFlow.filter((l) => idx.get(phaseOfLead(l)) >= i).length,
    };
  });
  const outside = leads.length - inFlow.length;
  const stages = [...groupBy(leads, (l) => l.stage)].map(([stage, ls]) => ({
    stage, num: ls[0].stageNum, phase: ls[0].converted ? 'Signed' : ls[0].phase, total: ls.length,
    open: ls.filter((l) => l.status === 'Open').length, lost: ls.filter((l) => l.lost).length,
    archived: ls.filter((l) => !l.active && !l.lost && !l.converted).length,
    canada: ls.filter((l) => l.market === 'Canada').length, europe: ls.filter((l) => l.market === 'Europe').length,
    avgProbability: avg(ls.map((l) => l.probability).filter((p) => p !== null)),
  })).sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
  // Step conversion: share of the previous group's "reached" that got to this group.
  phases.forEach((p, i) => { p.fromPrevious = i ? pct(p.reached, phases[i - 1].reached) : 100; p.fromStart = pct(p.reached, phases[0].reached); });
  return { phases, stages, outside };
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
  const types = [...groupBy(won, (l) => (l.sheet && l.sheet.type) || l.contractType)].map(([type, ls]) => {
    const withValue = ls.filter((l) => feeTotal(l));
    const cur = ls.find((l) => l.sheetFees && l.sheetFees.EUR) ? 'EUR' : 'CAD';
    return {
      type, count: ls.length, currency: cur,
      revenue: round(ls.reduce((s, l) => s + feeTotal(l), 0), 2),
      avgValue: withValue.length ? round(withValue.reduce((s, l) => s + feeTotal(l), 0) / withValue.length, 0) : null,
    };
  }).sort((a, b) => b.count - a.count);
  return {
    kpi: {
      signed: won.length, draftSent: stageCount(13), mainContractSent: stageCount(18),
      revenue: revenue(leads),
      signedWithoutRevenue: won.filter((l) => !feeTotal(l)).length,
    },
    contractTypes: types, bySalesperson: bySales,
    fields: { contractType: 'contract sheets', contractValue: 'contract sheets (Finance: Sugimoto professional Fee, else Professional Fees; SparkBridge: Spark fee)' },
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
  out.market = dimension(leads, (l) => l.market || 'Unknown');
  // Budget mix: every tier in order (also when empty), with its share of the period's leads and its signings.
  const tiers = [...BUDGET_TIERS.map((b) => [b.tier, b.desc]), ['Unscored', 'budget given but no tier assigned'], ['No budget', 'no budget answer']];
  const by = groupBy(leads, (l) => l.budgetTier || 'No budget');
  out.budgetTiers = tiers.map(([name, desc]) => {
    const ls = by.get(name) || [];
    return { name, desc, ...counts(ls), share: pct(ls.length, leads.length) };
  });
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
      const vals = ls.map((l) => l.cf[c.name]).filter((v) => v !== null && v !== undefined);
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
    (!q.referrer || (l.refUser || NONE) === q.referrer) &&
    (!q.sheet || (l.sheet ? l.sheet.outcome : 'not in sheets') === q.sheet) &&
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
    referrer: uniq((l) => l.refUser), sheet: ['converted', 'not_converted', 'terminated', 'not in sheets'], user: uniq((l) => l.user), reason: uniq((l) => l.lostReason),
  };
}

// Sheet contracts vs Odoo: which signed clients are (not) Stage 22 / Won, and which signed cards the sheets confirm.
const isSignedCard = (l) => [20, 21, 22, 25].includes(l.stageNum) || /^won$/i.test(l.stage || '');
function contracts(all, sheet, win = null, market = null) {
  if (!sheet) return { available: false };
  const inW = (d) => !win || (!!d && String(d).slice(0, 10) >= win.from && String(d).slice(0, 10) <= win.to);
  const cardOf = (c) => c.leads.find((l) => !l.sheetOnly) || null;
  const row = (l, c) => ({
    id: l ? l.id : null, name: l ? l.name : null, stage: l ? l.stage : null, status: l ? l.status : null, user: l ? l.user : null,
    historical: l ? !!l.historical && !l.preCrmClient : null, importedCard: l ? !!l.preCrmClient : null, created: l ? l.created : null,
    sheetStatus: c.status, type: c.type, signed: c.signed, period: c.period, sheets: c.sheets.join(' + '),
    rows: c.rows.map((r) => `${r.company === 'SG' ? 'Finance' : 'SparkBridge'} ${r.no || ''} (row ${r.row})`).join(', '),
    dateFlags: c.dateFlags.join('; '),
  });
  // With a window: contracts signed in it, and signed Odoo cards created in it.
  const cMarket = (c) => (c.currency === 'EUR' ? 'Europe' : c.currency === 'CAD' ? 'Canada' : null);
  const signed = sheet.clients.filter((c) => c.outcome === 'converted' && inW(c.signed) && (!market || cMarket(c) === market));
  const buckets = { confirmed: [], notSigned: [], noCard: [], preNative: [] };
  for (const c of signed) {
    const card = cardOf(c);
    if (c.period === 'pre-native') buckets.preNative.push(row(card, c));
    else if (!card) buckets.noCard.push(row(null, c));
    else if (isSignedCard(card)) buckets.confirmed.push(row(card, c));
    else buckets.notSigned.push(row(card, c));
  }
  const cards = all.filter((l) => !l.sheetOnly && !l.duplicate && isSignedCard(l) && inW(l.created));
  const lead = (l) => ({ id: l.id, name: l.name, stage: l.stage, user: l.user, created: l.created,
    sheetStatus: l.sheet ? l.sheet.status : null, signed: l.sheet ? l.sheet.signed : null });
  const byYear = {};
  for (const c of signed) { const y = c.signed ? c.signed.slice(0, 4) : 'no date'; byYear[y] = (byYear[y] || 0) + 1; }
  const pre = buckets.preNative;
  return {
    available: true, generatedAt: sheet.generatedAt, live: sheet.live, error: sheet.error, sources: sheet.sources,
    clients: { total: sheet.clients.length, signed: signed.length, terminated: sheet.clients.filter((c) => c.outcome === 'terminated' && inW(c.rows.map((r) => r.signed || r.issued).filter(Boolean)[0])).length,
      flaggedDates: sheet.rows.filter((r) => r.dateFlags.length).length, rows: sheet.rows.length },
    signedByYear: Object.entries(byYear).sort().map(([year, n]) => ({ year, n })),
    native: { signed: signed.length - pre.length, confirmedStage22: buckets.confirmed.length, signedNotStage22: buckets.notSigned, signedNoCard: buckets.noCard },
    preNative: { signed: pre.length, nativeCard: pre.filter((r) => r.id && !r.historical && !r.importedCard).length, importedCard: pre.filter((r) => r.importedCard).length,
      historicalCardOnly: pre.filter((r) => r.id && r.historical).length, noCard: pre.filter((r) => !r.id).length, rows: pre },
    stage22: {
      total: cards.length,
      confirmed: cards.filter((l) => l.sheet && l.sheet.outcome === 'converted').length,
      sheetSaysNot: cards.filter((l) => l.sheet && l.sheet.outcome !== 'converted').map(lead),
      notInSheets: cards.filter((l) => !l.sheet).map(lead),
    },
  };
}

// Are the amounts in Odoo the amounts in the sheets? Contract by contract, signed contracts only.
// SG fee in Odoo should equal one of the Finance sheet's two fee columns; SB fee should equal the SparkBridge fee.
function revenueCheck(all, sheet, win = null, market = null) {
  if (!sheet) return { available: false };
  const inW = (d) => !win || (!!d && String(d).slice(0, 10) >= win.from && String(d).slice(0, 10) <= win.to);
  const byId = new Map(all.map((l) => [l.id, l]));
  const eq = (a, b) => a !== null && b !== null && Math.abs(Number(a) - Number(b)) < 0.5;
  const nz = (v) => (v === null || v === undefined ? 0 : Number(v));
  const issues = [];
  const tally = { checked: 0, match: 0, mismatch: 0, missingInOdoo: 0, zeroEverywhere: 0, noCard: 0, currencyConflict: 0, unreadableFee: 0 };
  // year -> "company|currency" -> sums. SG = Sugimoto Visa (Finance sheet), SB = SparkBridge (its own sheet).
  const totals = {};
  const add = (y, co, cur, k, v) => {
    if (!cur) return;
    const key = `${co}|${cur}`;
    totals[y] = totals[y] || {}; totals[y][key] = totals[y][key] || { sheet: 0, odoo: 0, dashboard: 0, contracts: 0 };
    totals[y][key][k] += v || 0;
  };
  const dateOfRow = (r) => { const l = r.card ? byId.get(r.card) : null; return (l && (l.cf.x_contract_signed_on || l.cf.x_contract_paid_on)) || r.signed || r.paid || r.issued || null; };
  const signedRows = sheet.rows.filter((r) => r.step === 'signed' && inW(dateOfRow(r)) && (!market || rowMarket(r) === market));
  for (const r of signedRows) {
    const l = r.card ? byId.get(r.card) : null;
    const date = dateOfRow(r);
    const y = date ? String(date).slice(0, 4) : 'no date';
    // The Finance sheet has two fee columns; Odoo's backfill took "Sugimoto professional Fee" when set, else "Professional Fees".
    const sheetFee = r.company === 'SG' ? (nz(r.fees.sheetSG) || nz(r.fees.sheetProfessional)) : nz(r.fees.sheetSB);
    const odooFee = l ? nz(r.company === 'SG' ? l.cf.x_fee_sg : l.cf.x_fee_sb) : null;
    tally.checked++;
    const base = { company: r.company, no: r.no, row: r.row, type: r.type, signed: date ? String(date).slice(0, 10) : null, currency: r.currency,
      id: l ? l.id : null, name: l ? l.name : null, sheetFee, odooFee,
      sheetColumns: r.company === 'SG' ? `Sugimoto fee ${r.rawFees.sheetSG ?? '–'} · Professional fees ${r.rawFees.sheetProfessional ?? '–'}` : `SparkBridge fee ${r.rawFees.sheetSB ?? '–'}` };
    // Only an error in the column the fee is actually taken from matters.
    const used = r.company === 'SG' ? (nz(r.fees.sheetSG) ? r.rawFees.sheetSG : r.rawFees.sheetProfessional) : r.rawFees.sheetSB;
    if (/#n\/a|#ref|#value|error/i.test(String(used || ''))) { tally.unreadableFee++; issues.push({ ...base, problem: 'Fee cell is an error (#N/A)' }); }
    if (!l) { tally.noCard++; issues.push({ ...base, problem: 'Signed contract has no Odoo card' }); }
    else if (!sheetFee && !odooFee) { tally.zeroEverywhere++; issues.push({ ...base, problem: 'No fee anywhere' }); }
    else if (!odooFee) { tally.missingInOdoo++; issues.push({ ...base, problem: 'Fee missing in Odoo' }); }
    else if (r.company === 'SG' ? (eq(odooFee, r.fees.sheetSG) || eq(odooFee, r.fees.sheetProfessional)) : eq(odooFee, sheetFee)) tally.match++;
    else { tally.mismatch++; issues.push({ ...base, problem: 'Odoo fee differs from the sheet' }); }
    if (l && l.cf.x_fee_currency && r.currency && l.cf.x_fee_currency !== r.currency) {
      tally.currencyConflict++; issues.push({ ...base, problem: `Currency: sheet ${r.currency}, Odoo ${l.cf.x_fee_currency}` });
    }
    add(y, r.company, r.currency, 'sheet', sheetFee);
    add(y, r.company, r.currency, 'odoo', odooFee || 0);
    add(y, r.company, r.currency, 'contracts', 1);
  }
  // What the Sales tab shows today: x_studio_contract_value on Stage 22 / Won cards.
  for (const l of all) if (l.revenueCounted && !l.duplicate && inW(l.created)) add(String(l.created || '').slice(0, 4) || 'no date', 'Sales tab', l.currency, 'dashboard', l.contractValue);
  // Unusually large fees for their contract type (more than 3x the type's median).
  const byType = new Map();
  for (const r of signedRows) {
    const f = r.company === 'SG' ? (nz(r.fees.sheetSG) || nz(r.fees.sheetProfessional)) : nz(r.fees.sheetSB);
    if (!f) continue;
    const k = `${r.company}|${r.type}|${r.currency}`;
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push({ r, f });
  }
  const outliers = [];
  for (const [k, xs] of byType) {
    if (xs.length < 5) continue;
    const sorted = xs.map((x) => x.f).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (const { r, f } of xs) if (f > 3 * med || f < med / 5) outliers.push({ company: r.company, no: r.no, row: r.row, type: r.type, currency: r.currency, fee: f, typeMedian: med, id: r.card });
  }
  const r2 = (n) => Math.round(n);
  return {
    available: true, generatedAt: sheet.generatedAt, tally,
    totals: Object.entries(totals).sort().flatMap(([year, cs]) => Object.entries(cs).sort().map(([k, t]) => {
      const [company, currency] = k.split('|');
      return { year, company, currency, contracts: t.contracts, sheet: r2(t.sheet), odoo: r2(t.odoo), dashboard: r2(t.dashboard) };
    })),
    issues, outliers,
    note: 'Fees are professional fees from the contract sheets (Finance: Sugimoto professional Fee, else Professional Fees; SparkBridge: Spark professional Fee). They are contract values, not money received: payments are not in the n8n feed.',
  };
}

// One person can have several cards (a new form months later, a re-import): cards sharing an email or a phone number
// (last 10 digits; phone and mobile) are the same person, transitively.
const emailKey = (v) => { const e = String(v || '').trim().toLowerCase(); return e.includes('@') ? `e:${e}` : null; };
const phoneKey = (v) => { const d = latinDigits(v).replace(/\D/g, ''); return d.length >= 9 ? `p:${d.slice(-10)}` : null; };
const contactKeys = (l) => [emailKey(l.email), phoneKey(l.phone), phoneKey(l.mobile)].filter(Boolean);
function personIndex(leads) {
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  for (const l of leads) {
    const ks = contactKeys(l);
    ks.forEach((k) => { if (!parent.has(k)) parent.set(k, k); });
    for (let i = 1; i < ks.length; i++) { const x = find(ks[0]), y = find(ks[i]); if (x !== y) parent.set(y, x); }
  }
  return (l) => { const ks = contactKeys(l); return ks.length ? find(ks[0]) : `id:${l.id}`; };
}
const signedPeople = (everyone, personOf) => new Set(everyone
  .filter((l) => l.converted || (l.sheet && ['signed', 'terminated'].includes(l.sheet.step))).map(personOf));

// Meta custom audiences match on email and phone in international form. The phone fields hold free text: Persian
// digits, two numbers in one field, notes. The first number is used. Iranian mobiles appear as 09xx…, 9xx…, 989xx… and,
// in about half of the form cards, as 90 + 9xx… (Turkey's code in front of an Iranian 9xx mobile; Turkish mobiles
// start with 5). A bare 10-digit number not starting with 9 is North American. Meta hashes the file itself on upload.
const latinDigits = (v) => String(v || '').replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c));
function metaPhone(v) {
  const m = /\+?\d[\d\s\-().]{6,}\d/.exec(latinDigits(v));
  if (!m) return '';
  let d = m[0].replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^09\d{9}$/.test(d)) d = `98${d.slice(1)}`;
  else if (/^9\d{9}$/.test(d)) d = `98${d}`;
  else if (/^909\d{9}$/.test(d)) d = `98${d.slice(2)}`;
  else if (/^9809\d{9}$/.test(d)) d = `98${d.slice(3)}`;
  else if (/^[2-8]\d{9}$/.test(d)) d = `1${d}`;
  return d.length >= 11 && d.length <= 15 ? `+${d}` : '';
}

const rtOrder = (k) => ({ age: [...AGE_BANDS.map((b) => b[2]), 'unknown'], budget: ['Tier 5', 'Tier 4', 'Tier 3', 'Tier 2', 'Tier 1', 'Unscored', 'No budget'] })[k];
const RT_DIMS = {
  service: (r) => r.service, age: (r) => r.ageBand, budget: (r) => r.budgetTier || 'No budget', path: (r) => r.path || '(none)',
  employment: (r) => r.employment || 'not set', marital: (r) => r.marital || 'not set', education: (r) => r.education || 'not set',
  language: (r) => r.language || 'not set', market: (r) => r.market || 'Unknown', step: (r) => r.stepLabel, user: (r) => r.user || '(none)',
  status: (r) => r.status, lost: (r) => r.lostReason || '(none)', kind: (r) => (r.historical ? 'Historical card' : 'Native card'),
};
// Retargeting: people who received a draft (or the main contract) and never signed on any card. One row per person.
function retargeting(leads, win = null, everyone = leads, q = {}) {
  const STEP_LABEL = { contract_sent: 'Main contract sent', draft_sent: 'Draft sent' };
  const ODOO_STEP = { 'Draft sent': 'draft_sent', 'Contract sent': 'contract_sent' };
  const personOf = personIndex(everyone);
  const signed = signedPeople(everyone, personOf);
  const best = new Map();
  for (const l of leads) {
    if (l.sheetOnly || l.duplicate || l.converted) continue;
    const step = (l.sheet && STEP_LABEL[l.sheet.step] && l.sheet.step) || ODOO_STEP[l.cf.x_contract_status]
      || (l.stageNum === 18 ? 'contract_sent' : l.stageNum === 13 ? 'draft_sent' : null);
    if (!step) continue;
    const k = personOf(l);
    if (signed.has(k)) continue;
    // Contract issue date in the sheets, else Odoo "Contract sent on", else (native cards only: an imported card's stage
    // date is its import day) the day the card entered the contract stage.
    const draftOn = (l.sheet && l.sheet.draftOn) || (l.cf.x_contract_sent_on ? String(l.cf.x_contract_sent_on).slice(0, 10) : null)
      || (!l.historical && [13, 18].includes(l.stageNum) && l.stageChanged ? String(l.stageChanged).slice(0, 10) : null);
    const fee = (l.sheet && l.sheet.fee) || Number(l.cf.x_fee_total) || Number(l.contractValue) || null;
    const r = {
      id: l.id, name: l.name, partner: l.partner, email: l.email, phone: l.phone || l.mobile, user: l.user, stage: l.stage, status: l.status,
      lostReason: l.lostReason, step, stepLabel: STEP_LABEL[step], draftOn, updated: l.updated ? String(l.updated).slice(0, 10) : null,
      contractType: (l.sheet && l.sheet.type) || l.contractType || null, fee,
      currency: (l.sheet && l.sheet.fee && l.sheet.currency) || l.cf.x_fee_currency || l.currency || null,
      source: l.source, created: l.created ? String(l.created).slice(0, 10) : null, historical: !!l.historical, budgetTier: l.budgetTier,
      market: l.market, reachable: !!(emailKey(l.email) || metaPhone(l.phone || l.mobile)),
      // The contract the person actually received (sheets) names the service; else what Odoo has on the card.
      serviceRaw: (l.sheet && l.sheet.type) || l.odooService || null, service: serviceOf((l.sheet && l.sheet.type) || l.odooService) || 'Not set',
      age: l.age, ageBand: ageBand(l.age), path: cleanPath(l.seg.immigration), ...l.persona,
    };
    const prev = best.get(k);
    if (!prev || (step === 'contract_sent' && prev.step !== 'contract_sent') || (prev.step === step && String(r.draftOn) > String(prev.draftOn))) best.set(k, r);
  }
  const inWindow = [...best.values()].filter((r) => !win || (!!r.draftOn && r.draftOn >= win.from && r.draftOn <= win.to)).sort((a, b) => (a.step === b.step ? String(b.draftOn || b.updated).localeCompare(String(a.draftOn || a.updated)) : a.step === 'draft_sent' ? -1 : 1));
  // Multi-select filters (values joined with |). Each dimension's counts are taken within the other filters, so a
  // count always says how many people that choice would leave.
  const want = Object.fromEntries(Object.keys(RT_DIMS).map((k) => [k, q[k] ? String(q[k]).split('|') : null]));
  const pass = (r, skip) => Object.entries(want).every(([k, v]) => k === skip || !v || v.includes(RT_DIMS[k](r)));
  const rows = inWindow.filter((r) => pass(r, null));
  const facets = {};
  for (const k of Object.keys(RT_DIMS)) {
    const m = new Map();
    inWindow.filter((r) => pass(r, k)).forEach((r) => { const v = RT_DIMS[k](r); m.set(v, (m.get(v) || 0) + 1); });
    const order = rtOrder(k);
    facets[k] = [...m].map(([name, n]) => ({ name, n })).sort(order ? (a, b) => order.indexOf(a.name) - order.indexOf(b.name) : (a, b) => b.n - a.n);
  }
  const count = (f) => rows.reduce((m, r) => { const v = f(r) || '(none)'; m[v] = (m[v] || 0) + 1; return m; }, {});
  return { all: inWindow.length, facets, selected: want, total: rows.length, unreachable: rows.filter((r) => !r.reachable).length, noDate: win ? 0 : rows.filter((r) => !r.draftOn).length,
    byStep: count((r) => r.stepLabel), byKind: count((r) => (r.historical ? 'Historical card' : 'Native card')), byStatus: count((r) => r.status), bySalesperson: count((r) => r.user), byBudget: count((r) => r.budgetTier), byLost: count((r) => r.lostReason), rows };
}

// Stage groups (owner, 2026-10-26, second version): Pre meeting 0, 00, 1, 2, 4 (No Show); Meeting set and done 3, 5-10
// and 23 (Long-term follow-up); Documents received 11; Contract sent 12-19; Signed = converted (20, 21, 22, 25, Won).
// Signed wins over archived (Won cards are archived); any other archived card is Archive, as is 24 Canceled Contracts.
const BUCKETS = ['Pre meeting', 'Meeting set and done', 'Documents received', 'Contract sent', 'Signed', 'Archive', 'Other'];
function bucketOf(l) {
  if (l.converted) return 'Signed';
  if (!l.active) return 'Archive';
  const n = l.stageNum;
  if (n === null) return /contract signing/i.test(l.stage || '') ? 'Contract sent' : 'Other';
  if (n <= 2 || n === 4) return 'Pre meeting';
  if (n <= 10 || n === 23) return 'Meeting set and done';
  if (n === 11) return 'Documents received';
  if (n <= 19) return 'Contract sent';
  if (n === 24) return 'Archive'; // cancelled contracts
  return 'Other';
}
const DIMS = { budgetTier: (l) => l.budgetTier, source: (l) => l.source, medium: (l) => l.medium, campaign: (l) => l.campaign, user: (l) => l.user, referrer: (l) => l.refUser, bucket: bucketOf };

// Odoo cards in a date window: "created" = new leads in the window; "stage" = cards that moved into their current
// stage in the window (Odoo date_last_stage_update). Compared with the window of the same length just before.
function period(all, q) {
  const day = (d) => new Date(`${d}T00:00:00Z`);
  const iso = (d) => d.toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : iso(new Date());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : iso(new Date(day(to) - 29 * DAY));
  const span = Math.round((day(to) - day(from)) / DAY) + 1;
  const prevTo = iso(new Date(day(from) - DAY)), prevFrom = iso(new Date(day(from) - span * DAY));
  const basis = q.basis === 'stage' ? 'stage' : 'created';
  const dateOf = (l) => String((basis === 'stage' ? l.stageChanged || l.created : l.created) || '').slice(0, 10);
  const dim = DIMS[q.dim] ? q.dim : 'source';
  const base = all.filter((l) => !l.historical && !l.sheetOnly && !l.duplicate && (!q.market || !['Canada', 'Europe'].includes(q.market) || l.market === q.market)
    && (!q.source || (l.source || NONE) === q.source) && (!q.medium || (l.medium || NONE) === q.medium));
  const inWin = (a, b) => base.filter((l) => { const d = dateOf(l); return d && d >= a && d <= b; });
  const cur = inWin(from, to), prev = inWin(prevFrom, prevTo);
  const byBucket = (ls) => Object.fromEntries(BUCKETS.map((b) => [b, ls.filter((l) => bucketOf(l) === b).length]));
  const unit = span <= 31 ? 'day' : span <= 186 ? 'week' : 'month';
  const keyOf = (d) => {
    if (unit === 'day') return d;
    if (unit === 'month') return d.slice(0, 7);
    const x = day(d); const wd = (x.getUTCDay() + 6) % 7; return iso(new Date(x - wd * DAY)); // Monday of the week
  };
  const keys = [];
  for (let t = day(from); t <= day(to); t = new Date(t.getTime() + DAY)) { const k = keyOf(iso(t)); if (!keys.includes(k)) keys.push(k); }
  const timeline = keys.map((k) => ({ key: k, ...byBucket(cur.filter((l) => keyOf(dateOf(l)) === k)) }));
  const rows = [...groupBy(cur, DIMS[dim])].map(([name, ls]) => ({ name, total: ls.length, ...byBucket(ls) })).sort((a, b) => b.total - a.total);
  const facet = (f) => [...new Set(base.filter((l) => { const d = dateOf(l); return d && d >= prevFrom && d <= to; }).map((l) => f(l) ?? NONE))].sort();
  return {
    from, to, span, prevFrom, prevTo, basis, dim, unit, buckets: BUCKETS,
    total: cur.length, prevTotal: prev.length, current: byBucket(cur), previous: byBucket(prev),
    timeline, rows: rows.slice(0, 40), otherRows: Math.max(0, rows.length - 40),
    facets: { source: facet((l) => l.source), medium: facet((l) => l.medium) },
  };
}

// Contracts sent (from the sheets): what was sent, how many, how many signed, how long from the lead to the contract
// and to the signature. Window = contract issue date. Lead date = Created on (Created at for imported cards); imported
// cards created after their contract are left out of the timings.
const rowMarket = (r) => (r.currency === 'EUR' ? 'Europe' : r.currency === 'CAD' ? 'Canada' : null);
function contractsSent(all, sheet, win = null, market = null) {
  if (!sheet) return { available: false };
  const byId = new Map(all.map((l) => [l.id, l]));
  const inW = (d) => !win || (!!d && d >= win.from && d <= win.to);
  const days = (a, b) => (a && b ? Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY) : null);
  const med = (xs) => { const v = xs.filter((x) => x !== null && x >= 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const SENT = ['draft_sent', 'contract_sent', 'signed', 'terminated', 'invoice_sent'];
  const rows = sheet.rows.filter((r) => SENT.includes(r.step) && inW(r.issued) && (!market || rowMarket(r) === market)).map((r) => {
    const l = r.card ? byId.get(r.card) : null;
    const lead = l && !l.sheetOnly ? (l.historical ? l.createdAt || l.created : l.importedAt ? null : l.created) : null;
    const signedOn = r.step === 'signed' ? String((l && l.sheet && l.sheet.outcome === 'converted' && (l.cf.x_contract_signed_on || l.cf.x_contract_paid_on)) || r.signed || r.paid || '').slice(0, 10) || null : null;
    const fee = r.company === 'SG' ? (r.fees.sheetSG || r.fees.sheetProfessional || 0) : (r.fees.sheetSB || 0);
    const leadToSent = days(lead, r.issued), leadToSigned = days(lead, signedOn), sentToSigned = days(r.issued, signedOn);
    return {
      company: r.company, no: r.no, row: r.row, category: r.category, type: (r.type || '').trim() || '(not set)', step: r.step, status: r.status,
      issued: r.issued, signed: signedOn, fee, currency: r.currency, agent: r.agent, id: l ? l.id : null, name: l ? l.name : null,
      user: l ? l.user : null, source: l ? l.source : r.source, budgetTier: l ? l.budgetTier : null, leadDate: lead ? String(lead).slice(0, 10) : null,
      leadToSent: leadToSent !== null && leadToSent >= 0 ? leadToSent : null,
      leadToSigned: leadToSigned !== null && leadToSigned >= 0 ? leadToSigned : null,
      sentToSigned: sentToSigned !== null && sentToSigned >= 0 ? sentToSigned : null,
    };
  });
  const agg = (rs) => {
    const sg = rs.filter((r) => r.step === 'signed');
    const val = { CAD: 0, EUR: 0 };
    sg.forEach((r) => { if (r.currency) val[r.currency] += r.fee; });
    return {
      sent: rs.length, drafts: rs.filter((r) => r.step === 'draft_sent').length, mainSent: rs.filter((r) => r.step === 'contract_sent').length,
      signed: sg.length, terminated: rs.filter((r) => r.step === 'terminated').length, rate: pct(sg.length, rs.length),
      medLeadToSent: med(rs.map((r) => r.leadToSent)), medSentToSigned: med(sg.map((r) => r.sentToSigned)), medLeadToSigned: med(sg.map((r) => r.leadToSigned)),
      valueCAD: round(val.CAD), valueEUR: round(val.EUR), avgFee: sg.length ? round(sg.reduce((a, r) => a + r.fee, 0) / sg.length) : null,
    };
  };
  const cut = (f) => [...groupBy(rows, f)].map(([name, rs]) => ({ name, ...agg(rs) })).sort((a, b) => b.sent - a.sent);
  const categories = [...groupBy(rows, (r) => r.category)].map(([name, rs]) => ({
    name, ...agg(rs), types: [...groupBy(rs, (r) => r.type)].map(([t, x]) => ({ name: t, ...agg(x) })).sort((a, b) => b.sent - a.sent),
  })).sort((a, b) => b.sent - a.sent);
  const BUCKETS_D = [[0, 7, '0–7 days'], [8, 30, '8–30 days'], [31, 60, '1–2 months'], [61, 90, '2–3 months'], [91, 180, '3–6 months'], [181, 365, '6–12 months'], [366, 1e9, 'over a year']];
  const spread = (key, rs) => BUCKETS_D.map(([a, b, name]) => ({ name, n: rs.filter((r) => r[key] !== null && r[key] >= a && r[key] <= b).length }));
  const signedRows = rows.filter((r) => r.step === 'signed');
  return {
    available: true, generatedAt: sheet.generatedAt, live: sheet.live, error: sheet.error,
    totals: agg(rows), categories, byCompany: cut((r) => (r.company === 'SG' ? 'Sugimoto (Finance sheet)' : 'SparkBridge')),
    byAgent: cut((r) => r.agent), bySalesperson: cut((r) => r.user), bySource: cut((r) => r.source), byBudget: cut((r) => r.budgetTier),
    leadToSigned: spread('leadToSigned', signedRows), sentToSigned: spread('sentToSigned', signedRows), leadToSent: spread('leadToSent', rows),
    timedLeadToSigned: signedRows.filter((r) => r.leadToSigned !== null).length, signedCount: signedRows.length,
    rows: rows.sort((a, b) => String(b.issued).localeCompare(String(a.issued))),
  };
}

// Audience for retargeting beyond drafts: unsigned leads cut by age, card quality, budget tier, the lead's own path
// and the consultant's path (staff selection on the card). Filters cross-apply; each cut counts within the others.
const AGE_BANDS = [[0, 24, 'under 25'], [25, 29, '25–29'], [30, 34, '30–34'], [35, 39, '35–39'], [40, 44, '40–44'], [45, 49, '45–49'], [50, 200, '50+']];
const ageBand = (a) => (a ? (AGE_BANDS.find(([x, y]) => a >= x && a <= y) || [, , 'unknown'])[2] : 'unknown');
const cleanPath = (v) => (v ? String(v).replace(/\s+/g, ' ').trim() : null);
const AUD = {
  age: (l) => ageBand(l.age), quality: (l) => l.quality || 'not rated', budget: (l) => l.budgetTier || 'No budget',
  path: (l) => cleanPath(l.seg.immigration) || '(none)', advisor: (l) => cleanPath(l.advisorPath) || '(not set)',
  employment: (l) => (l.persona && l.persona.employment) || 'not set', marital: (l) => (l.persona && l.persona.marital) || 'not set',
  education: (l) => (l.persona && l.persona.education) || 'not set', language: (l) => (l.persona && l.persona.language) || 'not set',
  status: (l) => l.status,
};
function audience(leads, q, everyone = leads) {
  // One row per person: their newest unsigned card in the period. People who signed on any card, and cards with no
  // email or phone (nothing to match an ad audience on), are left out.
  const personOf = personIndex(everyone);
  const signed = signedPeople(everyone, personOf);
  const newest = new Map();
  let cards = 0;
  for (const l of leads) {
    if (l.converted || l.sheetOnly || l.duplicate || !contactKeys(l).length) continue;
    const k = personOf(l);
    if (signed.has(k)) continue;
    cards++;
    const prev = newest.get(k);
    if (!prev || String(l.created || '') > String(prev.created || '')) newest.set(k, l);
  }
  const pool = [...newest.values()];
  const want = Object.fromEntries(Object.keys(AUD).map((k) => [k, q[k] ? String(q[k]).split('|') : null]));
  const pass = (l, skip) => Object.entries(want).every(([k, v]) => k === skip || !v || v.includes(AUD[k](l)));
  const rows = pool.filter((l) => pass(l, null));
  const order = { age: [...AGE_BANDS.map((b) => b[2]), 'unknown'], quality: ['Very High', 'High', 'Normal', 'Low', 'Very Low', 'not rated'],
    budget: ['Tier 5', 'Tier 4', 'Tier 3', 'Tier 2', 'Tier 1', 'Unscored', 'No budget'] };
  const cuts = {};
  for (const k of Object.keys(AUD)) {
    const m = new Map();
    pool.filter((l) => pass(l, k)).forEach((l) => { const v = AUD[k](l); m.set(v, (m.get(v) || 0) + 1); });
    let arr = [...m].map(([name, n]) => ({ name, n }));
    arr = order[k] ? arr.sort((a, b) => order[k].indexOf(a.name) - order[k].indexOf(b.name)) : arr.sort((a, b) => b.n - a.n);
    cuts[k] = arr;
  }
  return {
    total: rows.length, pool: pool.length, cards, cuts, selected: want,
    rows: rows.slice(0, 300).map((l) => audienceRow(l)), allRows: rows,
  };
}
const audienceRow = (l) => ({
  id: l.id, name: l.name, partner: l.partner, email: l.email, phone: l.phone || l.mobile, age: l.age, ageBand: ageBand(l.age),
  quality: l.quality, budgetTier: l.budgetTier, path: cleanPath(l.seg.immigration), advisorPath: cleanPath(l.advisorPath), ...(l.persona || {}),
  stage: l.stage, status: l.status, lostReason: l.lostReason, user: l.user, source: l.source,
  created: l.created ? String(l.created).slice(0, 10) : null, historical: !!l.historical,
});

// Compare chosen values of one dimension (immigration path, consultant's path, budget tier, market, source, medium)
// side by side and against all leads of the period: counts, share and a time series each.
const CMP = {
  path: (l) => (l.seg.immigration ? String(l.seg.immigration) : '(none)'), advisor: (l) => l.advisorPath || '(not set)',
  budget: (l) => l.budgetTier || 'No budget', market: (l) => l.market || 'Unknown', source: (l) => l.source || '(none)',
  medium: (l) => l.medium || '(none)', destination: (l) => l.seg.destination || '(none)',
};
function compare(leads, q, win) {
  const dim = CMP[q.dim] ? q.dim : 'path';
  const f = CMP[dim];
  const options = dimension(leads, f).map((r) => ({ name: r.name, n: r.total }));
  const chosen = q.values ? String(q.values).split('|').filter(Boolean) : options.slice(0, 4).map((o) => o.name);
  const items = chosen.map((name) => {
    const ls = leads.filter((l) => f(l) === name);
    return { name, ...counts(ls), share: pct(ls.length, leads.length), series: seriesOf(ls, win) };
  });
  return { dim, options, chosen, total: { name: 'All leads', ...counts(leads), share: 100, series: seriesOf(leads, win) }, items };
}

// Form submissions vs Odoo: did each form reach a card? Matched on email, phone or mobile (last 10 digits) against every
// Odoo card (archived and duplicates included); "new card" = a card created within 2 days of the form.
function forms(all, sheet, win) {
  if (!sheet || !sheet.forms) return { available: false };
  const ph = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 9 ? `p${d.slice(-10)}` : null; };
  const em = (v) => { const e = String(v || '').trim().toLowerCase(); return e.includes('@') ? `e${e}` : null; };
  const byKey = new Map();
  for (const l of all) {
    if (l.sheetOnly || l.formOnly) continue;
    for (const k of [em(l.email), ph(l.phone), ph(l.mobile)].filter(Boolean)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(l); }
  }
  const dayMs = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  const rows = sheet.forms.filter((f) => !win || (f.date >= win.from && f.date <= win.to)).map((f) => {
    const cards = [em(f.email), ph(f.mobile)].filter(Boolean).flatMap((k) => byKey.get(k) || []);
    const near = cards.find((c) => Math.abs(dayMs(c.importedAt || c.created) - dayMs(f.date)) <= 2 * DAY);
    const status = near ? 'New card' : cards.some((c) => String(c.created) < f.date) ? 'Existing card (person already in Odoo)'
      : cards.length ? 'Card created later' : 'No card in Odoo';
    const sync = /^sending/i.test(f.odoo) ? 'stuck: sending' : f.odoo === '1' ? 'sent' : f.odoo === '0' || !f.odoo ? 'not sent' : f.odoo;
    return { ...f, status, sync, card: (near || cards[0] || {}).id || null };
  });
  const count = (fn) => rows.reduce((m, r) => { const k = fn(r) || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const missing = rows.filter((r) => r.status === 'No card in Odoo');
  const days = [...groupBy(rows, (r) => r.date)].sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .map(([day, rs]) => ({ day, forms: rs.length, missing: rs.filter((r) => r.status === 'No card in Odoo').length }));
  const countOf = (rs, fn) => rs.reduce((m, r) => { const k = fn(r) || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
  return { available: true, total: rows.length, byStatus: count((r) => r.status), missingBySync: countOf(missing, (r) => r.sync),
    bySource: count((r) => r.source), days, missing: missing.sort((a, b) => (a.date < b.date ? 1 : -1)) };
}

module.exports = { RT_DIMS, metaPhone, forms, compare, audience, audienceRow, contractsSent, period, bucketOf, contracts, revenueCheck, retargeting, diagnostics, summary, sources, journey, lost, sales, deep, segments, filterLeads, facets, counts };
