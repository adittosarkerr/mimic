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

| Service | How it runs |
| --- | --- |
| Booking.com hotels, Booking.com flights, GoZayaan flights | Deterministic — builds the site's own results URL from your inputs |
| Everything else (Booking cars/attractions/taxis, GoZayaan hotels/tours/visa, other sites) | Recorded-step replay — best via **run in my browser** |

## Notes

- `backend/data/` (recordings, automations, runs) and `.env` are gitignored — they hold local user data and secrets.
- Billing is dev-bypassed by default (`BILLING_ENABLED=false`): plan changes apply instantly, nothing is charged.
