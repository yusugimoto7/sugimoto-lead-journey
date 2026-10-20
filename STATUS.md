# Project status and decisions

Working notes so a new session can pick up where the last one stopped.

## Live setup
- Odoo: `https://odoo.sugimotogroup.org`, database `sugimoto-production`, read-only API-key user.
  `/web/session/authenticate` refuses API keys; the client falls back to `/jsonrpc` (works).
- Render: https://sugimoto-lead-journey.onrender.com (HTTP Basic, user `sugimoto`, password in Render env).
- Only `authenticate`, `fields_get`, `search_read` are ever sent to Odoo.

## Data facts confirmed by the owner
- Native CRM data starts Nov 2024. Earlier leads exist only as imported "historical" cards.
- Historical cards: lost (active=false) with lost reason "Historical", tag "Historical import" (id 37).
  `create_date` = import day (Oct 2026). Their real date is in the custom "Created at" field.
  Their original source is written in the description (parsed from a `Source: X` line, format not yet seen).
- Some 2024 leads are not imported yet; when imported they must carry the same marker and "Created at".
- Currency: Europe contracts (study, startup) = EUR, Canada = CAD. No Toman.
- Converted = stage number 22 only (native). Stages 13 and 18 never count as revenue.

## Historical outcome mapping (owner-confirmed)
- Converted: Signed And Paid, Only Signed, Signed & Partially Paid, Only Paid, Partially Paid, Deposit payment, ProBono
- Not converted: Draft Sent, Contract Sent, Note Invoice Sent, blank, other
- Separate: Termination
- Duplicates across sheets: most advanced status wins
- Owner chose live read from the two contract sheets via a Google service account (option A),
  plus Signed Date, Source, Type, fees for matched historical leads.
  Sheets: SparkBridge `1aBodA_kUBrsq-ul7prpSssuqLSZa5uFK2umaKpx83Js` tab "Customer Info";
  Finance `1ZldCpkRcHuYLxNajAGyZ5yCCO1BXyUWx26SvL2Ieh-w` tab "ALL Numbers". Match key: email.

## Open questions (in order)
1. `/api/diagnostics` on real data: are `x_contract_status`, `x_fee_*`, `x_contract_*_on` already filled
   on historical cards? `odoo-migration/sheet_backfill.py` writes exactly these from the same sheets.
   If filled, read them from Odoo instead of building the Google reader.
2. Which contract type / value field is real: `x_studio_contract_type` vs `_type_1`,
   `x_studio_contract_value` vs `x_studio_contract_pricing`. Revenue figures are not trustworthy until settled.
3. SparkBridge fee columns hold 50,000-90,000 per SUV-Canada contract; owner says Canada = CAD. Sanity-check
   against totals before showing historical revenue.
4. Sheet dates mix MM/DD and DD/MM; read cell serials, flag ambiguous text dates rather than guessing.
5. Budget and destination also exist as tags (Less than 2 b ... More than 6 b; Canada / Europe):
   decide tags vs `x_budget` / `x_destination` for the Segments tab.
6. March 2026 has ~50 native leads vs 600-1,800 in other months: worth checking with the team.

## Last numbers seen (production, before Created-at change)
18,227 native + 27,274 historical; native lost 9,925; Stage 22 = 257; native conversion ≈ 1.4%.
