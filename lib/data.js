// Field discovery, paginated fetch, normalisation and the 30-minute in-memory cache.
const { callKw } = require('./odoo');
const contracts = require('./contracts');

const CACHE_MS = 30 * 60 * 1000;
const PAGE = 500;
const SINCE = '2022-01-01 00:00:00';

const BASE_FIELDS = [
  'id', 'name', 'create_date', 'write_date', 'stage_id', 'user_id', 'active', 'probability',
  'source_id', 'medium_id', 'campaign_id', 'referred', 'x_studio_campaign_name_1', 'lost_reason_id', 'date_closed',
  'partner_name', 'email_from', 'phone', 'description', 'country_id', 'expected_revenue', 'tag_ids',
];
// Leads imported from the old records carry this tag; set HISTORICAL_TAG to change the name.
const HISTORICAL_TAG = (process.env.HISTORICAL_TAG || 'Historical').trim().toLowerCase();

const PHASES = [
  { key: 'Pre-Consultation', min: 0, max: 2 },
  { key: 'Meeting', min: 3, max: 4 },
  { key: 'Pre-Contract Follow-Up', min: 5, max: 10 },
  { key: 'Contract Prep', min: 11, max: 12 },
  { key: 'Draft Sent', min: 13, max: 13 },
  { key: 'Post-Contract Follow-Up', min: 14, max: 17 },
  { key: 'Main Contract Sent', min: 18, max: 18 },
  { key: 'Closing', min: 19, max: 21 },
  { key: 'CONVERTED (Sent to Execution)', min: 22, max: 22 },
  { key: 'Long-Term Nurture', min: 23, max: 23 },
];
const CONVERTED_STAGE = 22;

const stageNumber = (name) => {
  const m = /^\s*(\d+)/.exec(name || '');
  return m ? parseInt(m[1], 10) : null;
};
const phaseOf = (n) => (PHASES.find((p) => n !== null && n >= p.min && n <= p.max) || { key: 'Unstaged' }).key;
const m2o = (v) => (Array.isArray(v) ? v[1] : null);
const isHistoricalName = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return !!n && (n === HISTORICAL_TAG || n.includes('histor'));
};
const htmlToText = (h) => String(h || '')
  .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
// Historical cards keep their original source as text in the description, e.g. "Source: Instagram".
const SOURCE_LINE = /(?:^|\n)\s*(?:lead\s*)?(?:source|utm[_ ]source|منبع|سورس)\s*[:：\-–][ \t]*([^\n]{1,80})/i;
// The import writes no Source line; ~3% carry a "Referral code: X" line from the old form (insta_direct,
// agent codes like E104AB), which uses the same vocabulary as Odoo's source_id. "No" answers are not a source.
const REFERRAL_LINE = /(?:^|\n)\s*referral[ \t]*code[ \t]*[:：][ \t]*([^\n]{1,80})/i;
const NO_ANSWER = /^(?:-+|no(?:ne)?|n\/?a|نه|ندارم|ن?خ[یي]ر(?:\s*ندارم)?)$/i;
// Owner rule: old leads created up to the end of March 2023 came from Instagram, except those carrying a
// business partner's referral code, which stays their source. Instagram-like codes (insta_direct) count as Instagram.
const INSTAGRAM_ONLY_UNTIL = '2023-03-31';
const partnerCode = (v) => (v && !/insta/i.test(v) ? v : null);
// Owner-confirmed source names (2026-10-21). Instagram_ca / Instagram_eu are separate pages and stay separate;
// Site is its own channel, not Google; "google" means Google Ads.
const SOURCE_RULES = [
  [/^me[iy]sam(ca)?$/i, 'Meisam'],
  // insta_<medium> codes are the Instagram source with that medium.
  [/^insta_direct$/i, 'Instagram', 'Direct'],
  [/^insta_bio$/i, 'Instagram', 'Bio'],
  [/^insta(gram)?_story$/i, 'Instagram', 'Story'],
  [/^google$/i, 'Google Ads'],
  // DirectAM is the Instagram DM tool: a medium, never a source (it already appears as comment_directam etc.).
  [/^directam$/i, 'Instagram', (m) => (m ? `${m}_directam` : 'directam')],
  [/^(site|website|sugimotovisa-site)$/i, 'Site'],
];
function canonSource(source, medium) {
  const rule = source && SOURCE_RULES.find(([re]) => re.test(source.trim()));
  if (!rule) return { source, medium };
  const m = typeof rule[2] === 'function' ? rule[2](medium) : medium || rule[2] || null;
  return { source: rule[1], medium: m };
}
// Remaining spellings that differ only by case (telegram / Telegram) take the most common spelling.
function foldCase(leads, key) {
  const seen = new Map();
  for (const l of leads) {
    const v = l[key];
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) seen.set(k, new Map());
    seen.get(k).set(v, (seen.get(k).get(v) || 0) + 1);
  }
  const best = new Map([...seen].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  for (const l of leads) if (l[key]) l[key] = best.get(l[key].toLowerCase());
}
// "Referred By" holds the influencer page for paid Instagram ads and the partner code for referrals.
// Page titles (website, budget-overview, ...) stay as they are. Owner-confirmed typo variants are merged.
const REF_ALIASES = { 'mahdis-soltani': 'mahdis.sultani', parsaismm: 'parsaism' };
const cleanRef = (v) => {
  const c = typeof v === 'string' ? v.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase() : '';
  return c ? REF_ALIASES[c] || c : null;
};
const sourceFromText = (t) => {
  const m = SOURCE_LINE.exec(t) || REFERRAL_LINE.exec(t);
  const v = m ? m[1].trim().replace(/[.;,]+$/, '') : '';
  return v && !NO_ANSWER.test(v) ? v : null;
};

// Segment fields (budget / immigration path / destination) are discovered by keyword, never hard-coded.
const SEGMENT_KEYWORDS = {
  budget: ['budget'],
  immigration: ['immigration', 'program', 'path', 'visa type', 'pathway'],
  destination: ['destination', 'target country', 'country of interest'],
};

function discoverFields(all) {
  const entries = Object.entries(all);
  const contract = entries
    .filter(([n, f]) => /contract|fee/i.test(n) || /contract|fee/i.test(f.string || ''))
    .map(([n, f]) => ({ name: n, string: f.string, type: f.type }));

  const pick = (preferred, test) => {
    if (all[preferred]) return preferred;
    const hit = contract.find((c) => test(c));
    return hit ? hit.name : null;
  };
  const contractType = pick('x_studio_contract_type_1', (c) => /type/i.test(c.name + c.string));
  const contractValue = pick('x_studio_contract_value', (c) =>
    ['float', 'monetary', 'integer'].includes(c.type) && /(value|amount|price)/i.test(c.name + c.string));

  const usable = ['char', 'selection', 'many2one', 'text'];
  const segments = {};
  for (const [seg, words] of Object.entries(SEGMENT_KEYWORDS)) {
    const hit = entries.find(([n, f]) =>
      n.startsWith('x_') && usable.includes(f.type) &&
      words.some((w) => (n + ' ' + (f.string || '')).toLowerCase().includes(w)));
    if (hit) segments[seg] = { name: hit[0], string: hit[1].string, type: hit[1].type };
  }
  // Historical cards carry their real creation date in a custom "Created at" field (create_date is the import day).
  const dateFields = entries.filter(([n, f]) => n !== 'create_date' && ['date', 'datetime'].includes(f.type)
    && /creat|original|lead.?date/i.test(n + ' ' + (f.string || '')));
  const envField = process.env.HISTORICAL_DATE_FIELD;
  const histDateHit = (envField && all[envField] && [envField])
    || dateFields.find(([n, f]) => n.startsWith('x_') && /created\s*at/i.test(f.string || ''))
    || dateFields.find(([n]) => n.startsWith('x_'));
  const histDate = histDateHit ? histDateHit[0] : null;
  return { contract, contractType, contractValue, segments, histDate,
    histDateCandidates: dateFields.map(([n, f]) => ({ name: n, string: f.string, type: f.type })) };
}

// Raw contract-related values, kept only for the diagnostics endpoint.
function fieldValue(v, m) {
  if (v === false || v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) return v[1];
  if (m && m.type === 'selection' && m.selection) return (m.selection.find((x) => x[0] === v) || [, v])[1];
  return v;
}

function normalise(r, ctx) {
  const { det, meta, tagNames, histIds } = ctx;
  const stage = m2o(r.stage_id) || '(no stage)';
  const num = stageNumber(stage);
  const ctype = det.contractType && r[det.contractType] ? String(r[det.contractType]) : null;
  const ctypeLabel = ctype && meta[det.contractType]?.selection
    ? (meta[det.contractType].selection.find((s) => s[0] === ctype) || [, ctype])[1] : ctype;
  const upper = (ctypeLabel || '').trim().toUpperCase();
  const currency = upper.startsWith('CA-') ? 'CAD' : upper.startsWith('EU-') ? 'EUR' : null;
  const value = det.contractValue ? Number(r[det.contractValue]) || 0 : 0;
  const lostReason = m2o(r.lost_reason_id);
  const tagIds = Array.isArray(r.tag_ids) ? r.tag_ids : [];
  // Historical = imported old record. Its dates and outcome are unknown, so it is never counted as
  // lost, converted or revenue, and its (import-day) create_date is kept out of the time charts.
  // Historical = imported old card: lost with the "Historical" lost reason (a matching tag also counts).
  const historical = isHistoricalName(lostReason) || tagIds.some((id) => histIds.has(id));
  const text = htmlToText(r.description);
  const descSource = historical ? sourceFromText(text) : null;
  const realDate = historical && det.histDate && r[det.histDate] ? String(r[det.histDate]) : null;
  const created = historical ? realDate : r.create_date || null;
  const rawSource = m2o(r.source_id) || descSource;
  const instagramEra = historical && !!created && created.slice(0, 10) <= INSTAGRAM_ONLY_UNTIL;
  const lost = !historical && r.active === false && !!lostReason;
  // Owner: Stage 22 and the "Won" column both mean signed and paid.
  const won = /^won$/i.test(stage.trim());
  const converted = !historical && (num === CONVERTED_STAGE || won);
  const seg = {};
  for (const [k, f] of Object.entries(det.segments)) {
    let v = r[f.name];
    if (Array.isArray(v)) v = v[1];
    else if (f.type === 'selection' && v) v = (meta[f.name].selection.find((s) => s[0] === v) || [, v])[1];
    seg[k] = v || null;
  }
  return {
    id: r.id,
    name: r.name || '',
    partner: r.partner_name || '',
    email: r.email_from || '',
    phone: r.phone || '',
    country: m2o(r.country_id),
    created, importedAt: historical ? r.create_date || null : null, dateKnown: !!created,
    updated: r.write_date || null,
    closed: r.date_closed || null,
    historical, tags: tagIds.map((id) => tagNames.get(id)).filter(Boolean),
    // Historical cards without a "Created at" date stay in their own bucket, out of the time charts.
    year: created ? Number(created.slice(0, 4)) : historical ? 'Historical' : null,
    month: created ? created.slice(0, 7) : null,
    stage, stageNum: num, phase: won ? phaseOf(CONVERTED_STAGE) : phaseOf(num),
    user: m2o(r.user_id), refUser: cleanRef(r.referred),
    ...canonSource(instagramEra ? partnerCode(rawSource) || 'Instagram' : rawSource, m2o(r.medium_id)),
    rawSource, campaign: m2o(r.campaign_id) || r.x_studio_campaign_name_1 || null,
    active: r.active !== false,
    probability: r.probability ?? null,
    lostReason, lost, converted,
    outcomeKnown: !historical, // historical outcomes become known where the contract sheets cover the period
    status: historical ? 'Historical' : converted ? 'Converted' : lost ? 'Lost' : r.active === false ? 'Archived (no reason)' : 'Open',
    contractType: ctypeLabel || null, contractValue: value || null, currency,
    revenueCounted: converted && !!currency && value > 0,
    hasContractData: !!(ctypeLabel || value),
    expectedRevenue: r.expected_revenue || null,
    notes: text.slice(0, 1500),
    descSource, odooSource: m2o(r.source_id),
    seg,
    cf: Object.fromEntries(det.contract.map((c) => [c.name, fieldValue(r[c.name], meta[c.name])])),
  };
}

const state = { data: null, promise: null, error: null, failedAt: 0 };
const RETRY_AFTER_FAILURE_MS = 60 * 1000;

async function load() {
  const all = await callKw('crm.lead', 'fields_get', [], { attributes: ['string', 'type', 'relation', 'selection'] });
  return build(all);
}
async function build(all) {
  const det = discoverFields(all);
  console.log('[discovery] contract-related fields:');
  det.contract.forEach((c) => console.log(`  - ${c.name} (${c.type}) "${c.string}"`));
  if (!det.contract.length) console.warn('  (none found)');
  console.log(`[discovery] contractType=${det.contractType} contractValue=${det.contractValue}`,
    `historicalDate=${det.histDate || 'NONE'} (candidates: ${det.histDateCandidates.map((c) => `${c.name} "${c.string}"`).join(', ') || 'none'})`,
    'segments=' + JSON.stringify(Object.fromEntries(Object.entries(det.segments).map(([k, v]) => [k, v.name]))));

  const wanted = [...BASE_FIELDS, det.histDate, det.contractType, det.contractValue, ...det.contract.map((c) => c.name), ...Object.values(det.segments).map((s) => s.name)]
    .filter(Boolean);
  const fields = [...new Set(wanted)].filter((f) => all[f]);
  const missing = wanted.filter((f) => !all[f]);
  if (missing.length) console.warn('[discovery] fields not on crm.lead, skipped:', missing.join(', '));

  const tagNames = new Map();
  const histIds = new Set();
  if (all.tag_ids) {
    const tags = await callKw('crm.tag', 'search_read', [[]], { fields: ['name'], context: { active_test: false } });
    for (const t of tags) {
      tagNames.set(t.id, t.name);
    }
    const how = 'exact or contains "histor"';
    for (const t of tags) if (isHistoricalName(t.name)) histIds.add(t.id);
    console.log(`[discovery] CRM tags: ${tags.map((t) => `${t.id}:${t.name}`).join(' | ')}`);
    console.log(`[discovery] historical tag ids (${how}): ${[...histIds].join(', ') || 'NONE FOUND'}`);

  } else console.warn('[discovery] crm.lead has no tag_ids field — historical leads cannot be identified');

  const raw = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await callKw('crm.lead', 'search_read', [[['create_date', '>=', SINCE]]], {
      fields, limit: PAGE, offset, order: 'id asc', context: { active_test: false },
    });
    raw.push(...rows);
    if (rows.length < PAGE) break;
  }
  const ctx = { det, meta: all, tagNames, histIds };
  const leads = raw.map((r) => normalise(r, ctx));
  foldCase(leads, 'source');
  foldCase(leads, 'medium');
  const sheet = contracts.attach(leads, contracts.loadSnapshot());
  const added = contracts.applyOutcomes(leads, sheet, { phase: phaseOf(CONVERTED_STAGE) });
  if (sheet) console.log(`[contracts] pre-CRM clients moved to the historical period: ${added.preCrm}; original lead cards carrying a pre-CRM signing: ${added.historicalSigned}; duplicate import cards left out: ${added.duplicates}; signed clients with no Odoo card added: ${added.sheetOnly}; outcomes known from ${added.coverageStart}`);
  const hist = leads.filter((l) => l.historical);
  console.log(`[sync] ${leads.length} leads fetched; historical: ${hist.length} (with Created at date: ${hist.filter((l) => l.created).length}) (by lost reason: ${hist.filter((l) => isHistoricalName(l.lostReason)).length}); source read from description: ${hist.filter((l) => l.descSource).length}`);
  return { leads, sheet, det, fields, missing, historicalTags: [...histIds].map((id) => tagNames.get(id)), fetchedAt: Date.now() };
}

// Syncs never block a request: Render's proxy drops requests that run for ~100 s and a full
// sync is dozens of Odoo calls. Callers get the cached data (possibly stale) or null.
function startLoad(force = false) {
  if (state.promise) return state.promise;
  if (!force && state.failedAt && Date.now() - state.failedAt < RETRY_AFTER_FAILURE_MS) return null;
  state.promise = load()
    .then((d) => { state.data = d; state.error = null; state.failedAt = 0; })
    .catch((e) => { state.error = e.message; state.failedAt = Date.now(); console.error('[sync] failed:', e.message); })
    .finally(() => { state.promise = null; });
  return state.promise;
}

function current() {
  const fresh = state.data && Date.now() - state.data.fetchedAt < CACHE_MS;
  if (!fresh) startLoad();
  return state.data;
}

module.exports = { current, startLoad, state, PHASES, CONVERTED_STAGE, CACHE_MS };
