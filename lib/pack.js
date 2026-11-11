// The static build's data file: the loaded dashboard data with no name, email or phone, stored column by column.
// encode() runs in the build (Node); decode() runs in the browser and rebuilds what lib/routes.js expects.
//
// People are still matched across cards (one row per person in Retargeting, "signed on another card"): each lead
// carries `pk`, keyed hashes (HMAC) of its email and phone keys. Without the key, which never leaves the build, a hash
// cannot be turned back into a number by trying every phone number.
const PII = ['name', 'partner', 'email', 'phone', 'mobile'];

// Each column holds the distinct values once (`d`, as JSON) and one index per lead (`i`). Shared objects (an empty
// persona, the same contract summary) come back shared, which also keeps the browser's memory down.
function columns(rows, skip) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !skip.includes(k));
  const cols = {};
  for (const k of keys) {
    const dict = new Map();
    const i = rows.map((r) => {
      const v = JSON.stringify(r[k] === undefined ? null : r[k]);
      let j = dict.get(v);
      if (j === undefined) { j = dict.size; dict.set(v, j); }
      return j;
    });
    cols[k] = { d: [...dict.keys()], i };
  }
  return { n: rows.length, cols };
}
function rows({ n, cols }) {
  const out = Array.from({ length: n }, () => ({}));
  for (const [k, { d, i }] of Object.entries(cols)) {
    const vals = d.map((s) => JSON.parse(s));
    for (let r = 0; r < n; r++) out[r][k] = vals[i[r]];
  }
  return out;
}

// hmac(text) -> short hex digest; given by the caller (Node's crypto in the build).
function encode(d, { hmac, emailKey, phoneKey, metaPhone, odooUrl }) {
  const leads = d.leads.map((l) => {
    const keys = [emailKey(l.email), phoneKey(l.phone), phoneKey(l.mobile)].filter(Boolean);
    return { ...l, pk: [...new Set(keys)].map(hmac), reachable: !!(emailKey(l.email) || metaPhone(l.phone || l.mobile)) };
  });
  const rowIndex = new Map(d.sheet ? d.sheet.rows.map((r, i) => [r, i]) : []);
  const sheet = d.sheet && {
    generatedAt: d.sheet.generatedAt, live: d.sheet.live, error: d.sheet.error, sources: d.sheet.sources, forms: null,
    rows: d.sheet.rows,
    clients: d.sheet.clients.map(({ leads: ls, rows: rs, ...c }) => ({ ...c, leadIds: ls.map((l) => l.id), rowIdx: rs.map((r) => rowIndex.get(r)) })),
  };
  return {
    v: 1, builtAt: new Date().toISOString(), fetchedAt: d.fetchedAt, odooUrl, sync: d.sync,
    det: d.det, staff: d.staff, historicalTags: d.historicalTags, fields: d.fields, missing: d.missing,
    leads: columns(leads, PII), sheet,
  };
}

function decode(p) {
  const leads = rows(p.leads);
  const byId = new Map(leads.map((l) => [l.id, l]));
  const sheet = p.sheet && {
    ...p.sheet,
    clients: p.sheet.clients.map(({ leadIds, rowIdx, ...c }) => ({ ...c, leads: leadIds.map((id) => byId.get(id)).filter(Boolean), rows: rowIdx.map((i) => p.sheet.rows[i]) })),
  };
  return { ...p, leads, sheet };
}

module.exports = { encode, decode, PII };
