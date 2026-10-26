// Contracts, read live from the n8n webhook that also feeds the Contracts Dashboard: the Finance sheet
// ("ALL Numbers", Sugimoto contracts) and the SparkBridge sheet ("Customer Info", 1Omp… file, the owner's master).
// Rows are joined to Odoo cards by contract number (x_contract_no_sg / x_contract_no_sb), never by personal data.
const NATIVE_START = '2024-11-01';
// Days on which earlier leads were bulk-imported as new cards (owner: 2026-09-25).
const IMPORT_DAYS = (process.env.IMPORT_DAYS || '2026-09-25').split(',').map((d) => d.trim()).filter(Boolean);
const CONTRACTS_URL = process.env.CONTRACTS_URL || 'https://n8n.sugimotogroup.org/webhook/contracts-dashboard';
const TIMEOUT_MS = 120 * 1000;

// Owner-confirmed outcome mapping. "Contract Sent" is the main contract, sent after the draft.
const SIGNED = ['signed and paid', 'only signed', 'signed & partially paid', 'only paid', 'partially paid', 'deposit payment', 'probono'];
function stepOf(status) {
  const v = String(status || '').trim().toLowerCase();
  if (SIGNED.includes(v)) return 'signed';
  if (v === 'termination') return 'terminated';
  if (v === 'contract sent') return 'contract_sent';
  if (v === 'draft sent') return 'draft_sent';
  if (v === 'note invoice sent') return 'invoice_sent';
  return v ? 'other' : 'blank';
}
const outcomeOf = (step) => (step === 'signed' ? 'converted' : step === 'terminated' ? 'terminated' : 'not_converted');
// Most advanced step wins when a card has several contracts.
const RANK = { blank: 0, other: 1, invoice_sent: 2, draft_sent: 3, contract_sent: 4, signed: 5, terminated: 6 };

const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const money = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v || '').replace(/[^0-9.\-]/g, '');
  return s && !Number.isNaN(Number(s)) ? Number(s) : null;
};
// n8n sends the sheets' display text. Real date cells display as MM/DD/YYYY; text typed as DD/MM shows itself when
// the first part is > 12. Both parts <= 12 cannot be told apart from text and is read as MM/DD, flagged.
function parseDate(v) {
  const s = String(v || '').trim();
  if (!s) return { date: null };
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}` };
  m = /^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})\.?$/.exec(s);
  if (!m) return { date: null, flag: /^\d{4}$/.test(s) ? 'year only' : 'unreadable' };
  const a = +m[1], b = +m[2];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (mo, d) => `${m[3]}-${pad(mo)}-${pad(d)}`;
  if (a > 12) return { date: iso(b, a) };
  if (b > 12 || a === b) return { date: iso(a, b) };
  // Both parts <= 12: MM/DD unless that lands in the future and DD/MM does not.
  const today = new Date().toISOString().slice(0, 10);
  if (iso(a, b) > today && iso(b, a) <= today) return { date: iso(b, a), flag: 'ambiguous, read as DD/MM (MM/DD is in the future)' };
  return { date: iso(a, b), flag: 'ambiguous MM/DD' };
}
const currencyOf = (company, type, country) => {
  if (company === 'SG') return 'CAD'; // the Finance sheet is Canada only
  const t = `${type} ${country}`.toLowerCase();
  if (/canada|\bca\b|- ca|trv|imp|ict/.test(t)) return 'CAD';
  if (/eu|europe|netherland|finland|germany|france|spain|austria|estonia|hungary|lithuania|greece|ausbildung|bluecard|england/.test(t)) return 'EUR';
  return null;
};

function rowsFromFeed(feed) {
  const out = [];
  const sg = feed.sg || [], sb = feed.sb || [];
  sg.slice(1).forEach((r, i) => {
    if (!norm(r[0]) && !String(r[1] || '').trim()) return;
    const d = { issued: parseDate(r[2]), signed: parseDate(r[3]), paid: parseDate(r[4]) };
    out.push({
      company: 'SG', no: norm(r[0]), row: i + 2, status: String(r[1] || '').trim() || null, type: String(r[7] || '').trim() || null,
      agent: String(r[8] || '').trim() || null, source: String(r[9] || '').trim() || null, country: 'Canada',
      issued: d.issued.date, signed: d.signed.date, paid: d.paid.date,
      dateFlags: Object.entries(d).filter(([, x]) => x.flag).map(([k, x]) => `${k}: ${x.flag}`),
      fees: { sheetSG: money(r[5]), sheetProfessional: money(r[6]) }, rawFees: { sheetSG: r[5], sheetProfessional: r[6] },
    });
  });
  sb.slice(1).forEach((r, i) => {
    if (!norm(r[0]) && !String(r[2] || '').trim()) return;
    const d = { issued: parseDate(r[3]), signed: parseDate(r[4]), paid: parseDate(r[5]) };
    out.push({
      company: 'SB', no: norm(r[0]), sgNo: norm(r[1]) || null, row: i + 2, status: String(r[2] || '').trim() || null,
      type: String(r[8] || '').trim() || null, agent: String(r[9] || '').trim() || null, source: String(r[10] || '').trim() || null,
      country: String(r[11] || '').trim() || null,
      issued: d.issued.date, signed: d.signed.date, paid: d.paid.date,
      dateFlags: Object.entries(d).filter(([, x]) => x.flag).map(([k, x]) => `${k}: ${x.flag}`),
      fees: { sheetSB: money(r[6]), sheetSG: money(r[7]) }, rawFees: { sheetSB: r[6], sheetSG: r[7] },
    });
  });
  for (const r of out) {
    r.step = stepOf(r.status);
    r.outcome = outcomeOf(r.step);
    r.currency = currencyOf(r.company, r.type || '', r.country || '');
  }
  return out;
}

// A failed read keeps the previous one (in memory and in a temp file, so a restart does not lose it).
// CONTRACTS_FILE points at a saved webhook response instead (offline tests).
const fs = require('fs');
const os = require('os');
const path = require('path');
const CACHE_FILE = path.join(os.tmpdir(), 'sugimoto-contracts-feed.json');
let lastGood = null;
async function fetchFeed() {
  if (process.env.CONTRACTS_FILE) return JSON.parse(fs.readFileSync(process.env.CONTRACTS_FILE, 'utf8'));
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(CONTRACTS_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text) throw new Error('empty response');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 15000)); // one gentle retry; the workflow is heavy
    }
  }
  throw lastErr;
}
async function loadContracts() {
  try {
    const feed = await fetchFeed();
    const rows = rowsFromFeed(feed);
    lastGood = { at: feed.at || new Date().toISOString(), rows, live: true };
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(feed)); } catch (e) { /* cache is best effort */ }
    console.log(`[contracts] ${rows.length} contract rows from n8n (Finance ${rows.filter((r) => r.company === 'SG').length}, SparkBridge ${rows.filter((r) => r.company === 'SB').length}), read ${lastGood.at}`);
    return lastGood;
  } catch (e) {
    if (!lastGood) {
      try {
        const feed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        lastGood = { at: feed.at, rows: rowsFromFeed(feed), live: false };
      } catch (_) { /* no earlier read */ }
    }
    console.error(`[contracts] n8n read failed: ${e.message}${lastGood ? `; using the read from ${lastGood.at}` : ''}`);
    return lastGood ? { ...lastGood, live: false, error: e.message } : null;
  }
}

const best = (rows) => rows.reduce((a, b) => (RANK[b.step] > RANK[a.step] ? b : a));
const firstDate = (rows, keys) => rows.flatMap((r) => keys.map((k) => r[k])).filter(Boolean).sort()[0] || null;

// Builds one "client" per Odoo card (or per unmatched contract) and attaches its contract summary as `lead.sheet`.
function attach(leads, feed) {
  if (!feed) return null;
  const bySG = new Map(), bySB = new Map();
  for (const l of leads) {
    if (l.cf.x_contract_no_sg) bySG.set(norm(l.cf.x_contract_no_sg), l);
    if (l.cf.x_contract_no_sb) bySB.set(norm(l.cf.x_contract_no_sb), l);
  }
  const groups = new Map(); // key: lead id, or "no:<contract>" for contracts without a card
  for (const r of feed.rows) {
    const card = r.company === 'SG' ? bySG.get(r.no) : bySB.get(r.no) || (r.sgNo && bySG.get(r.sgNo));
    r.card = card ? card.id : null;
    const key = card ? card.id : `no:${r.company === 'SB' && r.sgNo ? r.sgNo : r.no || `${r.company}#${r.row}`}`;
    if (!groups.has(key)) groups.set(key, { card, rows: [] });
    groups.get(key).rows.push(r);
  }
  const clients = [...groups.values()].map(({ card, rows }) => {
    const top = best(rows);
    const signedRows = rows.filter((r) => r.step === 'signed');
    // Signing date: Odoo's (ISO, no ambiguity) when the card has one, else the sheet's.
    const odooSigned = card && (card.cf.x_contract_signed_on || card.cf.x_contract_paid_on);
    const sheetSigned = signedRows.map((r) => r.signed || r.paid || r.issued).filter(Boolean).sort();
    const signed = top.step === 'signed'
      ? (odooSigned ? String(odooSigned).slice(0, 10) : sheetSigned.find((d) => d >= NATIVE_START) || sheetSigned[0] || null) : null;
    return {
      leads: card ? [card] : [], rows,
      step: top.step, outcome: top.outcome, status: top.status, type: top.type, currency: top.currency,
      signed, period: signed ? (signed < NATIVE_START ? 'pre-native' : 'native') : 'unknown',
      draftOn: firstDate(rows.filter((r) => ['draft_sent', 'contract_sent', 'signed', 'terminated'].includes(r.step)), ['issued']),
      sheets: [...new Set(rows.map((r) => (r.company === 'SG' ? 'Finance' : 'SparkBridge')))],
      dateFlags: [...new Set(rows.flatMap((r) => r.dateFlags))],
    };
  });
  for (const c of clients) {
    for (const l of c.leads) {
      l.sheet = { outcome: c.outcome, step: c.step, status: c.status, type: c.type, signed: c.signed, period: c.period,
        draftOn: c.draftOn, sheets: c.sheets, dateFlags: c.dateFlags, contracts: c.rows.map((r) => `${r.company} ${r.no || `row ${r.row}`}`) };
    }
  }
  return { generatedAt: feed.at, live: feed.live, error: feed.error || null, sources: SOURCES, clients, rows: feed.rows };
}
const SOURCES = [
  { sheet: 'Finance', id: '1ZldCpkRcHuYLxNajAGyZ5yCCO1BXyUWx26SvL2Ieh-w', tab: 'ALL Numbers' },
  { sheet: 'SparkBridge', id: '1OmpjhgiLAgFeVGFa1ta6W1Qzk1Auoe46EhBiOt6bnT8', tab: 'Customer Info' },
];

const setDate = (l, d) => {
  l.created = `${d} 00:00:00`; l.dateKnown = true;
  l.year = Number(d.slice(0, 4)); l.month = d.slice(0, 7);
};
const emailsOf = (l) => String(l.email || '').toLowerCase().split(/[\s,;\/]+/).filter((e) => e.includes('@'));

// Applies the owner's rules once Odoo and the sheets are joined:
// - Stage 22 and "Won" are signed and paid (set in normalise).
// - Odoo has real cards only from Nov 2024. Cards created on the import days (2026-09-25) are pre-native leads, and a
//   signed card whose contract was signed before Nov 2024 is a pre-CRM client: both move to the historical period.
//   If the client's original historical lead card exists (same email), that card stands for the lead (and carries the
//   conversion) and the import card is left out as a duplicate.
// - Signed contracts with no Odoo card are added as converted, at their signing date.
// - With the sheets loaded, every historical outcome is known: signed per the above, otherwise not signed.
function applyOutcomes(leads, info, { phase }) {
  const out = { preCrm: 0, historicalSigned: 0, duplicates: 0, sheetOnly: 0, redated: 0, importedRecords: 0, importedPre: 0 };
  if (!info) return out;
  const histByEmail = new Map();
  for (const l of leads) if (l.historical) for (const e of emailsOf(l)) { if (!histByEmail.has(e)) histByEmail.set(e, []); histByEmail.get(e).push(l); }
  const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));
  const carriedBy = new Map(); // historical card id -> carrier, so one client counts once
  const originalOf = (l) => emailsOf(l).flatMap((e) => histByEmail.get(e) || []).filter((h) => !h.preCrmClient).sort(byCreated)[0];
  const isBatch = (l) => !!l.created && IMPORT_DAYS.includes(l.created.slice(0, 10));
  // Moves a card to the historical period: at its date when that is before Nov 2024, otherwise without a date
  // (a pre-native lead whose contract came later has no known lead date).
  const toHistorical = (l, d) => {
    l.historical = true; l.preCrmClient = true; l.importedAt = l.importedAt || l.created; l.lost = false; l.revenueCounted = false;
    if (d && d < NATIVE_START) setDate(l, d);
    else { l.created = null; l.dateKnown = false; l.year = 'No date'; l.month = null; }
    if (!l.converted) l.status = 'Historical';
  };
  // A pre-native signed card: the client's original historical lead card carries the conversion, the card is a duplicate.
  const carry = (l) => {
    const original = originalOf(l);
    if (!original) return;
    l.converted = false; l.duplicate = true; out.duplicates++;
    if (carriedBy.has(original.id) || original.converted) return;
    original.converted = true; original.carriesContractOf = l.id; carriedBy.set(original.id, l); out.historicalSigned++;
  };
  // Signed cards. Owner: cards created on the import days (IMPORT_DAYS, 2026-09-25) are leads from before the native
  // period, whatever their contract date; other signed cards whose contract predates Nov 2024 are pre-CRM clients too.
  for (const l of leads) {
    if (l.historical || !l.converted) continue;
    const d = String(l.cf.x_contract_signed_on || l.cf.x_contract_paid_on || (l.sheet && l.sheet.outcome === 'converted' ? l.sheet.signed : '') || '').slice(0, 10);
    if (isBatch(l) || (d && d < NATIVE_START)) { toHistorical(l, d); out.preCrm++; carry(l); continue; }
    // A native card created after its contract was signed is placed at its signing date.
    if (d && l.created && l.created.slice(0, 10) > d) { l.importedAt = l.created; setDate(l, d); out.redated++; }
  }
  // Unsigned cards that are not new leads: the import-day cards (pre-native leads), and any card created more than a
  // day after its contract was sent (placed at the contract date; before Nov 2024 it is historical). A historical one
  // whose client has an original lead card duplicates that card.
  for (const l of leads) {
    if (l.historical || l.converted || l.sheetOnly) continue;
    const d = String(l.cf.x_contract_sent_on || (l.sheet && l.sheet.draftOn) || '').slice(0, 10);
    const late = d && l.created && new Date(`${l.created.slice(0, 10)}T00:00:00Z`) - new Date(`${d}T00:00:00Z`) > 86400000;
    if (isBatch(l)) toHistorical(l, d);
    else if (late && d < NATIVE_START) toHistorical(l, d);
    else if (late) { l.importedAt = l.created; setDate(l, d); out.importedRecords++; continue; }
    else continue;
    out.importedRecords++; out.importedPre++;
    if (originalOf(l)) { l.duplicate = true; out.duplicates++; }
  }
  for (const c of info.clients) {
    if (c.outcome !== 'converted' || c.leads.length) continue;
    const r = c.rows.find((x) => x.step === 'signed') || c.rows[0];
    const lead = {
      id: `sheet:${r.company}:${r.no || r.row}`, name: `Signed contract not in Odoo (${r.company} ${r.no || `row ${r.row}`})`,
      partner: '', email: '', phone: '', country: r.country, created: null, importedAt: null, dateKnown: false, updated: null,
      closed: c.signed ? `${c.signed} 00:00:00` : null, historical: !!c.signed && c.signed < NATIVE_START, sheetOnly: true,
      tags: [], year: c.signed ? null : 'No date', month: null, stage: '(not in Odoo)', stageNum: null, phase,
      user: r.agent, refUser: null, source: r.source, rawSource: r.source, medium: null, campaign: null, active: true,
      probability: null, lostReason: null, lost: false, converted: true, status: 'Converted', outcomeKnown: true,
      contractType: c.type, contractValue: null, currency: c.currency, revenueCounted: false, hasContractData: true,
      expectedRevenue: null, notes: '', descSource: null, odooSource: null, seg: {}, cf: {},
      sheet: { outcome: c.outcome, step: c.step, status: c.status, type: c.type, signed: c.signed, period: c.period,
        draftOn: c.draftOn, sheets: c.sheets, dateFlags: c.dateFlags, contracts: c.rows.map((x) => `${x.company} ${x.no || `row ${x.row}`}`) },
    };
    if (c.signed) setDate(lead, c.signed);
    c.leads.push(lead);
    leads.push(lead);
    out.sheetOnly++;
  }
  for (const l of leads) {
    if (l.historical) l.outcomeKnown = true;
    if (l.historical && l.converted) l.status = 'Converted';
  }
  return out;
}

module.exports = { loadContracts, attach, applyOutcomes, parseDate, stepOf, money, NATIVE_START, CONTRACTS_URL };
