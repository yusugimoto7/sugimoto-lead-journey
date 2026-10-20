// Local stand-in for Odoo's JSON-RPC endpoints with SYNTHETIC data, used only to test the dashboard offline.
const express = require('express');
const app = express();
app.use(express.json());
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];

const STAGES = Array.from({ length: 24 }, (_, i) => [i + 1, `${i} - Stage ${i}`]);
const SOURCES = ['Site', 'Google', 'Instagram CA', 'Referral', 'WhatsApp'].map((n, i) => [i + 1, n]);
const MEDIA = ['organic', 'cpc', 'social', 'referral'].map((n, i) => [i + 1, n]);
const CAMPS = ['Spring CA', 'EU Language', 'Brand', 'Retarget'].map((n, i) => [i + 1, n]);
const USERS = ['Sara', 'Ali', 'Mina'].map((n, i) => [i + 1, n]);
const REASONS = ['Price', 'No answer', 'Not eligible', 'Chose competitor'].map((n, i) => [i + 1, n]);
const CTYPES = ['CA-SUV', 'CA-Work', 'EU-SP / Lang. Course', 'EU-Work'];

const leads = [];
for (let i = 1; i <= 1350; i++) {
  const y = 2022 + Math.floor(rnd() * 4), m = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 27);
  const r = rnd();
  const stage = r < 0.12 ? STAGES[22] : r < 0.15 ? STAGES[23] : pick(STAGES.slice(0, 22));
  const lost = stage !== STAGES[22] && rnd() < 0.5;
  const won = stage === STAGES[22];
  const ct = won ? pick(CTYPES) : false;
  leads.push({
    id: i, name: `Lead ${i}`, partner_name: `Person ${i}`, email_from: `p${i}@example.com`, phone: `+1555${1000 + i}`,
    create_date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 10:00:00`,
    write_date: `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d + 5, 28)).padStart(2, '0')} 10:00:00`,
    date_closed: won ? `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d + 20, 28)).padStart(2, '0')} 10:00:00` : false,
    stage_id: stage, user_id: pick(USERS), active: !lost, probability: won ? 100 : Math.round(rnd() * 90),
    source_id: pick(SOURCES), medium_id: pick(MEDIA), campaign_id: pick(CAMPS), ref_user_id: rnd() < 0.2 ? pick(USERS) : false,
    lost_reason_id: lost ? pick(REASONS) : false, country_id: false, expected_revenue: 0, description: `<p>Note ${i}</p>`,
    x_studio_contract_type_1: ct, x_studio_contract_value: ct ? (ct.startsWith('CA') ? 4000 + Math.round(rnd() * 3000) : 1500 + Math.round(rnd() * 1000)) : 0,
    x_studio_budget: pick(['<10k', '10-20k', '20k+']), x_studio_destination: pick(['Canada', 'Italy', 'Germany']),
  });
}

leads.slice(0, 160).forEach((l) => {
  Object.assign(l, { tag_ids: [], description: `<p>Imported from sheet</p><p>Source: ${['Instagram', 'Referral', 'Google'][l.id % 3]}</p>`, source_id: false, active: false, create_date: '2025-10-14 09:00:00', write_date: '2025-10-14 09:00:00', date_closed: false, lost_reason_id: [9, 'Historical'] });
});
leads.slice(160).forEach((l) => { l.tag_ids = l.id % 7 === 0 ? [2] : []; });
function i1(id) { return id % 2 === 0; }
const TAGS = [{ id: 1, name: 'Historical' }, { id: 2, name: 'VIP' }];

const FIELDS = {
  tag_ids: { string: 'Tags', type: 'many2many', relation: 'crm.tag' },
  id: { string: 'ID', type: 'integer' }, name: { string: 'Opportunity', type: 'char' },
  create_date: { string: 'Created', type: 'datetime' }, write_date: { string: 'Updated', type: 'datetime' },
  stage_id: { string: 'Stage', type: 'many2one' }, user_id: { string: 'Salesperson', type: 'many2one' },
  active: { string: 'Active', type: 'boolean' }, probability: { string: 'Probability', type: 'float' },
  source_id: { string: 'Source', type: 'many2one' }, medium_id: { string: 'Medium', type: 'many2one' },
  campaign_id: { string: 'Campaign', type: 'many2one' }, ref_user_id: { string: 'Referrer', type: 'many2one' },
  lost_reason_id: { string: 'Lost Reason', type: 'many2one' }, date_closed: { string: 'Closed', type: 'datetime' },
  partner_name: { string: 'Company Name', type: 'char' }, email_from: { string: 'Email', type: 'char' },
  phone: { string: 'Phone', type: 'char' }, description: { string: 'Notes', type: 'html' },
  country_id: { string: 'Country', type: 'many2one' }, expected_revenue: { string: 'Expected Revenue', type: 'monetary' },
  x_studio_contract_type_1: { string: 'Contract Type', type: 'char' },
  x_studio_contract_value: { string: 'Contract Value', type: 'float' },
  x_studio_budget: { string: 'Budget', type: 'char' }, x_studio_destination: { string: 'Destination', type: 'char' },
};

app.post('/web/session/authenticate', (req, res) => {
  const { db, login, password } = req.body.params;
  if (process.env.FAKE_REFUSE_SESSION || db !== 'testdb' || login !== 'tester' || password !== 'key') return res.json({ jsonrpc: '2.0', id: 1, result: { uid: false } });
  res.set('Set-Cookie', 'session_id=abc123; Path=/; HttpOnly').json({ jsonrpc: '2.0', id: 1, result: { uid: 7 } });
});
app.post('/web/dataset/call_kw', (req, res) => {
  if (!(req.headers.cookie || '').includes('session_id=abc123')) {
    return res.json({ jsonrpc: '2.0', id: 1, error: { code: 100, message: 'Session expired', data: { name: 'odoo.http.SessionExpiredException', message: 'Session expired' } } });
  }
  const { model, method, args, kwargs } = req.body.params;
  if (model === 'crm.tag') return res.json({ jsonrpc: '2.0', id: 1, result: TAGS });
  if (method === 'fields_get') return res.json({ jsonrpc: '2.0', id: 1, result: FIELDS });
  if (method === 'search_read') {
    const since = args[0][0][2];
    const rows = leads.filter((l) => (kwargs.context?.active_test === false || l.active) && l.create_date >= since)
      .slice(kwargs.offset, kwargs.offset + kwargs.limit)
      .map((l) => Object.fromEntries(kwargs.fields.map((f) => [f, l[f]])));
    console.log(`[fake-odoo] search_read offset=${kwargs.offset} -> ${rows.length}`);
    return res.json({ jsonrpc: '2.0', id: 1, result: rows });
  }
  res.json({ jsonrpc: '2.0', id: 1, error: { code: 200, message: 'unsupported', data: { message: 'unsupported' } } });
});
app.post('/jsonrpc', (req, res) => {
  const { service, method, args } = req.body.params;
  const ok = (result) => res.json({ jsonrpc: '2.0', id: 1, result });
  if (service === 'common' && method === 'authenticate') return ok(args[0] === 'testdb' && args[1] === 'tester' && args[2] === 'key' ? 7 : false);
  if (service === 'object' && method === 'execute_kw') {
    const [, , key, mdl, m, a, kw] = args;
    if (mdl === 'crm.tag' && key === 'key') return ok(TAGS);
    if (key !== 'key') return res.json({ jsonrpc: '2.0', id: 1, error: { code: 200, message: 'Odoo Server Error', data: { name: 'odoo.exceptions.AccessDenied', message: 'Access Denied' } } });
    if (m === 'fields_get') return ok(FIELDS);
    if (m === 'search_read') return ok(leads.filter((l) => l.create_date >= a[0][0][2]).slice(kw.offset, kw.offset + kw.limit).map((l) => Object.fromEntries(kw.fields.map((f) => [f, l[f]]))));
  }
  res.json({ jsonrpc: '2.0', id: 1, error: { code: 200, message: 'unsupported', data: { message: 'unsupported' } } });
});
app.listen(8069, () => console.log('fake odoo on :8069'));
