# Waypoint — deploy files

This folder is the whole Waypoint app, ready to deploy to Vercel.

- `index.html` — the app (updated: return legs in live fares, OTA price
  comparison with round-trip ticket check, auto-refresh).
- `api/search.js` — live fares from Google Flights via SerpApi.
  Needs the `SERPAPI_API_KEY` environment variable set in Vercel.
- `api/ota.js` — cheapest-price comparison across Trip.com, Traveloka,
  Agoda and other sites via PriceWin. No key needed.

## How to update your existing Vercel project (manual deploy)

1. Install Node.js from https://nodejs.org (LTS), then in a terminal run:
   `npm i -g vercel`
2. Unzip this folder, open a terminal inside it, and run:
   `vercel --prod`
   Sign in when it asks, and choose your existing waypoint project.
3. In Vercel (Project Settings -> Environment Variables), set
   `SERPAPI_API_KEY` to your SerpApi key, then redeploy once so it takes
   effect. The OTA comparison needs no key.

If your project is connected to GitHub instead, replace these files in
that repo (index.html at the root, api/search.js, api/ota.js), commit and
push — Vercel redeploys automatically.
