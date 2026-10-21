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
