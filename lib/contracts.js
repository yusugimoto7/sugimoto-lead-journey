// Contracts, read live from the n8n webhook that also feeds the Contracts Dashboard: the Finance sheet
// ("ALL Numbers", Sugimoto contracts) and the SparkBridge sheet ("Customer Info", 1Omp… file, the owner's master).
// Rows are joined to Odoo cards by contract number (x_contract_no_sg / x_contract_no_sb), never by personal data.
const NATIVE_START = '2024-11-01';
// Days on which earlier leads were bulk-imported as new cards (owner: 2026-09-25); only the imported records count.
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

// A number typed into a numeric cell comes back as "251015.0".
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '').replace(/\.0+$/, '');
const money = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v || '').replace(/[^0-9.\-]/g, '');
  return s && !Number.isNaN(Number(s)) ? Number(s) : null;
};
// n8n sends the sheets' display text. A part over 12 settles the order. Both parts <= 12 follow the sheet's own habit,
// checked against the dates on the linked Odoo cards: the Finance sheet writes DD/MM (534 of 534 ambiguous dates that
// differ agree with Odoo that way), SparkBridge mostly MM/DD (242 against 67). The odd one that lands in the future
// is read the other way round. Ambiguous reads are flagged.
function parseDate(v, dayFirst = false) {
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
  const [usual, other] = dayFirst ? [iso(b, a), iso(a, b)] : [iso(a, b), iso(b, a)];
  const today = new Date().toISOString().slice(0, 10);
  if (usual > today && other <= today) return { date: other, flag: `ambiguous, read as ${dayFirst ? 'MM/DD' : 'DD/MM'} (the other way is in the future)` };
  return { date: usual, flag: `ambiguous ${dayFirst ? 'DD/MM' : 'MM/DD'}` };
}
// Contract categories over the sheets' free-text types (SG = Finance sheet, SB = SparkBridge).
const CATEGORIES = [
  ['Startup visa · Canada', /^suv\s*-\s*ca|partnership/i],
  ['Startup visa · Europe', /^suv|market research/i],
  ['Study · Canada', /^sp\b|^sp-adm|study-ca/i],
  ['Study & language · Europe', /study-eu|eu-study|eu-lang|ausbildung/i],
  ['Visitor visa', /^trv|visitor record|supervisa/i],
  ['Work permit', /^wp\b|owp|in-wp|^imp\b|^ict\b|lmia|care ?giver|bluecard|^dn\b/i],
  ['Permanent residence & citizenship', /express|^ee\b|^pr\b|pnp|spon|^cit\b/i],
  ['Investment residence · Europe', /^fip/i],
  ['Legal & other services', /judicial|mandamus|atip|amendment|pfl|probono/i],
];
const categoryOf = (type) => {
  const t = String(type || '').trim();
  if (!t || /^unknown$/i.test(t)) return 'Type not set';
  return (CATEGORIES.find(([, re]) => re.test(t)) || ['Other'])[0];
};
// One name per service across the four places a card's service is written: the sheets' Type ("SUV - Ca", "TRV- B"),
// Odoo's Service Agreement ("EE · Express Entry – PR …", the code before the first " · " is used), Odoo's Contract Type
// list ("CA-SUV", "EU-SP") and its older free-text Contract Type ("SUV"). The original text stays on the card; this only
// groups spellings of the same service. Order matters: the first match wins.
const SERVICES = [
  ['Startup visa · Europe', /^eu-?suv|suv\s*-\s*(eu|netherland|finland|denmark|lithuania|estonia)|market research/i],
  ['Startup visa · Canada', /^(ca-)?suv\b|partnership/i],
  ['Entrepreneur PNP (BC / Alberta)', /^(bc|ab)-ent/i],
  ['Study · Canada', /^(ca-)?sp\b|^sp-(adm|only)|study-ca/i],
  ['Ausbildung · Europe', /ausbildung|^eu-asb/i],
  ['Study & language · Europe', /^eu-(sp|study|lang|visa-only)|study-eu/i],
  ['Sponsorship', /spon|sponsorship/i],
  ['Express Entry / PNP', /express|^(ca-)?ee\b|pnp|^pr\b/i],
  ['Business visitor visa', /business trv|^trv-?\s*b\b|trv bis/i],
  ['Visitor visa / record', /trv|visitor|^(ca-)?vr\b|supervisa/i],
  ['Iranian open work permit', /iranian (o?wp|work permit)/i],
  ['Business work permit (ICT / IMP)', /\b(ict|imp)\b/i],
  ['Work permit · Canada', /^(ca-|re-|in-)?wp\b|care ?giver|lmia/i],
  ['Work & residence · Europe', /^(eu-)?dn\b|blue ?card|^fip/i],
  ['Court & legal', /judicial|jrc|mandamus|^ca-mc|atip|amendment|pfl/i],
  ['Citizenship & H&C', /^cit\b|^hc\b/i],
];
function serviceOf(raw) {
  const t = String(raw || '').split(' · ')[0].trim();
  if (!t || /^(unknown|not decided|test)$/i.test(t)) return null;
  return (SERVICES.find(([, re]) => re.test(t)) || ['Other'])[0];
}
// Contract value from the sheets (owner: the sheets are the basis, SUV fees changed over time). Finance rows: the
// "Sugimoto professional Fee" when set, else "Professional Fees". SparkBridge rows: the SparkBridge fee only (their
// Sugimoto column repeats the linked Finance contract).
const feeOf = (r) => (r.company === 'SG' ? (r.fees.sheetSG || r.fees.sheetProfessional || 0) : (r.fees.sheetSB || 0));
function feesOf(rows) {
  const out = { CAD: 0, EUR: 0, SG: { CAD: 0, EUR: 0 }, SB: { CAD: 0, EUR: 0 } };
  for (const r of rows) {
    if (r.step !== 'signed' || !r.currency) continue;
    const f = feeOf(r);
    out[r.currency] += f; out[r.company][r.currency] += f;
  }
  return out;
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
    const d = { issued: parseDate(r[2], true), signed: parseDate(r[3], true), paid: parseDate(r[4], true) };
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
    r.category = categoryOf(r.type);
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
// Form submissions (site assessment form, sheet "Site-Assessments Leads" tab Main), when the n8n feed carries them as
// `forms`: header row first, like sg/sb. Same clean-up as the form dashboard: rows with the same name, phone, email and
// date collapse to one; test rows (test@king.com, "Saeed Test", "budjet") are dropped. Dates are DD/MM/YYYY.
function formsFromFeed(feed) {
  const a = feed && feed.forms;
  if (!Array.isArray(a) || a.length < 2) return null;
  const h = a[0].map((x) => String(x || '').trim());
  const col = (n) => h.indexOf(n);
  const C = { name: col('Name & Surname'), date: col('Created At'), mobile: col('Mobile'), email: col('Email'), source: col('Source'), medium: col('Medium'), campaign: col('Campaign'), odoo: col('added_to_odoo'),
    age: col('سن شما'), destination: col('مقصد مهاجرت'), path: col('روش مهاجرت'), budget: col('Budget') };
  if (C.date < 0) return null;
  const iso = (v) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v || '')); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
  const seen = new Set();
  const out = [];
  a.slice(1).forEach((r, i) => {
    const f = { row: i + 2, name: String(r[C.name] || '').trim(), date: iso(r[C.date]), mobile: String(r[C.mobile] || '').trim(),
      email: String(r[C.email] || '').trim(), source: String(r[C.source] || '').trim() || null, medium: String(r[C.medium] || '').trim() || null,
      odoo: String(r[C.odoo] ?? '').trim(), campaign: C.campaign >= 0 ? String(r[C.campaign] || '').trim() || null : null,
      age: C.age >= 0 && Number(r[C.age]) > 0 ? Number(r[C.age]) : null, destination: C.destination >= 0 ? String(r[C.destination] || '').trim() || null : null,
      path: C.path >= 0 ? String(r[C.path] || '').replace(/\s+/g, ' ').trim() || null : null, budget: C.budget >= 0 ? String(r[C.budget] || '').trim() || null : null };
    f.sync = /^sending/i.test(f.odoo) ? 'stuck: sending' : f.odoo === '1' ? 'sent' : 'not sent';
    if (!f.date || /test@king\.com/i.test(f.email) || /saeed test|budjet/i.test(f.name)) return;
    const k = [f.name, f.mobile, f.email.toLowerCase(), f.date].join('|');
    if (seen.has(k)) return;
    seen.add(k); out.push(f);
  });
  return out;
}

// Forms with no Odoo card at all (by email, phone or mobile on any card, archived and duplicates included).
const phKey = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 9 ? `p${d.slice(-10)}` : null; };
const emKey = (v) => { const e = String(v || '').trim().toLowerCase(); return e.includes('@') ? `e${e}` : null; };
function formOnlyLeads(leads, info) {
  if (!info || !info.forms) return [];
  const known = new Set();
  for (const l of leads) if (!l.sheetOnly && !l.formOnly) [emKey(l.email), phKey(l.phone), phKey(l.mobile)].forEach((k) => k && known.add(k));
  return info.forms.filter((f) => ![emKey(f.email), phKey(f.mobile)].some((k) => k && known.has(k)));
}

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
    lastGood = { at: feed.at || new Date().toISOString(), rows, forms: formsFromFeed(feed), live: true };
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(feed)); } catch (e) { /* cache is best effort */ }
    console.log(`[contracts] ${rows.length} contract rows from n8n (Finance ${rows.filter((r) => r.company === 'SG').length}, SparkBridge ${rows.filter((r) => r.company === 'SB').length}), read ${lastGood.at}`);
    return lastGood;
  } catch (e) {
    if (!lastGood) {
      try {
        const feed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        lastGood = { at: feed.at, rows: rowsFromFeed(feed), forms: formsFromFeed(feed), live: false };
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
      step: top.step, outcome: top.outcome, status: top.status, type: top.type, currency: top.currency, fee: feeOf(top) || null,
      signed, period: signed ? (signed < NATIVE_START ? 'pre-native' : 'native') : 'unknown',
      draftOn: firstDate(rows.filter((r) => ['draft_sent', 'contract_sent', 'signed', 'terminated'].includes(r.step)), ['issued']),
      sheets: [...new Set(rows.map((r) => (r.company === 'SG' ? 'Finance' : 'SparkBridge')))],
      dateFlags: [...new Set(rows.flatMap((r) => r.dateFlags))],
    };
  });
  for (const c of clients) {
    c.fees = feesOf(c.rows);
    for (const l of c.leads) {
      l.sheetFees = c.fees;
      l.sheet = { outcome: c.outcome, step: c.step, status: c.status, type: c.type, fee: c.fee, currency: c.currency, signed: c.signed, period: c.period,
        draftOn: c.draftOn, sheets: c.sheets, dateFlags: c.dateFlags, contracts: c.rows.map((r) => `${r.company} ${r.no || `row ${r.row}`}`) };
    }
  }
  return { generatedAt: feed.at, live: feed.live, error: feed.error || null, sources: SOURCES, clients, rows: feed.rows, forms: feed.forms || null };
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
// - Stage 20, 21, 22 and "Won" are signed and paid (set in normalise).
// - Dates: Odoo cards by "Created on"; imported cards by "Created at" (historical cards in normalise, the 2026-09-25
//   sheet-import cards here). An imported card whose person already has an original historical card is a duplicate.
// - Signed contracts with no Odoo card are added as converted, at their signing date.
// - With the sheets loaded, every historical outcome is known: signed per the above, otherwise not signed.
function applyOutcomes(leads, info, { phase }) {
  const out = { batch: 0, batchNoDate: 0, historicalSigned: 0, duplicates: 0, sheetOnly: 0 };
  if (!info) return out;
  const histByEmail = new Map();
  for (const l of leads) if (l.historical) for (const e of emailsOf(l)) { if (!histByEmail.has(e)) histByEmail.set(e, []); histByEmail.get(e).push(l); }
  const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));
  const carriedBy = new Map(); // historical card id -> carrier, so one client counts once
  const originalOf = (l) => emailsOf(l).flatMap((e) => histByEmail.get(e) || []).filter((h) => !h.preCrmClient).sort(byCreated)[0];
  // Owner: reports date Odoo cards by "Created on"; imported cards by "Created at". The 2026-09-25 import (fee source
  // "Google Sheet") holds leads from before the native period, so those cards are historical, dated by Created at.
  const isBatch = (l) => !!l.created && IMPORT_DAYS.includes(l.created.slice(0, 10)) && l.cf.x_fee_source === 'Google Sheet';
  for (const l of leads) {
    if (l.historical || l.sheetOnly || !isBatch(l)) continue;
    l.historical = true; l.preCrmClient = true; l.importedAt = l.created; l.lost = false; l.revenueCounted = false;
    if (l.createdAt) setDate(l, l.createdAt.slice(0, 10));
    else { l.created = null; l.dateKnown = false; l.year = 'No date'; l.month = null; out.batchNoDate++; }
    if (!l.converted) l.status = 'Historical';
    out.batch++;
    // The same person's original historical lead card already stands for the lead: count it once, there.
    const original = originalOf(l);
    if (!original) continue;
    l.duplicate = true; out.duplicates++;
    if (l.converted && !original.converted && !carriedBy.has(original.id)) {
      original.converted = true; original.carriesContractOf = l.id; original.sheetFees = l.sheetFees; carriedBy.set(original.id, l); out.historicalSigned++;
    }
    l.converted = false;
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
      expectedRevenue: null, notes: '', descSource: null, odooSource: null, seg: {}, cf: {}, sheetFees: c.fees, budgetTier: 'No budget', market: c.currency === 'EUR' ? 'Europe' : c.currency === 'CAD' ? 'Canada' : null,
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

module.exports = { serviceOf, SERVICES, formOnlyLeads, categoryOf, feeOf, CATEGORIES, loadContracts, attach, applyOutcomes, parseDate, stepOf, money, NATIVE_START, CONTRACTS_URL };
