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
`/api/status`, `/api/fields`, `/api/refresh`, `/api/summary`, `/api/sources`, `/api/journey`, `/api/lost`, `/api/sales`, `/api/deep`, `/api/segments`, `/api/contracts`, `/api/leads` (filter/sort/page), `/api/leads.csv`.

## Deploy (Render)
`render.yaml` is included. Set `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY` and `DASHBOARD_PASSWORD` in the Render dashboard. The dashboard shows lead names, emails and phones, so set the password.

## Contract sheets (Contracts tab)
The dashboard confirms signed clients against a snapshot of the SparkBridge "Customer Info" and Finance "ALL Numbers"
sheets. `tools/contract-snapshot.js` turns the sheets' grid data into `contracts.json`: status, dates (from cell serials),
type, fees and sha256 hashes of the emails, no names or plain emails. It is still private business data and this repo
is public, so it is git-ignored and never committed. On Render, upload it under Environment > Secret Files as
`contracts.json` (read from `/etc/secrets/contracts.json`); locally set `CONTRACTS_FILE`. Without it the tab says so
and nothing else changes.

## Offline test
`npm run fake-odoo` starts a synthetic Odoo on :8069 (`ODOO_DB=testdb ODOO_USERNAME=tester ODOO_API_KEY=key`).
