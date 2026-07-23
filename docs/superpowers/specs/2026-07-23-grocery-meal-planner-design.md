# Grocery Meal Planner — Design Spec

**Date:** 2026-07-23
**Author:** Jason Lee (with Claude Code)
**Status:** Draft, pending review

## 1. Overview

A personal, deals-first weekly meal planner and shopping router for a couple in Baltimore (zip 21224). The app pulls this week's sale items and public catalog data from five local grocers, generates a 21-meal weekly plan optimized around what's on sale, and produces a per-store shopping list with deep links back to each retailer's product page.

The app never touches personal grocery-store accounts. All data comes from public sources (official APIs where available, semi-public catalog endpoints elsewhere, and weekly circulars via Flipp as a universal backup).

## 2. User and context

- **Users:** Jason and his wife. Two people, one shared password gate. No expectation of App Store distribution, public sharing, or multi-tenant support.
- **Location:** Zip 21224 (Baltimore, Canton).
- **Shopping mode:** In-store. Users walk the aisles; the app is a planning and routing tool, not an ordering tool.
- **Household constraints:** Cooking for two adults. No hard dietary restrictions. Weeknight cook-time budget of 30–60 minutes. No hate-list of ingredients.
- **Weekly rhythm:** Full week of meals — breakfast, lunch, dinner, snacks (~21+ meals).
- **Primary flow:** Deals-first. App proposes meals built around what's on sale. Secondary flow: recipe-first — user specifies a particular recipe, app routes ingredients to the cheapest store.

## 3. Requirements

### Functional
- Pull weekly deals + relevant catalog pricing from five retailers: Harris Teeter, Target, Safeway, Giant Food, Sprouts.
- Refresh data automatically once a week (Sunday early morning).
- Generate a full 21-meal weekly plan (7 breakfast, 7 lunch, 7 dinner, plus snacks).
- Constrain generated meals to available/sale ingredients, weeknight time budget, no repeats across last 3 weeks, cuisine variety.
- Support per-meal regeneration (swap one meal without touching the rest).
- Support a recipe-first fallback flow: user drops in a single recipe and the app routes its ingredients to the cheapest available stores. Reuses the same shopping-list module as the weekly-plan flow.
- Produce a shopping list grouped by store, with aggregated quantities and deep links to each retailer's product page.
- Track pantry state (what the user already has) to avoid re-listing staples.
- Record thumbs-up/thumbs-down feedback per meal for future prompt biasing.
- Provide a health dashboard showing per-retailer ingestion status.

### Non-functional
- Runs on mobile browser (iPhone Safari). Must be mobile-responsive.
- Weekly refresh completes within Vercel Cron's 60-second budget.
- Meal-plan generation completes within ~30 seconds.
- Total ongoing cost: under $10/month.
- Deployable to Vercel via GitHub integration.

## 4. Non-goals (explicitly not in MVP)

- Receipt scanning / OCR-based pantry updates.
- Multi-user accounts (only a shared password).
- Native iOS/Android app or PWA install.
- Price history charts.
- Nutrition tracking.
- Automated ordering, cart handoff automation, or account login on the user's behalf.
- Full catalog price data for Sprouts (deals-only via Flipp in MVP).
- Social features of any kind.

## 5. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js 14 (App Router) + Tailwind + shadcn/ui | Standard mobile-responsive stack, one-click Vercel deploy |
| Backend | Next.js server actions + API routes | Single codebase, same deploy target |
| Database | Supabase Postgres (free tier) | Free-tier fits data volume, SQL suits relational needs |
| Recipe engine | Claude Sonnet 4.6 (structured JSON output) | Sufficient recipe quality when constrained; no external DB fee |
| Ingredient normalization | Claude Haiku 4.5 (structured mapping) | Cheap and fast for classification |
| Scheduled jobs | Vercel Cron | Sufficient for weekly refresh in parallel; fallback: Railway worker |
| Auth | Shared-password cookie gate | Personal use; over-engineering unwarranted |
| Source control | GitHub | Vercel deploys on push |

## 6. Architecture overview

```
                ┌──────────────────┐
                │   iPhone (user)  │
                └────────┬─────────┘
                         │ HTTPS
                ┌────────▼─────────┐        ┌────────────────────┐
                │  Vercel (Next.js)│ ─────► │  Anthropic API     │
                │  - Frontend      │        │  (Sonnet + Haiku)  │
                │  - API routes    │        └────────────────────┘
                │  - Vercel Cron   │
                └────────┬─────────┘        ┌────────────────────┐
                         │           ─────► │  Retailer APIs     │
                         │                  │  (Kroger, Target,  │
                         │                  │   Albertsons, etc) │
                         │                  └────────────────────┘
                ┌────────▼─────────┐        ┌────────────────────┐
                │ Supabase Postgres│ ─────► │  Flipp (backup)    │
                └──────────────────┘        └────────────────────┘
```

Runtime flow:
1. **Weekly refresh (automated):** Vercel Cron → `/api/jobs/weekly-refresh` → ingestion modules in parallel → normalization → deals written to DB.
2. **Sunday planning (user):** User opens app → sees weekly deals + pantry → taps "Plan my week" → meal-planner module calls Claude → 21-meal plan rendered → user reviews, regenerates individual meals as needed.
3. **Shopping list generation:** User approves plan → shopping-list module aggregates ingredients, subtracts pantry, routes to stores → per-store list with deep links rendered.
4. **Shopping:** User taps items off the list as purchased → pantry updated.

## 7. Component boundaries

```
apps/web/                        Next.js frontend + API routes + auth middleware
lib/
  ingestion/                     Per-retailer clients (fetchDeals interface)
    harris-teeter.ts             Kroger Products API client
    target.ts                    Target Redsky client
    safeway.ts                   Albertsons xAPI client
    giant.ts                     Giant Food API client
    sprouts.ts                   Flipp-only in MVP
    flipp.ts                     Weekly-circular backup for all retailers
  normalization/                 Retailer SKU → canonical ingredient mapper
  recipe-engine/                 Claude client + structured-output schema
  meal-planner/                  Deals + pantry + prefs → 21-meal plan
  shopping-list/                 MealPlan + pantry → per-store list + deep links
  pantry/                        Read/write pantry state
  db/                            Supabase client + typed schema
jobs/
  weekly-refresh.ts              Vercel Cron entrypoint (orchestrator)
```

Every `lib/*` module has one job, a defined public interface, and can be tested in isolation. `ingestion/*` modules all conform to the same `fetchDeals(zip) → NormalizedDeals[]` interface so retailers can be added or removed without touching consumers.

## 8. Data ingestion strategy

### Per-retailer plan

| Retailer | Primary source | Type | Fragility | Backup |
|---|---|---|---|---|
| Harris Teeter | Kroger Products API | Official, OAuth2 | Low | Flipp |
| Target | Redsky endpoints (`redsky.target.com`) + `weeklyad.target.com` | Unofficial | Medium | Flipp |
| Safeway | Albertsons xAPI (`albertsons.com/abs/pub/xapi/`) | Unofficial | Medium | Flipp |
| Giant Food | Giant API (`giantfood.com/api/v1.0/`, Peapod-derived) | Unofficial | Medium | Flipp |
| Sprouts | Flipp circular only (MVP) | Semi-public | Low | n/a |

### Kroger API (Harris Teeter)

- Register a developer app at `developer.kroger.com`. Free tier ~10k calls/day.
- OAuth2 client-credentials flow. Store `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` in Vercel env.
- Endpoints: `/v1/locations` (find HT stores near zip 21224), `/v1/products` (search with store filter, returns `regularPrice`, `promoPrice`, availability).
- "On sale" derivable directly from `promoPrice < regularPrice`.

### Target Redsky

- Endpoints like `redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?tcin=…&store_id=…`.
- Requires a `key` parameter discoverable from any browser request to target.com. Refresh manually if it rotates.
- Weekly ad JSON at `weeklyad.target.com`.
- Provides per-store inventory (unique among retailers).

### Albertsons xAPI (Safeway)

- Endpoints under `www.albertsons.com/abs/pub/xapi/`.
- `storeId` looked up once for closest Safeway locations to 21224 and hard-coded (with periodic refresh).
- Provides product search, promotions, weekly ad.

### Giant Food API

- Endpoints under `giantfood.com/api/v1.0/`. Peapod-derived structure similar to Albertsons.
- Same pattern: hard-coded `storeId`, product search, weekly ad.

### Sprouts (Flipp-only in MVP)

- No usable public API. Instacart catalog would work but carries a 10–25% price markup.
- MVP scope: pull Sprouts weekly circular via Flipp. Deals-only. No general catalog pricing.
- Trade-off accepted: Sprouts contributes to meal-planning only when its sale items are relevant.
- Future upgrade path: add Instacart catalog integration if coverage gaps become painful.

### Flipp (universal backup)

- Reverse-engineered API at `backflipp.wishabi.com`.
- Every one of the five retailers has a weekly Flipp circular.
- Serves three roles:
  1. Backup source for any retailer whose primary scraper fails.
  2. Primary source for Sprouts.
  3. Optional cross-check of `on_sale` flags from retailer APIs.

### Normalization

Each retailer returns products with its own SKUs and naming conventions. A canonical ingredient table (~200 items seeded manually) provides a common vocabulary. Mapping process:

1. On first sight of any retailer SKU, `normalization/` calls Claude Haiku 4.5 with the product name and the canonical list.
2. Haiku returns the best-match canonical ID or `unknown` + a confidence score.
3. Mapping cached in `retailer_skus.canonical_ingredient_id` (with `mapping_confidence` and `mapping_verified` fields). Never re-queried.
4. User-facing "correct this mapping" UI lets the user manually fix bad matches when noticed. Manual corrections set `mapping_verified = true` and take precedence forever.

### Weekly orchestration

`/api/jobs/weekly-refresh` (triggered by Vercel Cron every Sunday at 5:00 AM ET):

```
For each retailer in parallel (Promise.all):
    1. Try primary source. On success → normalize → upsert deals.
    2. On failure → try Flipp fallback → normalize → upsert deals.
    3. Update retailer_health with status: OK / DEGRADED / FAILED.

If any FAILED and last successful run > 7 days ago:
    Send notification email via Resend (or equivalent transactional email API).
```

Target total runtime: 10–20s in parallel. Fits Vercel Cron's 60s Hobby-tier limit.

## 9. Recipe engine and meal planning

### Inputs to the planner

- This week's deals (with canonical ingredient IDs and cheapest-store info).
- Current pantry state.
- Last 3 weeks of meals (to avoid repeats).
- User preferences: household size (2), weeknight time budget (30–60 min), dietary restrictions (none), thumbs-up/down history.

### Approach

Single structured LLM call to Claude Sonnet 4.6.

**Prompt structure:**
1. **Available ingredients:** List of `{canonical_id, name, cheapest_store, sale_price}`.
2. **Pantry contents:** List of `{canonical_id, name}`.
3. **Constraints:**
   - 21 meals: 7 breakfast, 7 lunch, 7 dinner, plus 5–7 snacks.
   - Weeknight dinners: 30–60 minutes.
   - Prefer meals that use items on sale.
   - Prefer well-known named recipes over invented dishes.
   - No cuisine repeats more than twice in a week.
   - Do not repeat any meal name from the last 3 weeks (list attached).
   - Meals user rated thumbs-down should not appear; meals rated thumbs-up may be re-suggested.
   - Respect household preferences: exclude disliked ingredients, disliked cuisines, and dietary flags; bias toward liked ingredients and liked cuisines. Read from `household_preferences`; empty lists are no-ops.

### Output schema

```json
{
  "meals": [
    {
      "day": "monday",
      "meal_type": "dinner",
      "name": "Chicken Tikka Masala",
      "cuisine": "indian",
      "cook_time_minutes": 45,
      "servings": 2,
      "ingredients": [
        { "canonical_id": "chicken_breast", "quantity": 1.0, "unit": "lb" },
        { "canonical_id": "yellow_onion", "quantity": 1, "unit": "each" }
      ],
      "notes": "Uses chicken on sale at Harris Teeter this week."
    }
  ]
}
```

### Validation

Every generated plan runs through `meal-planner/validator.ts`:

1. **Schema validation:** malformed JSON → one retry, then error surface.
2. **Sanity check:** each meal has ≥3 ingredients, cook time in [5, 120] min, all `canonical_id`s exist in DB.
3. **Variety check:** post-generation cuisine-repeat count. On violation, request a re-shuffle from Claude.

### Recipe steps

Generated **lazily** — only when a user taps into a specific meal. Reduces cost on meals never viewed. `recipe_steps.steps_json` cached on first generation.

### Regenerate a single meal

When the user rejects a meal:
- Send Claude the full week's plan minus the rejected meal, plus the rejected name.
- Request one replacement meal for the same `day` and `meal_type` under the same constraints.
- Substitute in place. ~2s response time.

## 10. Shopping list and deep links

### Aggregation

Flatten all `meal_ingredients` for the approved plan, sum by canonical ingredient, subtract `pantry` contents. Result: net shopping requirements.

### Store routing (MVP algorithm)

Inputs: net shopping items + user's `max_stores` preference (default 3).

1. For each store, compute total cost if all items were bought there (unavailable items get a large penalty).
2. Pick the "primary store" — lowest total among stores that cover the most items.
3. For remaining unassigned items, greedily assign to the store with the biggest price advantage over the primary, until reaching `max_stores`.
4. Group output by store, sorted internally by `canonical_ingredients.aisle_group` (produce → dairy → meat → pantry → frozen).

### Deep-link patterns

| Retailer | Deep link pattern |
|---|---|
| Harris Teeter | `harristeeter.com/product/{sku}` |
| Target | `target.com/p/-/A-{tcin}` |
| Safeway | `safeway.com/shop/product-details.{sku}.html` |
| Giant Food | `giantfood.com/product/{slug}` |
| Sprouts | Weekly-ad page (no PDP, since Sprouts data is Flipp-only) |

On mobile, iOS/Android universal links open directly in the retailer's app if installed; otherwise mobile browser.

### Purchase tracking

Tapping an item on the shopping list:
- Sets `shopping_list_items.purchased_at`.
- Adds the item to `pantry` with an approximate quantity (from the aggregated need).

## 11. Pantry state

Two update paths:
1. **Auto:** Tapping items off the shopping list adds them to pantry.
2. **Manual:** A `/pantry` page with a checklist of common staples (olive oil, salt, flour, coffee, eggs, milk, butter, rice, pasta, canned tomatoes, garlic, onions…) with quick +/-, and an "add ingredient" input.

Pantry is intentionally imperfect. The planner just needs enough signal to skip staples like "olive oil" from every shopping list.

## 12. Data model

```
retailers                (id, name, deep_link_pattern)
stores                   (id, retailer_id, store_number, address, zip, is_active)
canonical_ingredients    (id, name, category, default_unit, aisle_group)
retailer_skus            (id, retailer_id, sku, product_name, package_size,
                          package_unit, image_url, canonical_ingredient_id,
                          mapping_confidence, mapping_verified)
deals                    (id, retailer_sku_id, store_id, week_of,
                          regular_price, sale_price, unit_price,
                          valid_from, valid_until, source)
pantry                   (id, canonical_ingredient_id, quantity, unit, updated_at)
meal_plans               (id, week_of, status, created_at)
meals                    (id, meal_plan_id, day, meal_type, name, cuisine,
                          cook_time_minutes, servings, notes)
meal_ingredients         (id, meal_id, canonical_ingredient_id, quantity, unit)
recipe_steps             (id, meal_id, steps_json, generated_at)
meal_ratings             (id, meal_id, rating, note, created_at)
shopping_lists           (id, meal_plan_id, max_stores, created_at)
shopping_list_items      (id, shopping_list_id, canonical_ingredient_id,
                          quantity, unit, assigned_store_id, retailer_sku_id,
                          price, deep_link_url, purchased_at)
retailer_health          (id, retailer_id, last_success_at, last_status,
                          last_error)
household_preferences    (id, dietary_flags jsonb, disliked_ingredients jsonb,
                          liked_ingredients jsonb, disliked_cuisines jsonb,
                          liked_cuisines jsonb, updated_at)
```

`household_preferences` holds a single row for the household. All list fields default to empty JSON arrays in MVP (no active preferences); the meal-planner reads the row every time and enforces its constraints even when empty (a no-op). This means adding a hate-list, dietary rule, or cuisine preference later is a UI-only change — no schema migration and no touching of the meal-planner logic.

Growth: `retailer_skus` grows slowly (thousands, mostly stable after seeding). `deals` grows a few thousand rows per week. `meal_plans`, `meals`, `meal_ingredients` grow by ~30 rows per week. Supabase free-tier limits (500 MB, 2 GB bandwidth) accommodate this for years.

## 13. Deployment

- **Source of truth:** GitHub repo, e.g. `github.com/jasonlee/grocery-planner`.
- **Frontend + API + Cron:** Vercel (Hobby plan). GitHub integration auto-deploys on push. Pull requests get preview URLs.
- **Database:** Supabase (Free tier). Managed Postgres; connection string in Vercel env.
- **Scheduled jobs:** Vercel Cron entry in `vercel.json` triggers `/api/jobs/weekly-refresh` weekly. Target time: Sunday early morning US Eastern (before user typically checks the app). Vercel Cron runs on UTC; pick a fixed UTC time (~10:00 UTC) and accept the DST drift.

### Environment variables

```
KROGER_CLIENT_ID
KROGER_CLIENT_SECRET
TARGET_REDSKY_KEY
ANTHROPIC_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY        # server-side only
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SHARED_PASSWORD
SESSION_SECRET
CRON_SECRET
```

## 14. Auth

- Middleware runs on every route except `/login` and `/api/auth/*`.
- `/login` renders a single password field.
- POST to `/api/auth/login` compares against `SHARED_PASSWORD` (constant-time compare).
- On match: sign a JWT with `SESSION_SECRET`, set as HttpOnly, Secure, SameSite=Lax cookie with 30-day expiry.
- Middleware validates the cookie on each request; on failure, redirects to `/login`.

## 15. Testing strategy

| Layer | Scope | Tooling |
|---|---|---|
| Unit | `normalization`, `shopping-list/router`, `meal-planner/validator`, prompt builders | Vitest, no I/O |
| Integration | Each `ingestion/*` module against a recorded fixture of the real API response | Vitest + fixture files; refresh fixtures manually when a scraper breaks |
| Live smoke | Manual `/admin/health` action that runs weekly refresh against real APIs and logs results | On-demand from health dashboard |
| E2E | Sunday-morning happy path: log in → see deals → plan week → generate list | Playwright, runs on Vercel preview deploys |

Claude API calls are not mocked in the integration layer for the meal planner: a real cheap Haiku call is used to verify prompt/schema correctness end-to-end.

## 16. Failure modes and health monitoring

| Failure | User experience |
|---|---|
| One retailer's primary scraper breaks | UI badge on that retailer: "Data from weekly ad only"; meal plan still works |
| All primary scrapers break, Flipp still works | Deals-only mode; meal plan still generates |
| Flipp also fails | Warning banner; recipe-first flow still usable |
| Anthropic API down | "Plan my week" button disabled with retry; raw deals still viewable |
| Supabase down | Global error page; nothing works until restored |

Maintenance realism: unofficial scrapers will break 1–3 times per year per retailer. Budgeted ~2 hours per quarter for maintenance. If maintenance cost exceeds budget for a retailer, that retailer drops to Flipp-only.

`/admin/health` page displays:
- Per-retailer: last successful run timestamp, current status, most recent error.
- Snapshot test status.
- Most recent Claude API failure (if any).

## 17. Milestone plan (~6 weeks part-time)

| Week | Deliverable |
|---|---|
| 1 | Repo + Supabase setup. Auth + password gate. Kroger API integration for Harris Teeter. Seed 200 canonical ingredients. Skeleton UI: home page shows this week's HT deals. |
| 2 | Add Target, Safeway, Giant, Sprouts (Flipp) ingestion modules. Flipp fallback wired for all. Normalization pipeline with Haiku-driven mapping + verified cache. |
| 3 | Meal planner: prompt, structured output, validator, `/plan` page rendering the 21-meal grid. Regenerate-single-meal flow. |
| 4 | Shopping list module: aggregation, store routing algorithm, deep-link generator. `/shop` page with per-store lists. |
| 5 | Pantry state (manual + tap-to-purchase). Vercel Cron weekly refresh. Health dashboard. Meal ratings. |
| 6 | Polish, mobile responsive pass, first real Sunday planning session in prod, iterate on prompt quality. |

Each week ends in a usable state, even if incomplete.

## 18. Cost estimate

| Line item | Cost |
|---|---|
| Vercel Hobby | $0 |
| Supabase Free | $0 |
| Anthropic API | ~$3–5/mo |
| Kroger API | $0 |
| Domain (optional) | ~$12/year |
| **Total** | **~$3–8/mo** |

## 19. Open considerations for later

Not blocking MVP, but worth noting:

- **Preferences editor UI (`/preferences`)** to manage dietary flags, ingredient dislikes/likes, and cuisine preferences. Schema (`household_preferences`) and meal-planner prompt integration are in place from MVP; only the UI needs building.
- **Instacart integration for Sprouts** if Flipp-only coverage proves insufficient.
- **Recipe DB fallback (Spoonacular / Edamam)** if pure-LLM recipes prove unreliable over time. The `recipe-engine/` module boundary is designed for this swap.
- **Meal-prep mode** — a variant weekly flow that biases toward batch-cookable dishes.
- **Wife's dedicated view** — if the shared password ever becomes clunky, a second cookie identity is trivial to add.
- **Push notifications** for "your weekly refresh finished, come plan the week" — requires a PWA or lightweight email trigger.
- **Price history / trend charts** — accumulate `deals` data now, add charts later if wanted.
