// Read-only Odoo 17 JSON-RPC client. Only authenticate, fields_get and search_read are ever called.
const READ_ONLY_METHODS = new Set(['fields_get', 'search_read']);

let cookie = null;
let uid = null;

const base = () => (process.env.ODOO_URL || '').replace(/\/+$/, '');

async function post(path, params) {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: Date.now() }),
  });
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status} on ${path}`);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('session_id='));
  if (sid) cookie = sid;
  const json = await res.json();
  if (json.error) {
    const e = new Error(json.error.data?.message || json.error.message || 'Odoo RPC error');
    e.odooName = json.error.data?.name;
    e.code = json.error.code;
    throw e;
  }
  return json.result;
}

async function authenticate() {
  const { ODOO_DB, ODOO_USERNAME, ODOO_API_KEY } = process.env;
  if (!base() || !ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY) {
    throw new Error('Missing ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY');
  }
  cookie = null;
  const r = await post('/web/session/authenticate', {
    db: ODOO_DB, login: ODOO_USERNAME, password: ODOO_API_KEY,
  });
  if (!r || !r.uid) throw new Error('Odoo authentication failed (check db / login / API key)');
  uid = r.uid;
  return uid;
}

async function callKw(model, method, args = [], kwargs = {}, retried = false) {
  if (!READ_ONLY_METHODS.has(method)) throw new Error(`Blocked non read-only method: ${method}`);
  if (!cookie) await authenticate();
  try {
    return await post('/web/dataset/call_kw', { model, method, args, kwargs });
  } catch (e) {
    const expired = e.code === 100 || /SessionExpired/i.test(e.odooName || '');
    if (expired && !retried) {
      await authenticate();
      return callKw(model, method, args, kwargs, true);
    }
    throw e;
  }
}

module.exports = { authenticate, callKw, baseUrl: base };
