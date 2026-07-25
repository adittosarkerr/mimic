# Mimic

**Record a task on any website once — replay it forever.** Mimic captures a task in a Chrome extension, turns it into a reusable automation with a fill-in-the-blanks form, and exposes it as a REST API. Includes accounts, subscription plans, a marketplace, and deterministic per-site adapters for Booking.com and GoZayaan.

## Stack

- **extension/** — Chrome MV3 extension (Vite) that records clicks/inputs and can replay in your own browser
- **backend/** — Node + Express + Playwright: replay engine, per-site adapters, REST API, auth/billing
- **frontend/** — React + Vite: dashboard, run pages, account, marketplace

## Run it locally

Needs Node 18+ and a Chromium-based browser (Chrome, Edge, or Brave).

```bash
# 1 · backend — API + Playwright engine
cd backend
npm install
cp .env.example .env        # optionally add a DeepSeek key
npm run dev                 # http://localhost:4545

# 2 · frontend — the web app
cd frontend
npm install
npm run dev                 # http://localhost:5174

# 3 · extension — record on any site
cd extension
npm install
npm run build
# then chrome://extensions → Developer mode → Load unpacked → pick extension/dist
```

## REST API

Create a key in **account → API access**, then run an automation by id:

```bash
curl -X POST http://localhost:4545/api/v1/automations/<id>/run \
  -H "Authorization: Bearer mk_live_…" \
  -H "Content-Type: application/json" \
  -d '{"variables": {"destination": "Bangkok", "check_in_date": "2026-09-10"}}'
```

## Coverage

**Deterministic** builds the site's own results URL from your inputs (rock-solid on `go`). **Autocomplete replay** types your value and picks the site's own suggestion — runs best via **run in my browser** (your logged-in tab), which is where these services resolve their internal place-IDs.

| Booking.com | GoZayaan | How it runs |
| --- | --- | --- |
| Hotels (stays) | Flights | Deterministic — direct results URL |
| Flights (kayak) | — | Deterministic — direct results URL |
| Attractions | — | Deterministic — direct results URL |
| Car rental | Hotels | Autocomplete replay (run in my browser) |
| Airport taxis | Tours | Autocomplete replay (run in my browser) |
| — | Visa | Autocomplete replay (run in my browser) |

**Also supported:** star / breakfast / cancellation **filters** (Booking hotels), **currency** change (`selected_currency` on Booking stays + attractions), and generic recorded-step replay + structured result extraction on **any other site**.

## Deploying (Vercel)

This repo has a root `vercel.json` deploying **frontend** (Vite) and **backend** (Express) as two services in one Vercel project. Playwright still needs a real browser and a bit more memory/time than a typical serverless function, so:

1. Import the repo into Vercel (`New Project` → pick this repo). It should detect both services automatically from `vercel.json`.
2. **Add a database** — any Postgres works, pick one:
   - **Vercel Postgres**: project → **Storage** → **Create Database** → Postgres → **Connect** — sets `POSTGRES_URL` for you automatically.
   - **Supabase** (or Neon, Railway, etc.): create a free project → Project Settings → Database → Connection string → **URI** (the direct one, not the pgbouncer/pooled one) → paste it into `POSTGRES_URL` under Vercel's Project Settings → Environment Variables yourself.

   Without one of these, data written on Vercel vanishes on every redeploy (no persistent disk there) — same code either way, it's just a connection string.
3. Set **`CRED_ENCRYPTION_KEY`** in Project Settings → Environment Variables (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Required once a database is attached — without it, saved login credentials / email configs become undecryptable after any restart.
4. Optionally set `DEEPSEEK_API_KEY` and `VITE_API_BASE` (defaults to same-origin `/api`, which the rewrites already handle).
5. Deploy.

Known limits on Vercel specifically: **assisted mode** (a visible browser window for solving a CAPTCHA) can't work there — no display on a server. Headless/stealth replay and all deterministic adapters are unaffected.

## Notes

- `backend/data/` (local JSON fallback) and `.env` are gitignored — they hold local dev data and secrets. Once `POSTGRES_URL` is set, all storage (recordings, automations, runs, accounts, sessions, API keys, credentials, marketplace listings, transactions, email configs) moves to Postgres automatically — no code changes needed either way.
- Billing is dev-bypassed by default (`BILLING_ENABLED=false`): plan changes apply instantly, nothing is charged.
