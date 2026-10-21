#!/usr/bin/env node
// Builds contracts.json from the two contract sheets, exported as Sheets API grid data
// (spreadsheets.get with includeGridData and effectiveValue/formattedValue for the ranges below).
// The output holds no names, phones or plain emails: only sha256 hashes of the normalised emails.
// It is still private business data: never commit it (the repo is public). Upload it to Render as a
// Secret File named contracts.json, or point CONTRACTS_FILE at it locally.
//
// Usage: node tools/contract-snapshot.js <sparkbridge-grid.json> <finance-grid.json> [out.json]
//   SparkBridge "Customer Info" ranges: K, O, Q:R, S:W, Y (rows 2..)
//   Finance "ALL Numbers" ranges: I:J, P, R:V, Z, AS, AY (rows 2..)
const fs = require('fs');
const { hashEmail, splitEmails } = require('../lib/contracts');

const SHEETS = {
  sparkbridge: {
    id: '1aBodA_kUBrsq-ul7prpSssuqLSZa5uFK2umaKpx83Js', tab: 'Customer Info',
    cols: { type: 10, status: 14, source: 16, referral: 17, issued: 18, signed: 19, paid: 20, feeSB: 21, feeSG: 22, email: 24 },
  },
  finance: {
    id: '1ZldCpkRcHuYLxNajAGyZ5yCCO1BXyUWx26SvL2Ieh-w', tab: 'ALL Numbers',
    cols: { feeSG: 8, type: 9, status: 15, source: 17, referral: 18, issued: 19, signed: 20, paid: 21, email: 25, feeProfessional: 44, totalCost: 50 },
  },
};

// Owner-confirmed outcome mapping. Termination is its own outcome.
const CONVERTED = ['signed and paid', 'only signed', 'signed & partially paid', 'only paid', 'partially paid', 'deposit payment', 'probono'];
const outcomeOf = (s) => {
  const v = s.trim().toLowerCase();
  if (CONVERTED.includes(v)) return 'converted';
  if (v === 'termination') return 'terminated';
  return 'not_converted';
};

// Sheet dates: a number is a real date serial. Text that Sheets could not parse as MM/DD is DD/MM
// (e.g. 28/08/2023); text where both parts are <= 12 cannot be resolved and is flagged.
function toDate(cell) {
  const ev = cell && cell.effectiveValue;
  if (!ev) return { date: null };
  if (typeof ev.numberValue === 'number') {
    const n = ev.numberValue;
    if (n < 3000) return { date: null, flag: 'year only' };
    return { date: new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10) };
  }
  const m = /(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(20\d\d)/.exec(ev.stringValue || '');
  if (!m) return { date: null, flag: ev.stringValue ? 'unreadable' : undefined };
  const a = +m[1], b = +m[2];
  const [day, month] = b > 12 ? [b, a] : [a, b];
  const date = `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date, flag: a <= 12 && b <= 12 && a !== b ? 'ambiguous text date (read as DD/MM)' : undefined };
}
const text = (cell) => String((cell && (cell.formattedValue ?? '')) || '').trim();
const num = (cell) => {
  const ev = cell && cell.effectiveValue;
  return ev && typeof ev.numberValue === 'number' ? ev.numberValue : null;
};
const currencyOf = (sheet, type) => {
  if (sheet === 'finance') return 'CAD'; // the finance sheet is Canada only
  const t = type.toLowerCase();
  if (/eu|netherland|finland|ausbildung|spain|bluecard|fip|greece/.test(t)) return 'EUR';
  if (/ca\b|canada|trv|imp|ict/.test(t)) return 'CAD';
  return null;
};

function readGrid(file, sheet) {
  const blocks = JSON.parse(fs.readFileSync(file, 'utf8')).sheets[0].data;
  // Each requested range is one block; its width is the longest row it returned.
  for (const b of blocks) {
    b.start = b.startColumn || 0;
    b.width = Math.max(1, ...(b.rowData || []).map((r) => (r.values || []).length));
  }
  const cell = (row, col) => {
    const b = blocks.find((x) => col >= x.start && col < x.start + x.width);
    const r = b && b.rowData && b.rowData[row];
    return r && r.values ? r.values[col - b.start] : null;
  };
  const rows = Math.max(...blocks.map((b) => (b.rowData || []).length));
  const { cols } = SHEETS[sheet];
  const out = [];
  for (let i = 0; i < rows; i++) {
    const status = text(cell(i, cols.status));
    const emails = splitEmails(text(cell(i, cols.email)));
    if (!status && !emails.length) continue;
    const dates = Object.fromEntries(['issued', 'signed', 'paid'].map((k) => [k, toDate(cell(i, cols[k]))]));
    const type = text(cell(i, cols.type));
    const fees = {};
    for (const k of ['feeSB', 'feeSG', 'feeProfessional', 'totalCost']) if (cols[k] !== undefined) fees[k] = num(cell(i, cols[k]));
    out.push({
      sheet, row: i + 2, h: emails.map(hashEmail),
      status: status || null, outcome: outcomeOf(status),
      type: type || null, currency: currencyOf(sheet, type),
      issued: dates.issued.date, signed: dates.signed.date, paid: dates.paid.date,
      dateFlags: Object.entries(dates).filter(([, d]) => d.flag).map(([k, d]) => `${k}: ${d.flag}`),
      source: text(cell(i, cols.source)) || null, referral: text(cell(i, cols.referral)) || null,
      fees,
    });
  }
  return out;
}

if (require.main === module) {
  const [sb, fin, outFile = 'contracts.json'] = process.argv.slice(2);
  if (!sb || !fin) { console.error('usage: contract-snapshot.js <sparkbridge-grid.json> <finance-grid.json> [out.json]'); process.exit(1); }
  const contracts = [...readGrid(sb, 'sparkbridge'), ...readGrid(fin, 'finance')];
  const snap = {
    generatedAt: new Date().toISOString(),
    sources: Object.entries(SHEETS).map(([k, s]) => ({ sheet: k, id: s.id, tab: s.tab, rows: contracts.filter((c) => c.sheet === k).length })),
    contracts,
  };
  fs.writeFileSync(outFile, JSON.stringify(snap));
  const conv = contracts.filter((c) => c.outcome === 'converted');
  console.log(`${contracts.length} rows (${conv.length} converted, ${contracts.filter((c) => c.outcome === 'terminated').length} terminated);`,
    `no email: ${contracts.filter((c) => !c.h.length).length}; flagged dates: ${contracts.filter((c) => c.dateFlags.length).length} -> ${outFile}`);
}
