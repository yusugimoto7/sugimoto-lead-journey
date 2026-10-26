# Sugimoto Lead Journey

Read-only marketing dashboard fed live from Odoo 17 CRM (`crm.lead`) via JSON-RPC.
Node.js + Express backend, vanilla HTML + Chart.js 4.4.1 frontend.

## Run locally
```
cp .env.example .env   # fill ODOO_DB, ODOO_USERNAME, ODOO_API_KEY
npm install
npm start
```
On startup the server runs `fields_get` on `crm.lead`, logs every field containing "contract", then fetches all leads created since 2022-01-01 (500 per page). Results are cached in memory for 30 minutes (`/api/refresh` busts the cache).

## Rules
- Only `authenticate`, `fields_get` and `search_read` are ever sent to Odoo (other methods are blocked in `lib/odoo.js`).
- Converted = stage number 22 only. Revenue = stage 22 with contract type `CA-*` (CAD) or `EU-*` (EUR). Stages 13 and 18 are never revenue.
- Lost = `active=false` and a lost reason set.

## API
`/api/status`, `/api/fields`, `/api/refresh`, `/api/summary`, `/api/sources`, `/api/journey`, `/api/lost`, `/api/sales`, `/api/deep`, `/api/segments`, `/api/contracts`, `/api/revenue-check`, `/api/retargeting`, `/api/retargeting.csv`, `/api/leads` (filter/sort/page), `/api/leads.csv`.

## Deploy (Render)
`render.yaml` is included. Set `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY` and `DASHBOARD_PASSWORD` in the Render dashboard. The dashboard shows lead names, emails and phones, so set the password.

## Contracts (Contracts, Revenue check and Retargeting tabs)
Contracts are read live, on every Odoo sync, from the n8n webhook that also feeds the Contracts Dashboard
(`CONTRACTS_URL`, default `https://n8n.sugimotogroup.org/webhook/contracts-dashboard`): the Finance sheet "ALL Numbers"
(Sugimoto contracts) and the SparkBridge sheet "Customer Info" (file `1Omp…`, the owner's master copy). Rows are joined
to Odoo cards by contract number (`x_contract_no_sg` / `x_contract_no_sb`). If n8n is down, the last good read is kept
(memory and a temp file). `CONTRACTS_FILE` can point at a saved webhook response for offline tests.

Conversion rules (owner, 2026-10-21): Stage 22 and the "Won" column are signed and paid. Odoo has real cards only from
Nov 2024, so a signed card whose contract was signed earlier is a pre-CRM client: it moves to the historical period at
its signing date, and if the client's original historical lead card exists (same email), that card carries the
conversion and the import card is left out as a duplicate. Signed contracts with no Odoo card are added as converted.

Dates come from n8n as display text. Real date cells display MM/DD/YYYY; a first part > 12 is DD/MM; both parts <= 12
is read as MM/DD unless that is in the future. Odoo's ISO dates are preferred wherever the card has them.

## Offline test
`npm run fake-odoo` starts a synthetic Odoo on :8069 (`ODOO_DB=testdb ODOO_USERNAME=tester ODOO_API_KEY=key`).
