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
  Their original source: Odoo `source_id` on 8,996 cards; the description has no `Source:` line. 787 more carry
  `Referral code: X` (insta_direct, agent codes like E104AB); parsed as fallback source (759 after dropping "no" answers).
  18,278 historical cards (67%) have no source anywhere.
- Some 2024 leads are not imported yet; when imported they must carry the same marker and "Created at".
- Source rule (owner, 2026-10-21): historical leads with Created at <= 2023-03-31 count as "Instagram" (8,072),
  EXCEPT those with a business-partner referral code (Meisamca, E200AB, ...), which keep it as source (249, 114 codes).
  Insta-like codes count as Instagram. `INSTAGRAM_ONLY_UNTIL` / `partnerCode` in lib/data.js.
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

## Measured on production (2026-10-20)
- Historical: 27,274 cards, all have `x_original_created_at` ("Original created at"): 2022 = 7,056, 2023 = 5,383,
  2024 = 14,835. Latest historical month is 2024-08; native starts 2024-11, so Sep-Oct 2024 is a gap.
- Historical cards have NO contract data in Odoo: `x_contract_status`, `x_fee_*`, `x_contract_*_on`,
  contract numbers are 0 / 27,274. The backfill wrote only to native leads (`x_fee_source` = Google Sheet on 1,785).
  So open question 1 is answered: historical outcomes need the Google Sheets reader (or a backfill run on historical cards).
- Native Stage 22 (257): `x_studio_contract_type_1` filled 247, `x_studio_contract_type` (char) 0;
  `x_studio_contract_pricing` 0 non-zero; `x_studio_contract_value` 216 non-zero; `x_fee_total` 243 non-zero;
  `x_fee_currency` 253 (CAD 229, EUR 24). Value vs fee_total: equal on 137, differ on 72, only value 7, only fee 34.
  Typed-in values like 130 / 150 next to fee_total 130,000 show `x_studio_contract_value` has entry errors.
- Currency from type prefix (CA-/EU-) agrees with `x_fee_currency` on 238 of 241; 3 disagree.
- 383 native leads have contract status Signed / Signed and paid / partially paid / Paid but are NOT Stage 22;
  322 of them are archived with a stage name that has no number. Not counted as converted today.
- CA-SUV fees are 100,000-130,000 (SG 7,000 + SB 93,000-123,000). If CAD, they dominate revenue: check with owner.

## Contract sheets vs Odoo (measured 2026-10-21, sheets read once via the Sheets connector, not committed)
- Owner decision: read contracts from the Google Sheets; for the pre-native period count contracts fully from the sheet.
- SparkBridge "Customer Info": 727 non-empty rows (Signed And Paid 175). Finance "ALL Numbers": 942 (Signed And Paid 348).
  Deduped by email: 466 converted contracts; 262 signed before 2024-11, 185 from 2024-11, 19 no date.
  154 of 466 dates are ambiguous MM/DD vs DD/MM as text; the live reader must use serial values.
- Of the 262 pre-Nov-2024 contracts: 253 already have a NATIVE Odoo card created after signing, 3 only a historical
  card, 6 no card. So historical cards are almost never the contract holder.
- Odoo stage "Won" (no number): 321 cards created 2026-09-25, all `x_contract_status` = Signed and paid,
  `x_fee_source` = Google Sheet, archived. These are old clients imported as native cards; they inflate Sep 2026
  native volume (1,492 leads that month). 249 signed before 2024-11, 63 after, 9 no date.
- Stage 22 (257) vs sheet status: 41 Draft sent + 20 Contract sent (not signed), 2 signed pre-Nov-2024.
  Signed contracts from 2024-11 outside Stage 22: 63 Won + 27 other stages.
- Sheet data quality: fee columns hold #N/A, Status holds a person's name once, Total Cost < Professional Fees in samples.

## Contract confirmation (built 2026-10-21)
- Contracts tab + `/api/contracts` + lead detail "Contract sheet" + Leads filter, from a snapshot file (see README).
  Repo is PUBLIC: the snapshot is never committed; it goes to Render as Secret File `contracts.json`.
  Snapshot refresh = re-read both sheets (grid data) and rerun `tools/contract-snapshot.js`.
- Dates from cell serials: only 12 of 1,667 rows have a flagged date (was 154 when parsing text).
- Results: 458 signed clients (deduped by email across sheets), 4 terminated.
  From Nov 2024: 219 signed; 144 in Stage 22; 62 have a card outside Stage 22 (39 in "Won"); 13 no Odoo card.
  Before Nov 2024: 239 signed; 227 on a native card created later, 3 historical card only, 9 no card.
  Stage 22 (257 cards): 193 confirmed signed; sheets say Draft Sent 27, Contract Sent 14, Termination 4, blank 2; 17 not in sheets.
  26 clients have more than one Stage 22 card (35 extra cards), which inflates Stage 22 counts.
- Caveat: clients are grouped by shared email, so an agent/agency email used for several clients merges them.
- Owner rules (2026-10-21): Stage 22 and "Won" = signed and paid; Odoo cards exist only from Nov 2024; every signed
  client not in Odoo counts as converted. Implemented in `applyOutcomes` (lib/contracts.js), see README.
- Delivery: the repo is public, so the snapshot ships encrypted as data/contracts.enc; Render needs
  CONTRACTS_PRIVATE_KEY once (owner holds it; not stored anywhere in the repo or this environment after handover).
  To refresh later: read both sheets' grid data, rerun tools/contract-snapshot.js, commit data/contracts.enc.
- Result (live, 2026-10-21): native 338 converted / 18,009 = 1.9% (2024: 32, 2025: 162, 2026: 139, no date: 5);
  historical 252 converted / 27,432 (2022: 8, 2023: 83, 2024: 161). 253 pre-CRM cards moved to the historical
  period, 104 of them duplicates of the client's original lead card; 22 signed clients with no Odoo card added.
- Caveat: sheets start 2023-01-03, so 2022 conversions (8) are almost certainly understated.
- Open: signed per sheet but card at another stage (e.g. 18) is NOT counted (owner only named not-in-Odoo).
  Stage 22 / Won cards the sheet calls Draft/Contract Sent are counted (owner: Stage 22 = signed).
  26 clients have more than one Stage 22 card (35 extra), still counted per card.
  Revenue logic unchanged; pre-CRM cards are excluded from revenue.

## Contracts from n8n (2026-10-26, replaces the encrypted snapshot)
- Owner pointed to the Contracts Dashboard (leads-dashboard-icz4.onrender.com/contracts). Its live data comes from the
  n8n webhook /webhook/contracts-dashboard (sg = Finance rows, sb = SparkBridge rows, crm = Odoo export). Public, no auth;
  owner: no password needed. Our server reads it on each sync; join by contract number. CONTRACTS_PRIVATE_KEY and
  data/contracts.enc are gone; the key can be deleted from Render.
- SparkBridge master = the n8n one (1OmpjhgiLAgFeVGFa1ta6W1Qzk1Auoe46EhBiOt6bnT8), owner-confirmed.
- n8n (Heroku) returned 503 "Application Error" on 2026-10-26 after two reads; the loader retries once and keeps the
  last good read. Its dates are display text: asking for unformatted/serial values in the n8n Sheets node would remove
  the remaining ambiguity (793 of 1,851 rows carry a flagged date; Odoo ISO dates are used where the card has them).
- Results (n8n read 2026-10-26 12:57): 566 signed clients; from Nov 2024 277 (252 in Stage 22/Won, 25 on other stages);
  before Nov 2024 289 (251 on cards imported later). Stage 22/Won cards 578: 503 confirmed, 69 sheet says not signed,
  6 not in sheets. Conversions: native 326 / 18,182 = 1.8%; historical 243 / 27,427 (2022: 9, 2023: 76, 2024: 158).
- Revenue check: 577 signed contracts; Odoo fee = sheet on 440, differs on 47 (all Finance), 88 no fee anywhere,
  75 fee cells #N/A. Contract value per year (sheets): SparkBridge CAD 2023 1.49M, 2024 3.90M, 2025 3.75M (SUV fees
  50k-130k each); Sugimoto CAD 2023 67k, 2024 214k, 2025 202k. The Sales tab (x_studio_contract_value) shows
  2024 604k / 2025 2.04M CAD: wrong field, mixes companies. Fees are contract values, not payments received.
- Retargeting tab: 1,035 people who got a draft (319) or main contract (716) and never signed, deduped by email,
  CSV export. Draft sent listed first (owner priority).

## Overview period view (2026-10-26)
- Overview starts with "What happened in Odoo": 3d / 7d / 2w / 1m / 3m / 6m / 1y / custom, New leads (created) or Stage
  moves (date_last_stage_update), by source / medium / campaign / salesperson / referred by, source and medium filters,
  each group compared with the previous window of the same length. `/api/period`, `bucketOf` in lib/analytics.js.
- Stage groups (owner, 2026-10-26): Pre meeting 0, 1, 4 (No Show); Meeting set and done 2-3, 5-10; Pre contract
  11 (Documents & Passport Received) to 12, plus 23 Long-term follow-up; Contract sent 13-19; Signed and paid = 20, 21,
  22 or Won (20/21 now count as converted everywhere); Archive = archived and not signed, plus 24 Canceled Contracts.
- DATE RULE (owner, 2026-10-26, overrides earlier re-dating): Odoo cards are dated by "Created on" (create_date),
  imported cards by "Created at" (x_original_created_at). No re-dating by contract dates any more.
- 2026-09-25 sheet import (fee source "Google Sheet", 1,050 cards, made by Yu Sugimoto 00:00-04:00 UTC) = leads from
  before the native period -> historical. The 13 real leads of that day stay native. None of the 1,050 has Created at,
  so 700 sit in historical "No date" (197 of them signed); 350 are duplicates of the person's original historical card
  (which carries 106 signings). Filling Created at on those cards in Odoo would place them.
- Result: native 274 converted / 17,384 = 1.6%; historical 304 / 27,975.
- Contracts tab "signed from Nov 2024" (277) counts contracts by signing date; conversion figures count leads by
  their own date, so a pre-native lead signed in 2025 is a historical conversion.

## Global date window (2026-10-26)
- A bar under the tabs (3d / 7d / 2w / 1m / 3m / 6m / 1y / All time / Custom) applies to every tab. Leads are filtered
  by lead date (Created on; Created at for imported cards). With a window, every endpoint also returns `_prev` (the
  window of the same length just before) and `_window`; the UI shows growth % on KPIs and growth tables.
  Contracts / Revenue check: by signing date. Retargeting: by draft/contract issue date. All Leads + CSVs: filtered.
- Overview: the "What happened in Odoo" block follows the bar (All time -> last 30 days there); the lower section
  is the selected period (KPIs, leads per day/week/month, this period vs previous).
- Leads in the last 30 days: 1,298 vs 408 the 30 days before (+218%), mostly Instagram_ca (772 vs 209).

## Budget tiers and table totals (2026-10-26)
- Owner's tiers (can the lead afford to start a process): Tier 1 under 2B toman / under 10k CAD-EUR; Tier 2 2-4B /
  10-20k; Tier 3 4-6B / 20-40k; Tier 4 over 6B / 40-100k; Tier 5 over 100k. EUR answers follow the CAD bands (my call;
  the owner's card listed EUR only up to Tier 3). From x_budget; historical cards without it use the old form answer
  only when wholly under 2B toman, else Unscored. `budgetTier` on each lead; Segments "Budget mix", Overview
  "By budget tier", Retargeting budget column/filter, CSVs.
- All native leads: Tier 1 8,125 (46.7%, 0.4% signed), Tier 2 5,487 (2.8%), Tier 3 2,212 (2.2%), Tier 4 1,248 (1.7%),
  Tier 5 57 (0%). Historical: 7,565 Unscored (old answers like "20,000-50,000" that cross tiers).
- Every growth table ends with a Total row over all rows (rate recomputed).

## Contracts, revenue, audience (2026-10-26, later)
- Revenue basis = the contract sheets (owner: SUV amounts changed over time). Per signed card `sheetFees` (Finance:
  Sugimoto professional Fee else Professional Fees; SparkBridge: Spark fee only). Sales tab revenue uses it.
- Contracts tab (top): contracts issued in the window by category (mapping in `CATEGORIES`, lib/contracts.js) and type:
  sent / drafts / main sent / signed / rate, median days lead->contract, contract->signed, lead->signed, signed value,
  avg fee; by company, salesperson, sheet agent, lead source, budget tier; lead->signed spread; contract list + CSV.
  Reconciliation moved into a collapsible section. Note: the Finance sheet's issue date often equals the signing date
  (median contract->signed 0-11 days), so lead->contract is the more telling figure.
- Retargeting: Audience section, every unsigned lead of the window cut by age band (x_age), card quality
  (x_studio_quality), budget tier, the lead's path (x_studio_immigration_path) and "consultant's path"
  (x_studio_immigration_path_1 / _2, staff selections; ASSUMPTION, owner to confirm; filled on <3%). CSV download.
- Stage groups v2 (owner): Pre meeting 0, 00, 1, 2, 4; Meeting set and done 3, 5-10, 23; Documents received 11;
  Contract sent 12-19; Signed = 20, 21, 22, 25, Won (25 Sent to Finance Unit is new; counted as signed, my call);
  Archive = archived unsigned + 24.
- 2026-09-25 cards in Odoo: the dashboard is read-only, so it cannot set lost reason / Created at. An import file was
  prepared for the owner (1,050 rows: .id, proposed Created at = original historical card's Created at (350) or the
  earliest contract date (602); 98 have no date; 164 have a contract dated on/after 2024-11-01 and are marked CHECK).

## Market switch, journey, compare (2026-10-26, later)
- Lead Journey funnel now uses the owner's stage groups (PHASES in lib/data.js), reached = this group or later.
- Market (Canada / Europe): header switch, applied to every endpoint (`market=`). `marketOf`: Destination field
  (filled with Canada/Europe on 99% of native cards, same as the tags), else tag, source _ca/_eu, budget EUR, contract
  currency. Owner: imported historical leads dated before June 2024 (< 2024-06-01) are Canada.
  Native: Canada 10,680 (254 signed, 2.4%), Europe 6,490 (18 signed, 0.3%).
- Segments: "Compare" card (pick values of path / consultant's path / budget / market / source / medium, compared
  with all leads, table + time series). Free-text segment values are whitespace-normalised (duplicate path rows).
  The Country card (Odoo country_id = residence, ~empty) is replaced by Destination (market).

## Duplicate cards (2026-10-26)
- Owner: Odoo archives a new card (no lost reason) when the person already has a card. Checked: all 603 such cards at
  New Card in the last 30 days share an email/phone with an earlier card. Rule (lib/data.js, [dedupe]): a native card
  that is archived, has no lost reason, is not signed and shares email or phone with an earlier card is `duplicate`
  and leaves every count. 885 cards in total. Last 30 days: 1,298 -> 691 native leads; native all time 16,499.
- Not removed: other repeat cards of a known person (open 409, lost, 128 signed) since they are being worked.

## Open questions (in order)
1. ANSWERED: historical cards are empty in Odoo. Decide: build the Sheets reader (option A) or run
   `sheet_backfill.py` against historical cards so Odoo holds it (needs write access outside this dashboard).
2. Type: `x_studio_contract_type_1` (settled). Value: `x_studio_contract_value` vs `x_fee_total` (+ `x_fee_currency`)
   still the owner's call; recommendation is `x_fee_total` + `x_fee_currency`. Revenue logic unchanged until decided.
2b. Should the 383 signed/paid leads outside Stage 22 count as converted?
3. SparkBridge fee columns hold 50,000-90,000 per SUV-Canada contract; owner says Canada = CAD. Sanity-check
   against totals before showing historical revenue.
4. Sheet dates mix MM/DD and DD/MM; read cell serials, flag ambiguous text dates rather than guessing.
5. Budget and destination also exist as tags (Less than 2 b ... More than 6 b; Canada / Europe):
   decide tags vs `x_budget` / `x_destination` for the Segments tab.
6b. Source mapping (owner, 2026-10-21, `SOURCE_RULES` in lib/data.js): all Meisam spellings -> "Meisam";
   insta_direct / insta_bio / insta_story -> Instagram + medium Direct / Bio / Story; google -> "Google Ads";
   Site / site / website / sugimotovisa-site -> "Site" (separate from Google); Instagram_ca and Instagram_eu stay
   separate pages; other case-only variants take the most common spelling. Raw value kept as `rawSource`.
   directam is a medium only: source "directam" -> Instagram + medium `<medium>_directam`.
   Telegram and telegram_ad stay separate. Instagram_ad stays its own source.
   Influencer page / partner code comes from Odoo `referred` ("Referred By"), shown as "Referred by"
   (chart on Sources, filter on Leads). Campaign falls back to `x_studio_campaign_name_1` when campaign_id is empty.
   `REF_ALIASES` merges owner-confirmed typos (mahdis-soltani -> mahdis.sultani, parsaismm -> parsaism); values are
   lowercased. Page titles in `referred` (website, budget-overview, Sugimoto page names) stay as they are (owner).
- Finding: Instagram_ad = 1,778 leads (2025), 1,188 from mahdis.sultani/-soltani; 0 Stage 22, 0 contract status,
  ~95% lost or archived, 938 never left Pre-Consultation.
6. March 2026 has ~50 native leads vs 600-1,800 in other months: worth checking with the team.

## Last numbers seen (production, before Created-at change)
18,227 native + 27,274 historical; native lost 9,925; Stage 22 = 257; native conversion ≈ 1.4%.
