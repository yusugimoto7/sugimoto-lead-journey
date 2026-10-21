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

## Contract sheets (Contracts tab and conversions)
Signed clients come from a snapshot of the SparkBridge "Customer Info" and Finance "ALL Numbers" sheets.
`tools/contract-snapshot.js <sparkbridge-grid.json> <finance-grid.json> <plain-out.json>` turns the sheets' grid data
(status, dates from cell serials, type, fees, sha256 of emails; no names or plain emails) into a plain JSON file,
which is never committed, and `data/contracts.enc`, encrypted to `data/contracts.pub.pem` (RSA-OAEP + AES-256-GCM),
which is committed because the repo is public. The server decrypts it with `CONTRACTS_PRIVATE_KEY` (PEM or base64 of
it), set once in Render. Locally, `CONTRACTS_FILE` can point at the plain file instead.

Conversion rules (owner, 2026-10-21): Stage 22 and the "Won" column are signed and paid. Odoo has real cards only from
Nov 2024, so a signed card whose contract was signed earlier is a pre-CRM client: it moves to the historical period at
its signing date, and if the client's original historical lead card exists, that card carries the conversion and the
import card is left out as a duplicate. Signed clients with no Odoo card are added as converted. With a snapshot,
historical outcomes are known (signed or not); the sheets start in January 2023.

## Offline test
`npm run fake-odoo` starts a synthetic Odoo on :8069 (`ODOO_DB=testdb ODOO_USERNAME=tester ODOO_API_KEY=key`).
