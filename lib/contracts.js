// Contract snapshot from the SparkBridge and Finance sheets (built by tools/contract-snapshot.js).
// Leads are matched by sha256 of their normalised email; the snapshot never holds plain emails.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NATIVE_START = '2024-11-01';
const RANK = { not_converted: 0, converted: 1, terminated: 2 }; // most advanced status wins across sheets

const normEmail = (e) => String(e || '').toLowerCase().replace(/\s+/g, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
// Cells hold "a@x.com , b@y.com", "a@x.com / b@y.com", stray tabs/newlines and "gmail .com".
const splitEmails = (v) => String(v || '').replace(/\s*([.@])\s*/g, '$1').split(/[\s,;\/]+/)
  .map(normEmail).filter((e) => /^[^@]+@[^@]+\.[^@]+$/.test(e));
const hashEmail = (e) => crypto.createHash('sha256').update(normEmail(e)).digest('hex');

const CANDIDATES = () => [process.env.CONTRACTS_FILE, '/etc/secrets/contracts.json', path.join(__dirname, '..', 'contracts.json')].filter(Boolean);

function loadSnapshot() {
  for (const f of CANDIDATES()) {
    try {
      if (fs.existsSync(f)) {
        const snap = JSON.parse(fs.readFileSync(f, 'utf8'));
        console.log(`[contracts] ${snap.contracts.length} sheet rows from ${f} (built ${snap.generatedAt})`);
        return { ...snap, file: f };
      }
    } catch (e) { console.error(`[contracts] cannot read ${f}: ${e.message}`); }
  }
  console.warn('[contracts] no contract snapshot found; sheet confirmation is off');
  return null;
}

// One "client" per connected group of email hashes, so a client listed in both sheets counts once.
function clients(snap) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  snap.contracts.forEach((c, i) => {
    const keys = c.h.length ? c.h : [`row:${i}`];
    keys.forEach(add);
    keys.slice(1).forEach((k) => parent.set(find(k), find(keys[0])));
  });
  const groups = new Map();
  snap.contracts.forEach((c, i) => {
    const root = find((c.h.length ? c.h : [`row:${i}`])[0]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  });
  return [...groups.values()].map((rows) => {
    const best = rows.reduce((a, b) => (RANK[b.outcome] > RANK[a.outcome] ? b : a));
    const conv = rows.filter((r) => r.outcome !== 'not_converted');
    const dates = conv.map((r) => r.signed || r.paid || r.issued).filter(Boolean).sort();
    // A client with any contract signed from Nov 2024 is a native-period client (repeat clients included).
    const signed = dates.find((d) => d >= NATIVE_START) || dates[0] || null;
    return {
      hashes: [...new Set(rows.flatMap((r) => r.h))], rows,
      outcome: best.outcome, status: best.status, type: best.type, currency: best.currency,
      signed,
      period: signed ? (signed < NATIVE_START ? 'pre-native' : 'native') : 'unknown',
      dateFlags: [...new Set(conv.flatMap((r) => r.dateFlags))],
      sheets: [...new Set(rows.map((r) => r.sheet))],
    };
  });
}

// Attaches `sheet` (the client's sheet record) to every lead whose email matches.
function attach(leads, snap) {
  if (!snap) return null;
  const list = clients(snap);
  const byHash = new Map();
  list.forEach((c) => c.hashes.forEach((h) => byHash.set(h, c)));
  for (const l of leads) {
    const hit = splitEmails(l.email).map((e) => byHash.get(hashEmail(e))).find(Boolean);
    l.sheet = hit ? { outcome: hit.outcome, status: hit.status, type: hit.type, signed: hit.signed, period: hit.period, sheets: hit.sheets, dateFlags: hit.dateFlags } : null;
    if (hit) (hit.leads = hit.leads || []).push(l);
  }
  return { generatedAt: snap.generatedAt, file: snap.file, sources: snap.sources, clients: list };
}

module.exports = { loadSnapshot, attach, hashEmail, splitEmails, NATIVE_START };
