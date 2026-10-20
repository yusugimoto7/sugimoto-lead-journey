// Field discovery, paginated fetch, normalisation and the 30-minute in-memory cache.
const { callKw } = require('./odoo');

const CACHE_MS = 30 * 60 * 1000;
const PAGE = 500;
const SINCE = '2022-01-01 00:00:00';

const BASE_FIELDS = [
  'id', 'name', 'create_date', 'write_date', 'stage_id', 'user_id', 'active', 'probability',
  'source_id', 'medium_id', 'campaign_id', 'ref_user_id', 'lost_reason_id', 'date_closed',
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
  return { contract, contractType, contractValue, segments };
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
  const historical = tagIds.some((id) => histIds.has(id));
  const lost = !historical && r.active === false && !!lostReason;
  const converted = !historical && num === CONVERTED_STAGE;
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
    created: r.create_date || null,
    updated: r.write_date || null,
    closed: r.date_closed || null,
    historical, tags: tagIds.map((id) => tagNames.get(id)).filter(Boolean),
    year: historical ? 'Historical' : r.create_date ? Number(r.create_date.slice(0, 4)) : null,
    month: historical ? null : r.create_date ? r.create_date.slice(0, 7) : null,
    stage, stageNum: num, phase: phaseOf(num),
    user: m2o(r.user_id), refUser: m2o(r.ref_user_id),
    source: m2o(r.source_id), medium: m2o(r.medium_id), campaign: m2o(r.campaign_id),
    active: r.active !== false,
    probability: r.probability ?? null,
    lostReason, lost, converted,
    status: historical ? 'Historical' : converted ? 'Converted' : lost ? 'Lost' : r.active === false ? 'Archived (no reason)' : 'Open',
    contractType: ctypeLabel || null, contractValue: value || null, currency,
    revenueCounted: converted && !!currency && value > 0,
    hasContractData: !!(ctypeLabel || value),
    expectedRevenue: r.expected_revenue || null,
    notes: r.description ? String(r.description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500) : '',
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
    'segments=' + JSON.stringify(Object.fromEntries(Object.entries(det.segments).map(([k, v]) => [k, v.name]))));

  const wanted = [...BASE_FIELDS, det.contractType, det.contractValue, ...det.contract.map((c) => c.name), ...Object.values(det.segments).map((s) => s.name)]
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
      if (String(t.name).trim().toLowerCase() === HISTORICAL_TAG) histIds.add(t.id);
    }
    console.log(`[discovery] ${tags.length} CRM tags; historical tag ids: ${[...histIds].join(', ') || 'NONE FOUND'}`);
    if (!histIds.size) console.warn(`[discovery] no tag named "${HISTORICAL_TAG}" — historical leads will NOT be separated`);
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
  console.log(`[sync] ${leads.length} leads fetched`);
  return { leads, det, fields, missing, historicalTags: [...histIds].map((id) => tagNames.get(id)), fetchedAt: Date.now() };
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
