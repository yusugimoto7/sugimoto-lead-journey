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
const ENC_FILE = path.join(__dirname, '..', 'data', 'contracts.enc');
const PUB_FILE = path.join(__dirname, '..', 'data', 'contracts.pub.pem');

// The repo is public, so the committed snapshot is encrypted: a random AES-256-GCM key, wrapped with the RSA public
// key in data/contracts.pub.pem. Only the server holds the private key (CONTRACTS_PRIVATE_KEY: PEM or base64 of it).
function encryptSnapshot(json, publicPem = fs.readFileSync(PUB_FILE, 'utf8')) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(require('zlib').gzipSync(json)), c.final()]);
  const wrapped = crypto.publicEncrypt({ key: publicPem, oaepHash: 'sha256' }, key);
  return JSON.stringify({ v: 1, key: wrapped.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function decryptSnapshot(text, privateKey) {
  const e = JSON.parse(text);
  const pem = privateKey.includes('BEGIN') ? privateKey : Buffer.from(privateKey, 'base64').toString('utf8');
  const key = crypto.privateDecrypt({ key: pem, oaepHash: 'sha256' }, Buffer.from(e.key, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return require('zlib').gunzipSync(Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()])).toString('utf8');
}

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
  if (fs.existsSync(ENC_FILE)) {
    if (!process.env.CONTRACTS_PRIVATE_KEY) console.warn('[contracts] data/contracts.enc present but CONTRACTS_PRIVATE_KEY is not set');
    else {
      try {
        const snap = JSON.parse(decryptSnapshot(fs.readFileSync(ENC_FILE, 'utf8'), process.env.CONTRACTS_PRIVATE_KEY));
        console.log(`[contracts] ${snap.contracts.length} sheet rows from data/contracts.enc (built ${snap.generatedAt})`);
        return { ...snap, file: 'data/contracts.enc' };
      } catch (e) { console.error(`[contracts] cannot decrypt data/contracts.enc: ${e.message}`); }
    }
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

const setDate = (l, d) => {
  l.created = `${d} 00:00:00`; l.dateKnown = true;
  l.year = Number(d.slice(0, 4)); l.month = d.slice(0, 7);
};

// Applies the owner's rules once Odoo and the sheets are joined:
// - Odoo has real cards only from Nov 2024. A signed card whose contract was signed earlier is a pre-CRM client
//   imported later (mostly the "Won" column, created 2026-09-25): it moves to the historical period at its signing date.
// - Historical cards the sheets show as signed are converted.
// - Signed clients with no Odoo card at all are added as converted, at their signing date.
// - With a snapshot, every historical outcome is known: signed per the sheets, otherwise not signed.
function applyOutcomes(leads, info, { phase }) {
  const out = { preCrm: 0, historicalSigned: 0, duplicates: 0, sheetOnly: 0, coverageStart: null };
  if (!info) return out;
  for (const l of leads) {
    if (l.historical || !l.converted) continue;
    const d = l.cf.x_contract_signed_on || l.cf.x_contract_paid_on || (l.sheet && l.sheet.outcome === 'converted' ? l.sheet.signed : null);
    if (d && d < NATIVE_START) {
      l.historical = true; l.preCrmClient = true; l.importedAt = l.created; setDate(l, String(d).slice(0, 10));
      l.revenueCounted = false; // revenue stays native-only until its source is settled
      out.preCrm++;
    }
  }
  // One conversion per client. A pre-CRM client's original historical lead card carries it (real lead date and
  // source); the later import card is then a duplicate record and leaves the analytics.
  const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));
  for (const c of info.clients) {
    if (c.outcome !== 'converted' || !c.leads) continue;
    const hist = c.leads.filter((l) => l.historical && !l.preCrmClient).sort(byCreated);
    const imported = c.leads.filter((l) => l.preCrmClient).sort(byCreated);
    const nativeSigned = c.leads.some((l) => !l.historical && l.converted);
    let carrier = null;
    if (hist.length && !nativeSigned && c.period !== 'native') carrier = hist[0];
    else if (imported.length) carrier = imported[0];
    if (carrier && !carrier.converted) { carrier.converted = true; out.historicalSigned++; }
    for (const l of imported) if (l !== carrier) { l.converted = false; l.duplicate = true; out.duplicates++; }
  }
  for (const l of leads) if (l.historical && l.converted) l.status = 'Converted';
  for (const c of info.clients) {
    if (c.outcome !== 'converted' || (c.leads && c.leads.length)) continue;
    const r = c.rows.find((x) => x.outcome === 'converted') || c.rows[0];
    const lead = {
      id: `sheet:${r.sheet}#${r.row}`, name: `Signed contract not in Odoo (${r.sheet} row ${r.row})`, partner: '', email: '', phone: '',
      country: null, created: null, importedAt: null, dateKnown: false, updated: null, closed: c.signed ? `${c.signed} 00:00:00` : null,
      historical: !!c.signed && c.signed < NATIVE_START, sheetOnly: true, tags: [], year: c.signed ? null : 'No date', month: null,
      stage: '(not in Odoo)', stageNum: null, phase, user: null, refUser: r.referral ? r.referral.toLowerCase() : null,
      source: r.source, rawSource: r.source, medium: null, campaign: null, active: true, probability: null,
      lostReason: null, lost: false, converted: true, status: 'Converted', outcomeKnown: true,
      contractType: c.type, contractValue: null, currency: c.currency, revenueCounted: false, hasContractData: true,
      expectedRevenue: null, notes: '', descSource: null, odooSource: null, seg: {}, cf: {},
      sheet: { outcome: c.outcome, status: c.status, type: c.type, signed: c.signed, period: c.period, sheets: c.sheets, dateFlags: c.dateFlags },
    };
    if (c.signed) setDate(lead, c.signed);
    leads.push(lead);
    out.sheetOnly++;
  }
  // Owner: the sheets are the record of every signed contract, so with a snapshot every historical outcome is known
  // (signed or not). The sheets' first contract date is reported so the gap before it stays visible.
  out.coverageStart = info.clients.map((c) => c.signed).filter((d) => d && d >= '2020-01-01').sort()[0] || null;
  for (const l of leads) if (l.historical) l.outcomeKnown = true;
  return out;
}

module.exports = { loadSnapshot, attach, applyOutcomes, encryptSnapshot, decryptSnapshot, ENC_FILE, PUB_FILE, hashEmail, splitEmails, NATIVE_START };
